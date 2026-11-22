'use strict';
// Windows audio via Core Audio (see native/win/TrayPulseNative.cs).
const { audioHelper } = require('../platform/winHelper');

const OUTPUT = 0;
const INPUT = 1;
const call = (cmd, args) => audioHelper().call(cmd, args, 15000);

module.exports = {
  capabilities: { outputSwitch: true, inputSwitch: true, micMute: true, outputVolume: true, mixer: true },
  warmUp: () => audioHelper().start(),
  listDevices: async (flow) => (await call('audio.listDevices', { flow: flow === 'input' ? INPUT : OUTPUT })) || [],
  setDefault: (id) => call('audio.setDefault', { id }),
  getEndpoint: (flow) => call('audio.getEndpoint', { flow: flow === 'input' ? INPUT : OUTPUT }),
  setVolume: (flow, volume) => call('audio.setEndpointVolume', { flow: flow === 'input' ? INPUT : OUTPUT, volume }),
  // mode: 'toggle' | true | false. Resolves to the new muted state.
  setMute: (flow, mode) =>
    call('audio.setEndpointMute', { flow: flow === 'input' ? INPUT : OUTPUT, mode: mode === 'toggle' ? -1 : mode ? 1 : 0 }),
  listSessions: async () => (await call('audio.listSessions')) || [],
  setSessionVolume: (key, volume) => call('audio.setSessionVolume', { key, volume }),
  setSessionMute: (key, muted) => call('audio.setSessionMute', { key, muted }),
};
