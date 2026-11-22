'use strict';
// Manages the main tray icon, the optional microphone tray icon and optional per-device tray icons.
const { Tray, Menu, nativeImage, nativeTheme } = require('electron');
const icons = require('./graphics/icons');

const isMac = process.platform === 'darwin';

function darkTaskbar() {
  if (process.platform === 'win32' && 'shouldUseDarkColorsForSystemIntegratedUI' in nativeTheme) {
    return nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
  }
  return nativeTheme.shouldUseDarkColors;
}

class TrayManager {
  /**
   * @param {object} o
   * @param {() => object} o.getI18n
   * @param {() => object} o.store
   * @param {(tray: Tray) => void} o.onClick       left click
   * @param {() => Menu} o.buildMenu               context menu factory
   * @param {() => void} o.onMicClick
   */
  constructor(o) {
    Object.assign(this, o);
    this.main = null;
    this.mic = null;
    this.deviceTrays = new Map(); // id -> { tray, sig }
    this.devices = [];
    this.micMuted = null;
    this.mainSig = '';
  }

  createMain() {
    this.main = new Tray(icons.appIcon(nativeImage, { dark: darkTaskbar(), platform: process.platform }));
    this.main.setToolTip('TrayPulse');
    this.wire(this.main);
    this.mainSig = '';
  }

  // Show / hide the battery tray icons (main + per-device). The mic icon is controlled by setMic().
  setEnabled(on) {
    if (on && !this.main) {
      this.createMain();
      this.update();
    } else if (!on && this.main) {
      this.main.destroy();
      this.main = null;
      for (const e of this.deviceTrays.values()) e.tray.destroy();
      this.deviceTrays.clear();
    }
  }

  wire(tray, onClick) {
    tray.on('click', () => (onClick ? onClick(tray) : this.onClick(tray)));
    tray.on('right-click', () => tray.popUpContextMenu(this.buildMenu()));
    if (isMac) tray.setIgnoreDoubleClickEvents(true);
  }

  t(k, v) {
    return this.getI18n().t(k, v);
  }

  levelText(d) {
    const lvl = d.effectiveLevel ?? d.level;
    if (lvl == null) return '--';
    return `${lvl}%`;
  }

  tooltipFor(list) {
    if (!list.length) return `TrayPulse\n${this.t('tray.noDevices')}`;
    const lines = list.map((d) => {
      let s = `${d.displayName}: ${this.levelText(d)}`;
      if (d.components?.length) s += ` (${d.components.map((c) => `${this.t('part.' + c.key)} ${c.level}%`).join(' / ')})`;
      if (d.connected === false) s += ` – ${this.t('device.disconnected')}`;
      return s;
    });
    let tip = lines.join('\n');
    // Windows limits tooltips to 127 characters.
    if (!isMac && tip.length > 127) tip = tip.slice(0, 124) + '...';
    return tip;
  }

  pickMainDevice(visible) {
    const mode = this.store().get('trayDisplay');
    if (mode === 'icon') return null;
    if (mode !== 'lowest') return visible.find((d) => d.id === mode) || null;
    const candidates = visible.filter((d) => d.connected !== false && d.effectiveLevel != null);
    if (!candidates.length) return null;
    return candidates.reduce((a, b) => (b.effectiveLevel < a.effectiveLevel ? b : a));
  }

  update(devices) {
    if (devices) this.devices = devices;
    if (!this.main) return; // tray hidden (taskbar widget mode)
    const showDisconnected = this.store().get('taskbarShowDisconnected');
    const visible = this.devices.filter((d) => !d.hidden && (showDisconnected || d.connected !== false || d.ownTray));
    const dark = darkTaskbar();

    // --- main tray
    const target = this.pickMainDevice(visible);
    const sig = JSON.stringify([target?.id, target?.effectiveLevel, target?.lowThreshold, dark]);
    if (sig !== this.mainSig) {
      this.mainSig = sig;
      this.main.setImage(
        target
          ? icons.batteryIcon(nativeImage, { level: target.effectiveLevel, low: target.lowThreshold, dark, platform: process.platform })
          : icons.appIcon(nativeImage, { dark, platform: process.platform })
      );
      if (isMac) this.main.setTitle(target ? this.levelText(target) : '');
    }
    this.main.setToolTip(this.tooltipFor(visible));

    // --- per-device trays
    const wanted = new Set(visible.filter((d) => d.ownTray && d.id !== target?.id).map((d) => d.id));
    for (const [id, entry] of this.deviceTrays) {
      if (!wanted.has(id)) {
        entry.tray.destroy();
        this.deviceTrays.delete(id);
      }
    }
    for (const d of visible) {
      if (!wanted.has(d.id)) continue;
      let entry = this.deviceTrays.get(d.id);
      if (!entry) {
        entry = { tray: new Tray(icons.appIcon(nativeImage, { dark, platform: process.platform })), sig: '' };
        this.wire(entry.tray);
        this.deviceTrays.set(d.id, entry);
      }
      const dsig = JSON.stringify([d.effectiveLevel, d.lowThreshold, dark, d.connected]);
      if (dsig !== entry.sig) {
        entry.sig = dsig;
        entry.tray.setImage(icons.batteryIcon(nativeImage, { level: d.effectiveLevel, low: d.lowThreshold, dark, platform: process.platform }));
        if (isMac) entry.tray.setTitle(this.levelText(d));
      }
      entry.tray.setToolTip(this.tooltipFor([d]));
    }
  }

  setMic(enabled, muted) {
    if (!enabled) {
      this.mic?.destroy();
      this.mic = null;
      this.micMuted = null;
      return;
    }
    if (!this.mic) {
      this.mic = new Tray(icons.micIcon(nativeImage, { muted: !!muted, dark: darkTaskbar(), platform: process.platform }));
      this.wire(this.mic, () => this.onMicClick());
      this.micMuted = null;
    }
    if (muted !== this.micMuted || this._micDark !== darkTaskbar()) {
      this.micMuted = muted;
      this._micDark = darkTaskbar();
      this.mic.setImage(icons.micIcon(nativeImage, { muted: !!muted, dark: darkTaskbar(), platform: process.platform }));
      this.mic.setToolTip(muted ? this.t('mic.tooltipMuted') : this.t('mic.tooltipLive'));
    }
  }

  redrawAll() {
    this.mainSig = '';
    for (const e of this.deviceTrays.values()) e.sig = '';
    this._micDark = null;
    this.update();
    if (this.mic) this.setMic(true, this.micMuted);
  }

  destroy() {
    this.main?.destroy();
    this.mic?.destroy();
    for (const e of this.deviceTrays.values()) e.tray.destroy();
    this.deviceTrays.clear();
  }
}

module.exports = { TrayManager, darkTaskbar };
