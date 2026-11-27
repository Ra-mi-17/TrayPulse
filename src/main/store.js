'use strict';
// Minimal JSON settings store (no dependency). Saved in the per-user app data folder.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// Bump when a migration is added below.
const SETTINGS_VERSION = 2;

const DEFAULTS = {
  settingsVersion: SETTINGS_VERSION,
  language: 'auto', // 'auto' | 'ja' | 'en'
  theme: 'system', // 'system' | 'light' | 'dark'
  accentColor: '', // '' = theme default, otherwise '#rrggbb'
  launchAtLogin: false,
  autoUpdate: true,
  pollIntervalSec: 60,
  powerSaving: false, // true = only read cached BLE values (never wakes devices)
  // Where batteries are shown. 'taskbar' = embedded right-aligned in the Windows taskbar.
  displayMode: process.platform === 'win32' ? 'taskbar' : 'tray', // 'taskbar' | 'tray' | 'both'
  taskbarShowNames: true,
  taskbarShowDisconnected: false, // also applies to the tray tooltip / menu
  taskbarShowMic: true,
  taskbarTextColor: 'background', // background | theme | white | black
  taskbarTextOutline: 'off', // off | thin | thick
  taskbarShowAudio: true, // button that opens the Audio tab
  trayDisplay: 'lowest', // 'lowest' | 'icon' | <deviceId>
  showMicTray: true,
  notifyLow: true,
  notifyFull: true,
  defaultLowThreshold: 20,
  fullThreshold: 100,
  hotkeys: {
    micMute: 'CommandOrControl+Alt+M',
    screenshotRegion: 'CommandOrControl+Alt+S',
    screenshotFull: 'CommandOrControl+Alt+F',
  },
  screenshotDir: '', // '' = Pictures/TrayPulse
  screenshotCopyToClipboard: true,
  providers: {}, // { [providerId]: { enabled: boolean } }
  devices: {}, // { [deviceId]: { alias, hidden, order, lowThreshold, notifyFull, ownTray } }
  known: {}, // { [deviceId]: { name, kind, provider, level, components, lastSeen } }
};

function deepMerge(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const k of Object.keys(extra || {})) {
    out[k] = k in base ? deepMerge(base[k], extra[k]) : extra[k];
  }
  return out;
}

// Older versions saved every default value, so a changed default needs an explicit migration.
function migrate(raw) {
  const v = Number(raw.settingsVersion) || 1;
  if (v < 2) {
    // v0.2.0: disconnected devices are hidden from the taskbar / tray by default.
    raw.taskbarShowDisconnected = false;
  }
  raw.settingsVersion = SETTINGS_VERSION;
  return raw;
}

class Store extends EventEmitter {
  constructor(dir) {
    super();
    this.file = path.join(dir, 'settings.json');
    this.data = deepMerge(DEFAULTS, {});
    try {
      // Tolerate a BOM in case the file was hand-edited with a tool that adds one.
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^﻿/, ''));
      this.data = deepMerge(DEFAULTS, migrate(raw));
    } catch {
      /* first run */
    }
    this._timer = null;
  }

  get(key) {
    return key ? this.data[key] : this.data;
  }

  // Shallow-merge a patch into settings (objects one level deep are merged).
  set(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof this.data[k] === 'object') {
        this.data[k] = { ...this.data[k], ...v };
      } else {
        this.data[k] = v;
      }
    }
    this.save();
    this.emit('change', patch);
  }

  setDevice(id, patch) {
    this.data.devices[id] = { ...(this.data.devices[id] || {}), ...patch };
    this.save();
    this.emit('change', { devices: true });
  }

  // Debounced write.
  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this._timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[store] save failed', e);
    }
  }
}

module.exports = { Store, DEFAULTS };
