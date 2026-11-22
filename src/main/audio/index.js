'use strict';
// Platform audio backend. All backends expose the same API (see win.js).
const unsupported = {
  capabilities: { outputSwitch: false, inputSwitch: false, micMute: false, outputVolume: false, mixer: false },
  warmUp: async () => {},
  listDevices: async () => [],
  setDefault: async () => {},
  getEndpoint: async () => ({ available: false, name: '', volume: 0, muted: false }),
  setVolume: async () => {},
  setMute: async () => false,
  listSessions: async () => [],
  setSessionVolume: async () => {},
  setSessionMute: async () => {},
};

module.exports =
  process.platform === 'win32' ? require('./win') : process.platform === 'darwin' ? require('./mac') : unsupported;
