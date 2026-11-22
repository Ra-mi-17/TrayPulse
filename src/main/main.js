'use strict';
const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  nativeTheme,
  Notification,
  globalShortcut,
  screen,
  shell,
  dialog,
  powerMonitor,
} = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./store');
const { createI18n } = require('./i18n');
const { loadProviders } = require('./providers');
const { DeviceManager } = require('./devices');
const { TrayManager, darkTaskbar } = require('./trays');
const { TaskbarWidget } = require('./taskbarWidget');
const audio = require('./audio');
const screenshot = require('./screenshot');
const winHelper = require('./platform/winHelper');

const isMac = process.platform === 'darwin';
const isDev = process.argv.includes('--dev');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let store, i18n, devices, trays, popup, widget;
let widgetStatus = null; // null = OK / not used, otherwise failure reason
let lastHiddenAt = 0;
let micMuted = null;
let micTimer = null;
const iconCache = new Map();

// ------------------------------------------------------------------ logging
let logFile;
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  console.log(line);
  try {
    if (!logFile) {
      const dir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      logFile = path.join(dir, 'traypulse.log');
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, logFile + '.old');
    }
    fs.appendFileSync(logFile, line + '\n');
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ popup window
function themeBackground() {
  return nativeTheme.shouldUseDarkColors ? '#1f2024' : '#f6f7f9';
}

function createPopup() {
  popup = new BrowserWindow({
    width: 380,
    height: 580,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: themeBackground(),
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  popup.setMenu(null);
  popup.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  popup.on('blur', () => {
    if (isDev && process.argv.includes('--keep-open')) return;
    if (popup.webContents.isDevToolsOpened()) return;
    popup.hide();
    lastHiddenAt = Date.now();
  });
  popup.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function positionPopup(trayBounds) {
  const [w, h] = popup.getSize();
  const anchor = trayBounds && trayBounds.width ? trayBounds : { ...screen.getCursorScreenPoint(), width: 0, height: 0 };
  const display = screen.getDisplayNearestPoint({ x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 });
  const wa = display.workArea;
  const margin = 8;
  let x = Math.round(anchor.x + anchor.width / 2 - w / 2);
  x = Math.max(wa.x + margin, Math.min(x, wa.x + wa.width - w - margin));
  let y;
  if (isMac) y = Math.round(anchor.y + anchor.height + 4);
  else if (anchor.y + anchor.height / 2 > wa.y + wa.height / 2) y = wa.y + wa.height - h - margin; // taskbar at bottom
  else y = wa.y + margin; // taskbar at top
  if (!isMac && anchor.x + anchor.width / 2 < wa.x) x = wa.x + margin; // taskbar left
  if (!isMac && anchor.x > wa.x + wa.width) x = wa.x + wa.width - w - margin; // taskbar right
  popup.setPosition(x, y, false);
}

function togglePopup(bounds) {
  if (popup.isVisible()) {
    popup.hide();
    return;
  }
  // The blur caused by clicking the tray icon already hid the window: treat as toggle-off.
  if (Date.now() - lastHiddenAt < 250) return;
  showPopup(bounds);
}

// Taskbar audio button: open the popup on the Audio tab, or close it if that's already showing.
let popupTab = 'devices';
function toggleAudioPanel(bounds) {
  if (popup.isVisible() && popupTab === 'audio') {
    popup.hide();
    return;
  }
  if (!popup.isVisible() && Date.now() - lastHiddenAt < 250) return;
  showPopup(bounds, 'audio');
}

function defaultAnchor() {
  if (widgetActive()) return widget.bounds();
  return trays.main ? trays.main.getBounds() : null;
}

function showPopup(bounds, tab) {
  positionPopup(bounds || defaultAnchor());
  popup.show();
  popup.focus();
  popup.webContents.send('popup:shown', { tab });
  devices.poll().catch(() => {});
}

// ------------------------------------------------------------------ notifications
function notify(type, device, extra) {
  if (!Notification.isSupported()) return;
  const name = device.displayName;
  const n =
    type === 'low'
      ? new Notification({ title: i18n.t('notify.lowTitle', { name }), body: i18n.t('notify.lowBody', { name, level: extra.level }) })
      : new Notification({ title: i18n.t('notify.fullTitle', { name }), body: i18n.t('notify.fullBody', { name, level: extra.level }) });
  n.on('click', () => showPopup());
  n.show();
  log('notify', type, name, extra.level);
}

// ------------------------------------------------------------------ microphone
async function refreshMic() {
  if (!audio.capabilities.micMute) return;
  try {
    const ep = await audio.getEndpoint('input');
    setMicState(ep.available ? ep.muted : null);
  } catch (e) {
    log('mic refresh failed', e.message);
  }
}

function setMicState(muted) {
  const changed = muted !== micMuted;
  micMuted = muted;
  trays.setMic(store.get('showMicTray') && trayVisible() && audio.capabilities.micMute && muted !== null, muted);
  if (changed) {
    popup?.webContents.send('mic:update', { muted });
    widget?.update();
  }
}

async function toggleMic() {
  try {
    const muted = await audio.setMute('input', 'toggle');
    setMicState(muted);
    if (Notification.isSupported() && !popup.isVisible()) {
      new Notification({ title: muted ? i18n.t('mic.mutedToast') : i18n.t('mic.liveToast'), silent: true }).show();
    }
    return muted;
  } catch (e) {
    log('mic toggle failed', e.message);
    throw e;
  }
}

function startMicPolling() {
  clearInterval(micTimer);
  if (!audio.capabilities.micMute) return;
  refreshMic();
  // Keeps the mic tray in sync when the mute state changes elsewhere (Settings, headset button…).
  micTimer = setInterval(refreshMic, store.get('showMicTray') ? 3000 : 15000);
}

// ------------------------------------------------------------------ screenshots
async function takeScreenshot(mode) {
  const wasVisible = popup.isVisible();
  if (wasVisible) popup.hide();
  await new Promise((r) => setTimeout(r, wasVisible ? 250 : 0));
  try {
    const file = mode === 'full' ? await screenshot.full(store) : await screenshot.region(store);
    if (file && Notification.isSupported()) {
      const n = new Notification({ title: i18n.t('shot.savedTitle'), body: file });
      n.on('click', () => shell.showItemInFolder(file));
      n.show();
    }
    return file;
  } catch (e) {
    log('screenshot failed', e.message);
    dialog.showErrorBox('TrayPulse', `${i18n.t('shot.failed')}\n${e.message}`);
    return null;
  }
}

// ------------------------------------------------------------------ hotkeys
const hotkeyStatus = {};
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const hk = store.get('hotkeys');
  const actions = {
    micMute: () => toggleMic().catch(() => {}),
    screenshotRegion: () => takeScreenshot('region'),
    screenshotFull: () => takeScreenshot('full'),
  };
  for (const [name, fn] of Object.entries(actions)) {
    const acc = hk[name];
    if (!acc) {
      hotkeyStatus[name] = 'none';
      continue;
    }
    try {
      hotkeyStatus[name] = globalShortcut.register(acc, fn) ? 'ok' : 'conflict';
    } catch {
      hotkeyStatus[name] = 'invalid';
    }
  }
}

// ------------------------------------------------------------------ app settings side effects
function applyLoginItem() {
  const openAtLogin = !!store.get('launchAtLogin');
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin, openAsHidden: true });
  } else if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin, path: process.execPath, args: [app.getAppPath()] });
  }
}

