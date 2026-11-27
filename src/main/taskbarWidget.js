'use strict';
// Windows: a small transparent window embedded in the taskbar, right-aligned next to the notification area.
// Windows 11 removed DeskBands, so the window is re-parented into Shell_TrayWnd by the native helper.
const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { audioHelper } = require('./platform/winHelper');

const GAP_CSS = 6; // space between the widget and the tray area (CSS px)
const REPOSITION_MS = 2000;

class TaskbarWidget {
  /**
   * @param {object} o
   * @param {() => object} o.getData   data pushed to the widget renderer
   * @param {(bounds) => void} o.onClick
   * @param {() => Electron.Menu} o.buildMenu
   * @param {() => void} o.onMicClick
   * @param {(reason: string|null) => void} o.onStatus  called with null when OK, or a failure reason
   * @param {(...a) => void} o.log
   * @param {() => boolean} o.wantsBackground  true when the text colour follows the real background
   */
  constructor(o) {
    Object.assign(this, o);
    this.win = null;
    this.cssWidth = 0;
    this.dpi = Math.round(96 * screen.getPrimaryDisplay().scaleFactor);
    this.timer = null;
    this.enabled = false;
    this.status = null;
    this.recreateTimer = null;
    this.bgDark = null; // brightness of what's behind the widget (null = unknown)
    this.onHelperEvent = (ev) => this.handleInput(ev);
  }

  // Clicks come from the native mouse hook (see TaskbarInput in TrayPulseNative.cs) because Chromium
  // doesn't receive mouse input once its window is a child of the taskbar.
  handleInput(ev) {
    if (ev.event !== 'widget-click' || !this.win || this.win.isDestroyed()) return;
    const scale = this.dpi / 96;
    this.win.webContents.send('widget:hit', { button: ev.button, x: ev.x / scale, y: ev.y / scale });
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    audioHelper().on('event', this.onHelperEvent);
    this.create();
    this.timer = setInterval(() => this.place(), REPOSITION_MS);
  }

  disable() {
    this.enabled = false;
    clearInterval(this.timer);
    clearTimeout(this.recreateTimer);
    this.timer = null;
    audioHelper().off('event', this.onHelperEvent);
    audioHelper().call('taskbar.watchInput', { hwnd: '0' }).catch(() => {});
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  create() {
    this.win = new BrowserWindow({
      width: 120,
      height: 40,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'widget-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    this.win.setMenu(null);
    this.win.loadFile(path.join(__dirname, '..', 'widget', 'widget.html'));
    this.win.webContents.on('did-finish-load', () => {
      this.update();
      this.place(true);
    });
    // If Explorer restarts, the taskbar (our parent) is destroyed and takes this window with it.
    this.win.on('closed', () => {
      this.win = null;
      if (this.enabled) {
        this.log('taskbar widget closed; recreating');
        clearTimeout(this.recreateTimer);
        this.recreateTimer = setTimeout(() => this.enabled && !this.win && this.create(), 3000);
      }
    });
  }

  hwnd() {
    return this.win.getNativeWindowHandle().readBigUInt64LE(0).toString();
  }

  async place(first) {
    if (!this.win || this.win.isDestroyed() || !this.cssWidth) return;
    const width = Math.ceil((this.cssWidth * this.dpi) / 96);
    try {
      if (first) this.win.showInactive();
      const r = await audioHelper().call('taskbar.place', { hwnd: this.hwnd(), width, gap: Math.round((GAP_CSS * this.dpi) / 96) }, 10000);
      if (!r.ok) return this.setStatus(r.reason);
      // Re-sent every time so the hook follows a re-created window or a restarted helper.
      await audioHelper().call('taskbar.watchInput', { hwnd: this.hwnd() }, 10000);
      if (r.dpi && r.dpi !== this.dpi) {
        this.dpi = r.dpi;
        return this.place();
      }
      this.setStatus(null);
      if (this.wantsBackground?.()) await this.sampleBackground();
    } catch (e) {
      this.log('taskbar place failed', e.message);
      this.setStatus('error');
    }
  }

  // Decide whether the background is dark, with hysteresis so a mid-grey wallpaper doesn't flicker.
  async sampleBackground() {
    const r = await audioHelper().call('taskbar.sampleBackground', {}, 5000);
    if (!r.ok || !(r.luma >= 0)) return;
    let dark = this.bgDark;
    if (dark === null) dark = r.luma < 128;
    else if (dark && r.luma > 146) dark = false;
    else if (!dark && r.luma < 110) dark = true;
    if (dark !== this.bgDark) {
      this.log('taskbar background', r.luma, dark ? 'dark' : 'light');
      this.bgDark = dark;
      this.update();
    }
  }

  setStatus(reason) {
    if (reason === this.status) return;
    this.status = reason;
    if (reason && this.win && !this.win.isDestroyed()) this.win.hide();
    this.onStatus(reason);
  }

  // Push fresh data to the renderer.
  update() {
    if (!this.win || this.win.isDestroyed() || this.win.webContents.isLoading()) return;
    this.win.webContents.send('widget:data', { ...this.getData(), bgDark: this.bgDark });
  }

  // Renderer reports its content width (CSS px).
  setContentWidth(w) {
    if (!(w >= 2)) return; // ignore the empty first layout
    const next = Math.ceil(w);
    if (next === this.cssWidth) return;
    this.cssWidth = next;
    this.place(!this.win?.isVisible());
  }

  bounds() {
    return this.win && !this.win.isDestroyed() ? this.win.getBounds() : null;
  }

  owns(webContents) {
    return !!this.win && !this.win.isDestroyed() && this.win.webContents === webContents;
  }
}

module.exports = { TaskbarWidget };
