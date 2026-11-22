'use strict';
// Sample TrayPulse battery provider plugin.
// Copy this file into the plugins folder (Settings → "Open plugins folder") and restart TrayPulse.
// It adds a fake device whose battery slowly drains, so you can see how plugins work.

let level = 100;

module.exports = {
  id: 'sample-provider',
  name: 'Sample provider',
  platforms: ['win32', 'darwin', 'linux'],

  async init(ctx) {
    ctx.log('sample provider loaded');
  },

  async getDevices() {
    level = level <= 5 ? 100 : level - 5;
    return [
      {
        id: 'sample:demo-mouse',
        name: 'Demo Mouse',
        kind: 'mouse', // mouse | keyboard | headset | gamepad | phone | other
        level, // 0-100 or null
        connected: true, // true | false | null
      },
      {
        id: 'sample:demo-buds',
        name: 'Demo Earbuds',
        kind: 'headset',
        level: 70,
        connected: true,
        components: [
          { key: 'left', level: 70 },
          { key: 'right', level: 74 },
          { key: 'case', level: 35 },
        ],
      },
    ];
  },

  dispose() {},
};