function applyTheme() {
  nativeTheme.themeSource = store.get('theme');
}

function setupUpdater() {
  if (!app.isPackaged || !store.get('autoUpdate')) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.logger = { info: (m) => log('[updater]', m), warn: (m) => log('[updater]', m), error: (m) => log('[updater]', m) };
    const check = () => autoUpdater.checkForUpdatesAndNotify().catch((e) => log('update check failed', e.message));
    check();
    setInterval(check, 6 * 60 * 60 * 1000);
  } catch (e) {
    log('updater unavailable', e.message);
  }
}

async function checkForUpdatesNow() {
  if (!app.isPackaged) return { status: 'dev' };
  try {
    const { autoUpdater } = require('electron-updater');
    const r = await autoUpdater.checkForUpdates();
    const latest = r?.updateInfo?.version;
    return { status: latest && latest !== app.getVersion() ? 'available' : 'latest', version: latest };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

// ------------------------------------------------------------------ context menu
function buildMenu() {
  const t = i18n.t;
  const list = devices.list().filter((d) => !d.hidden && (d.connected !== false || store.get('taskbarShowDisconnected')));
  const deviceItems = list.length
    ? list.map((d) => ({
        label: `${d.displayName}  ${d.effectiveLevel == null ? '--' : d.effectiveLevel + '%'}${d.connected === false ? ` (${t('device.disconnected')})` : ''}`,
        enabled: false,
      }))
    : [{ label: t('tray.noDevices'), enabled: false }];
  const items = [
    ...deviceItems,
    { type: 'separator' },
    { label: t('menu.open'), click: () => showPopup() },
    { label: t('menu.refresh'), click: () => devices.poll() },
  ];
  if (audio.capabilities.micMute) {
    items.push({ label: micMuted ? t('menu.unmuteMic') : t('menu.muteMic'), click: () => toggleMic().catch(() => {}) });
  }
  items.push(
    { type: 'separator' },
    { label: t('menu.shotRegion'), click: () => takeScreenshot('region') },
    { label: t('menu.shotFull'), click: () => takeScreenshot('full') },
    { type: 'separator' },
    { label: t('menu.settings'), click: () => showPopup(null, 'settings') },
    { label: t('menu.quit'), click: () => app.quit() }
  );
  return Menu.buildFromTemplate(items);
}

// ------------------------------------------------------------------ IPC
function state() {
  return {
    platform: process.platform,
    version: app.getVersion(),
    devices: devices.list(),
    lastPoll: devices.lastPoll,
    settings: store.get(),
    capabilities: audio.capabilities,
    providers: devices.providers.map((p) => ({
      id: p.id,
      name: p.name,
      plugin: !!p.plugin,
      enabled: devices.providerEnabled(p),
      error: devices.errors[p.id] || null,
    })),
    hotkeyStatus,
    widgetStatus,
    taskbarSupported: process.platform === 'win32',
    lang: i18n.lang,
    dict: i18n.dict,
    dark: nativeTheme.shouldUseDarkColors,
    micMuted,
  };
}

async function sessionIcon(p) {
  if (!p) return null;
  if (iconCache.has(p)) return iconCache.get(p);
  let url = null;
  try {
    url = (await app.getFileIcon(p, { size: 'normal' })).toDataURL();
  } catch {
    /* ignore */
  }
  iconCache.set(p, url);
  return url;
}

function broadcastSettings() {
  popup?.webContents.send('state:update', state());
}

function registerIpc() {
  ipcMain.handle('state:get', () => state());
  ipcMain.handle('devices:refresh', async () => {
    await devices.poll();
    return state();
  });
  ipcMain.handle('device:update', (_e, id, patch) => {
    store.setDevice(id, patch);
    trays.update(devices.list());
    widget?.update();
    return state();
  });
  ipcMain.handle('device:forget', (_e, id) => {
    devices.forget(id);
    return state();
  });
  ipcMain.handle('devices:reorder', (_e, ids) => {
    devices.reorder(ids);
    return state();
  });

  ipcMain.handle('settings:set', (_e, patch) => {
    const prev = { ...store.get(), hotkeys: { ...store.get('hotkeys') } };
    if (patch.providers) patch.providers = { ...store.get('providers'), ...patch.providers };
    store.set(patch);
    if ('language' in patch && patch.language !== prev.language) {
      i18n = createI18n(store.get('language'));
      trays.update(devices.list());
    }
    if ('theme' in patch) applyTheme();
    if ('launchAtLogin' in patch) applyLoginItem();
    if ('pollIntervalSec' in patch || 'powerSaving' in patch || 'providers' in patch) devices.start();
    if ('hotkeys' in patch) registerHotkeys();
    if ('showMicTray' in patch) {
      startMicPolling();
      setMicState(micMuted);
    }
    if ('trayDisplay' in patch || 'defaultLowThreshold' in patch || 'taskbarShowDisconnected' in patch) trays.update(devices.list());
    if ('displayMode' in patch) {
      widgetStatus = null;
      applyDisplayMode();
    }
    if (Object.keys(patch).some((k) => k.startsWith('taskbar') || k === 'defaultLowThreshold')) widget?.update();
    return state();
  });

  ipcMain.handle('audio:devices', async () => {
    const caps = audio.capabilities;
    const [outputs, inputs, output, input] = await Promise.all([
      caps.outputSwitch ? audio.listDevices('output') : [],
      caps.inputSwitch ? audio.listDevices('input') : [],
      audio.getEndpoint('output'),
      audio.getEndpoint('input'),
    ]);
    setMicState(input.available ? input.muted : null);
    return { outputs, inputs, output, input };
  });
  ipcMain.handle('audio:setDefault', (_e, id, flow) => audio.setDefault(id, flow));
  ipcMain.handle('audio:setVolume', (_e, flow, v) => audio.setVolume(flow, v));
  ipcMain.handle('audio:setMute', async (_e, flow, mode) => {
    if (flow === 'input') return toggleMicTo(mode);
    return audio.setMute(flow, mode);
  });
  ipcMain.handle('audio:sessions', async () => {
    const list = await audio.listSessions();
    return Promise.all(list.map(async (s) => ({ ...s, icon: await sessionIcon(s.path) })));
  });
  ipcMain.handle('audio:setSessionVolume', (_e, key, v) => audio.setSessionVolume(key, v));
  ipcMain.handle('audio:setSessionMute', (_e, key, m) => audio.setSessionMute(key, m));

  // Taskbar widget
  const fromWidget = (e) => widget && widget.owns(e.sender);
  ipcMain.on('widget:width', (e, w) => fromWidget(e) && widget.setContentWidth(Number(w) || 0));
  ipcMain.on('widget:click', (e) => fromWidget(e) && togglePopup(widget.bounds()));
  ipcMain.on('widget:menu', (e) => fromWidget(e) && popupMenuAtCursor());
  ipcMain.on('widget:mic', (e) => fromWidget(e) && toggleMic().catch(() => {}));
  ipcMain.on('widget:audio', (e) => fromWidget(e) && toggleAudioPanel(widget.bounds()));
  ipcMain.on('popup:tab', (_e, tab) => {
    popupTab = String(tab);
  });
  ipcMain.handle('app:openSoundSettings', () =>
    shell.openExternal(isMac ? 'x-apple.systempreferences:com.apple.preference.sound' : 'ms-settings:sound')
  );

  ipcMain.handle('screenshot', (_e, mode) => takeScreenshot(mode));
  ipcMain.handle('app:quit', () => app.quit());
  ipcMain.handle('app:hide', () => popup.hide());
  ipcMain.handle('app:openPlugins', () => shell.openPath(pluginDir()));
  ipcMain.handle('app:openLogs', () => shell.openPath(path.join(app.getPath('userData'), 'logs')));
  ipcMain.handle('app:openScreenshotDir', () => shell.openPath(screenshot.outputDir(store)));
  ipcMain.handle('app:chooseScreenshotDir', async () => {
    const r = await dialog.showOpenDialog(popup, { properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return state();
    store.set({ screenshotDir: r.filePaths[0] });
    return state();
  });
  ipcMain.handle('app:checkUpdates', () => checkForUpdatesNow());
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('hotkeys:suspend', (_e, on) => {
    // While the user records a new shortcut, release global shortcuts so the keys reach the page.
    if (on) globalShortcut.unregisterAll();
    else registerHotkeys();
    return hotkeyStatus;
  });
}

async function toggleMicTo(mode) {
  const muted = await audio.setMute('input', mode);
  setMicState(muted);
  return muted;
}

// Context menus need an owner window that has focus (otherwise they don't open, or don't close on
// an outside click). The taskbar widget can't be that owner, so a tiny invisible window is used.
let menuHost = null;
function popupMenuAtCursor() {
  if (!menuHost || menuHost.isDestroyed()) {
    menuHost = new BrowserWindow({
      width: 1,
      height: 1,
      show: false,
      frame: false,
      transparent: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      resizable: false,
      focusable: true,
      webPreferences: { sandbox: true },
    });
  }
  const p = screen.getCursorScreenPoint();
  menuHost.setPosition(p.x, p.y);
  menuHost.show();
  menuHost.focus();
  buildMenu().popup({ window: menuHost, x: 0, y: 0, callback: () => menuHost && !menuHost.isDestroyed() && menuHost.hide() });
}
// ------------------------------------------------------------------ display mode (taskbar widget / tray)
function widgetActive() {
  return !!widget && widget.enabled && !widgetStatus;
}

// The tray is shown in tray/both mode, and as a fallback whenever the taskbar widget can't be shown.
function trayVisible() {
  return store.get('displayMode') !== 'taskbar' || !widgetActive();
}

function applyDisplayMode() {
  const mode = store.get('displayMode');
  if (widget) {
    if (mode === 'tray') widget.disable();
    else widget.enable();
  }
  trays.setEnabled(trayVisible());
  setMicState(micMuted);
  popup?.webContents.send('state:update', state());
}

function widgetData() {
  const list = devices
    .list()
    .filter((d) => !d.hidden && d.showOnTaskbar && (d.connected !== false || store.get('taskbarShowDisconnected')));
  const t = i18n.t;
  return {
    dark: darkTaskbar(),
    showNames: store.get('taskbarShowNames'),
    devices: list.map((d) => ({
      id: d.id,
      name: d.displayName,
      kind: d.kind,
      level: d.effectiveLevel ?? d.level,
      lowThreshold: d.lowThreshold,
      connected: d.connected,
      components: d.components,
    })),
    mic: { show: store.get('taskbarShowMic') && audio.capabilities.micMute && micMuted !== null, muted: !!micMuted },
    audio: { show: store.get('taskbarShowAudio') },
    text: {
      noDevices: t('tray.noDevices'),
      disconnected: t('device.disconnected'),
      micMuted: t('mic.tooltipMuted'),
      micLive: t('mic.tooltipLive'),
      audio: t('widget.audioTip'),
      parts: { left: t('part.left'), right: t('part.right'), case: t('part.case') },
    },
  };
}

function pluginDir() {
  return path.join(app.getPath('userData'), 'plugins');
}

// Dev aid: TRAYPULSE_CAPTURE=<dir> saves a PNG of each tab (for README screenshots / UI checks) and quits.
async function captureForDocs(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(dir, { recursive: true });
  lastHiddenAt = 0;
  showPopup();
  popup.removeAllListeners('blur');
  await wait(6000);
  for (const tab of ['devices', 'audio', 'settings']) {
    await popup.webContents.executeJavaScript(`document.querySelector('[data-tab="${tab}"]').click()`);
    await wait(tab === 'audio' ? 3000 : 800);
    const img = await popup.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `${tab}.png`), img.toPNG());
  }
  // Right half of the primary display's bottom edge (taskbar widget).
  popup.hide();
  await wait(800);
  const { desktopCapturer } = require('electron');
  const d = screen.getPrimaryDisplay();
  const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  if (src) {
    const h = Math.round(80 * d.scaleFactor);
    const shot = src.thumbnail.crop({ x: Math.round(size.width * 0.4), y: size.height - h, width: Math.round(size.width * 0.6), height: h });
    fs.writeFileSync(path.join(dir, 'taskbar.png'), shot.toPNG());
  }
  app.quit();
}

// ------------------------------------------------------------------ lifecycle
app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('io.github.traypulse');
  if (isMac) app.dock?.hide();

  store = new Store(app.getPath('userData'));
  i18n = createI18n(store.get('language'));
  applyTheme();
  applyLoginItem();

  const providers = loadProviders(pluginDir(), log);
  devices = new DeviceManager({ store, providers, notify, log });
  await devices.init();

  trays = new TrayManager({
    getI18n: () => i18n,
    store: () => store,
    onClick: (tray) => togglePopup(tray.getBounds()),
    onMicClick: () => toggleMic().catch(() => {}),
    buildMenu,
  });
  if (process.platform === 'win32') {
    widget = new TaskbarWidget({
      getData: widgetData,
      log,
      onStatus: (reason) => {
        if (reason) log('taskbar widget unavailable:', reason);
        widgetStatus = reason;
        trays.setEnabled(trayVisible());
        setMicState(micMuted);
        popup?.webContents.send('state:update', state());
      },
    });
  }
  createPopup();
  registerIpc();
  registerHotkeys();

  applyDisplayMode();

  devices.on('update', (list) => {
    trays.update(list);
    widget?.update();
    popup?.webContents.send('state:update', state());
  });
  devices.start();

  audio.warmUp().catch((e) => log('audio warm-up failed', e.message));
  startMicPolling();
  setupUpdater();

  nativeTheme.on('updated', () => {
    trays.redrawAll();
    widget?.update();
    popup?.setBackgroundColor(themeBackground());
    broadcastSettings();
  });
  powerMonitor.on('resume', () => setTimeout(() => devices.poll(), 5000));

  if (isDev) showPopup();
  if (process.env.TRAYPULSE_CAPTURE) captureForDocs(process.env.TRAYPULSE_CAPTURE);
  log('started', app.getVersion(), process.platform, `providers=${providers.map((p) => p.id).join(',')}`);
});

app.on('second-instance', () => showPopup());
app.on('before-quit', () => widget?.disable()); // don't recreate the widget while quitting
app.on('window-all-closed', (e) => e.preventDefault()); // tray app: keep running
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  devices?.dispose();
  widget?.disable();
  trays?.destroy();
  store?.flush();
  winHelper.stopAll();
});
