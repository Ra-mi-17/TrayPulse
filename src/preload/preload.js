'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('tp', {
  getState: () => invoke('state:get'),
  refresh: () => invoke('devices:refresh'),
  updateDevice: (id, patch) => invoke('device:update', id, patch),
  forgetDevice: (id) => invoke('device:forget', id),
  chooseDeviceIcon: (id) => invoke('device:chooseIcon', id),
  reorderDevices: (ids) => invoke('devices:reorder', ids),
  setSettings: (patch) => invoke('settings:set', patch),

  audioDevices: () => invoke('audio:devices'),
  setDefaultAudio: (id, flow) => invoke('audio:setDefault', id, flow),
  setVolume: (flow, v) => invoke('audio:setVolume', flow, v),
  setMute: (flow, mode) => invoke('audio:setMute', flow, mode),
  sessions: () => invoke('audio:sessions'),
  setSessionVolume: (key, v) => invoke('audio:setSessionVolume', key, v),
  setSessionMute: (key, m) => invoke('audio:setSessionMute', key, m),

  screenshot: (mode) => invoke('screenshot', mode),
  quit: () => invoke('app:quit'),
  hide: () => invoke('app:hide'),
  openPlugins: () => invoke('app:openPlugins'),
  openLogs: () => invoke('app:openLogs'),
  openScreenshotDir: () => invoke('app:openScreenshotDir'),
  chooseScreenshotDir: () => invoke('app:chooseScreenshotDir'),
  checkUpdates: () => invoke('app:checkUpdates'),
  suspendHotkeys: (on) => invoke('hotkeys:suspend', on),
  reportTab: (tab) => ipcRenderer.send('popup:tab', tab),
  openSoundSettings: () => invoke('app:openSoundSettings'),

  on: (channel, fn) => {
    const allowed = ['state:update', 'mic:update', 'popup:shown'];
    if (!allowed.includes(channel)) return () => {};
    const h = (_e, data) => fn(data);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
