'use strict';
// macOS audio.
//  - Volume / mute: AppleScript (`osascript`), always available.
//  - Output / input switching: requires `SwitchAudioSource` (brew install switchaudio-osx).
//  - Per-app volume: not possible on macOS without a virtual audio driver → disabled.
// NOTE: written without access to a Mac – please verify and send a PR if something is off.
const fs = require('fs');
const { execText } = require('../providers/util');

const SAS_PATHS = ['/opt/homebrew/bin/SwitchAudioSource', '/usr/local/bin/SwitchAudioSource'];
const sas = SAS_PATHS.find((p) => fs.existsSync(p));

const osa = (script) => execText('/usr/bin/osascript', ['-e', script], 5000).then((s) => s.trim());

let lastInputVolume = 75; // restored when un-muting the mic

function parseJsonLines(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function getInputVolume() {
  return Number(await osa('input volume of (get volume settings)')) || 0;
}

module.exports = {
  capabilities: { outputSwitch: !!sas, inputSwitch: !!sas, micMute: true, outputVolume: true, mixer: false, needsSwitchAudioSource: !sas },
  warmUp: async () => {},

  async listDevices(flow) {
    if (!sas) return [];
    const type = flow === 'input' ? 'input' : 'output';
    const [all, cur] = await Promise.all([
      execText(sas, ['-a', '-t', type, '-f', 'json']),
      execText(sas, ['-c', '-t', type, '-f', 'json']),
    ]);
    const current = parseJsonLines(cur)[0];
    return parseJsonLines(all).map((d) => ({
      id: d.name, // switch by name for compatibility with older SwitchAudioSource versions
      name: d.name,
      isDefault: current ? current.name === d.name : false,
      type,
    }));
  },

  async setDefault(id, flow) {
    if (!sas) throw new Error('SwitchAudioSource not installed');
    const types = flow ? [flow] : ['output', 'input'];
    // We don't know which flow a name belongs to when flow is omitted; try both quietly.
    for (const t of types) {
      try {
        await execText(sas, ['-s', id, '-t', t]);
      } catch {
        /* ignore */
      }
    }
  },

  async getEndpoint(flow) {
    if (flow === 'input') {
      const v = await getInputVolume();
      return { available: true, name: '', volume: v / 100, muted: v === 0 };
    }
    const [v, m] = await Promise.all([osa('output volume of (get volume settings)'), osa('output muted of (get volume settings)')]);
    return { available: v !== 'missing value', name: '', volume: (Number(v) || 0) / 100, muted: m === 'true' };
  },

  async setVolume(flow, volume) {
    const n = Math.round(Math.max(0, Math.min(1, volume)) * 100);
    await osa(`set volume ${flow === 'input' ? 'input' : 'output'} volume ${n}`);
  },

  async setMute(flow, mode) {
    if (flow === 'input') {
      const cur = await getInputVolume();
      const muted = cur === 0;
      const next = mode === 'toggle' ? !muted : !!mode;
      if (next && !muted) {
        lastInputVolume = cur;
        await osa('set volume input volume 0');
      } else if (!next && muted) {
        await osa(`set volume input volume ${lastInputVolume || 75}`);
      }
      return next;
    }
    const muted = (await osa('output muted of (get volume settings)')) === 'true';
    const next = mode === 'toggle' ? !muted : !!mode;
    await osa(`set volume output muted ${next}`);
    return next;
  },

  listSessions: async () => [],
  setSessionVolume: async () => {},
  setSessionMute: async () => {},
};
