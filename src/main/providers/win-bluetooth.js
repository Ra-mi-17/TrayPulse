'use strict';
// Windows: Bluetooth battery levels.
//  1. Device-node property DEVPKEY_Bluetooth_Battery (Classic HFP headsets, many BLE devices) — fast, via SetupAPI.
//  2. BLE GATT Battery Service (0x180F) via WinRT — covers BLE mice/keyboards that don't populate (1).
const { batteryHelper } = require('../platform/winHelper');
const { guessKind } = require('./util');

function componentsFor(kind, levels) {
  if (!Array.isArray(levels) || levels.length < 2) return undefined;
  if (kind === 'headset' && levels.length <= 3) {
    const keys = ['left', 'right', 'case'];
    return levels.map((level, i) => ({ key: keys[i], level }));
  }
  return levels.map((level, i) => ({ key: `part${i + 1}`, level }));
}

module.exports = {
  id: 'win-bluetooth',
  name: 'Windows Bluetooth',
  platforms: ['win32'],

  async getDevices(ctx) {
    const helper = batteryHelper();
    const devices = new Map();

    try {
      const pnp = (await helper.call('battery.pnp', {}, 20000)) || [];
      for (const d of pnp) {
        devices.set(d.containerId, {
          id: `bt:${d.containerId}`,
          name: d.name,
          kind: d.kind !== 'other' ? d.kind : guessKind(d.name),
          level: d.level,
          connected: d.connected === -1 ? null : d.connected === 1,
        });
      }
    } catch (e) {
      ctx.log('pnp battery failed', e.message);
    }

    try {
      const ble = (await helper.call('battery.ble', { uncached: !ctx.powerSaving }, 60000)) || [];
      for (const d of ble) {
        const key = d.containerId || d.address;
        const existing = devices.get(key);
        const kind = existing?.kind || guessKind(d.name);
        const dev = {
          id: existing?.id || (d.containerId ? `bt:${d.containerId}` : `ble:${d.address}`),
          name: existing?.name || d.name,
          kind,
          // GATT value is fresher when the device is connected.
          level: d.connected || existing?.level == null ? d.level : existing.level,
          connected: d.connected === 1 || existing?.connected === true,
          components: componentsFor(kind, d.levels),
        };
        devices.set(key, dev);
      }
    } catch (e) {
      ctx.log('ble battery failed', e.message);
    }

    return [...devices.values()];
  },
};
