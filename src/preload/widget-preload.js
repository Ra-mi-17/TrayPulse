'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widget', {
  onData: (fn) => ipcRenderer.on('widget:data', (_e, d) => fn(d)),
  onHit: (fn) => ipcRenderer.on('widget:hit', (_e, h) => fn(h)),
  reportWidth: (w) => ipcRenderer.send('widget:width', w),
  click: () => ipcRenderer.send('widget:click'),
  menu: () => ipcRenderer.send('widget:menu'),
  micClick: () => ipcRenderer.send('widget:mic'),
  audioClick: () => ipcRenderer.send('widget:audio'),
});
