'use strict';
// Spawns and talks to the Windows PowerShell helper (src/main/native/win/helper.ps1).
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

function scriptPath() {
  // When packaged, native files are unpacked from the asar archive.
  return path.join(__dirname, '..', 'native', 'win', 'helper.ps1').replace('app.asar', 'app.asar.unpacked');
}

class WinHelper {
  constructor(name) {
    this.name = name;
    this.proc = null;
    this.seq = 1;
    this.pending = new Map();
    this.ready = null;
    this.closed = false;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      this.proc = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath()], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc.stdout.setEncoding('utf8');
      const rl = readline.createInterface({ input: this.proc.stdout });
      let started = false;
      rl.on('line', (line) => {
        let msg;
        try {
          msg = JSON.parse(line.replace(/^\uFEFF/, ''));
        } catch {
          return;
        }
        if (msg.id === 0 && !started) {
          started = true;
          resolve();
          return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
      });
      this.proc.stderr.setEncoding('utf8');
      this.proc.stderr.on('data', (d) => console.error(`[helper:${this.name}]`, d.trim()));
      this.proc.on('error', (e) => {
        if (!started) reject(e);
      });
      this.proc.on('exit', (code) => {
        if (!started) reject(new Error(`helper exited (${code})`));
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('helper exited'));
        }
        this.pending.clear();
        this.proc = null;
        this.ready = null; // restart lazily on next call
      });
    });
    return this.ready;
  }

  async call(cmd, args = {}, timeoutMs = 30000) {
    if (this.closed) throw new Error('helper closed');
    await this.start();
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`helper timeout: ${cmd}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
    });
  }

  stop() {
    this.closed = true;
    if (this.proc) {
      try {
        this.proc.stdin.end();
        this.proc.kill();
      } catch {
        /* ignore */
      }
    }
  }
}

// Two processes so that a slow Bluetooth scan never blocks the volume sliders.
let battery, audio;
module.exports = {
  batteryHelper: () => (battery ||= new WinHelper('battery')),
  audioHelper: () => (audio ||= new WinHelper('audio')),
  stopAll: () => {
    battery?.stop();
    audio?.stop();
  },
};
