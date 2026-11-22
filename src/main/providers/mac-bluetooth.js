'use strict';
// macOS: Bluetooth battery levels.
//  - `system_profiler SPBluetoothDataType -json` : AirPods / Beats (left, right, case) and many headsets.
//  - `ioreg -r -l -k BatteryPercent`             : Apple Magic Mouse / Keyboard / Trackpad and other HID devices.
// NOTE: written without access to a Mac – please verify and send a PR if something is off.
const { execText, parsePercent, guessKind } = require('./util');

function normAddr(a) {
  return a ? String(a).toUpperCase().replace(/[^0-9A-F]/g, '') : null;
}

function kindFromMinorType(minor, name) {
  const m = String(minor || '').toLowerCase();
  if (m.includes('mouse') || m.includes('trackpad')) return 'mouse';
  if (m.includes('keyboard')) return 'keyboard';
  if (m.includes('headphone') || m.includes('headset') || m.includes('speaker')) return 'headset';
  if (m.includes('gamepad') || m.includes('joystick')) return 'gamepad';
  if (m.includes('phone')) return 'phone';
  return guessKind(name);
}

async function fromSystemProfiler() {
  const out = [];
  const json = JSON.parse(await execText('/usr/sbin/system_profiler', ['SPBluetoothDataType', '-json'], 20000));
  const root = (json.SPBluetoothDataType || [])[0] || {};
  const groups = [
    [root.device_connected, true],
    [root.device_not_connected, false],
    [root.devices_list, null], // older macOS
  ];
  for (const [list, connected] of groups) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      for (const [name, info] of Object.entries(entry)) {
        const left = parsePercent(info.device_batteryLevelLeft);
        const right = parsePercent(info.device_batteryLevelRight);
        const kase = parsePercent(info.device_batteryLevelCase);
        const main = parsePercent(info.device_batteryLevelMain ?? info.device_batteryLevel);
        const components = [];
        if (left != null) components.push({ key: 'left', level: left });
        if (right != null) components.push({ key: 'right', level: right });
        if (kase != null) components.push({ key: 'case', level: kase });
        const buds = [left, right].filter((v) => v != null);
        const level = main ?? (buds.length ? Math.min(...buds) : kase);
        if (level == null) continue;
        out.push({
          address: normAddr(info.device_address),
          name,
          kind: kindFromMinorType(info.device_minorType, name),
          level,
          connected: connected ?? (info.device_connected === 'attrib_Yes' || info.device_isconnected === 'attrib_Yes'),
          components: components.length > 1 ? components : undefined,
        });
      }
    }
  }
  return out;
}

async function fromIoreg() {
  const out = [];
  const text = await execText('/usr/sbin/ioreg', ['-r', '-l', '-k', 'BatteryPercent'], 10000);
  const blocks = text.split(/\n(?=\+-o )/);
  for (const b of blocks) {
    const pct = b.match(/"BatteryPercent"\s*=\s*(\d+)/);
    if (!pct) continue;
    const name = (b.match(/"Product"\s*=\s*"([^"]+)"/) || [])[1] || 'Bluetooth device';
    const addr = (b.match(/"DeviceAddress"\s*=\s*"([^"]+)"/) || [])[1];
    out.push({ address: normAddr(addr), name, kind: guessKind(name), level: Number(pct[1]), connected: true });
  }
  return out;
}

module.exports = {
  id: 'mac-bluetooth',
  name: 'macOS Bluetooth',
  platforms: ['darwin'],

  async getDevices(ctx) {
    const merged = new Map();
    const results = await Promise.allSettled([fromIoreg(), fromSystemProfiler()]);
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        ctx.log(i === 0 ? 'ioreg failed' : 'system_profiler failed', r.reason?.message);
        return;
      }
      for (const d of r.value) {
        const key = d.address || d.name;
        const prev = merged.get(key);
        merged.set(key, {
          ...prev,
          ...d,
          // ioreg (live HID value) wins for the main level; system_profiler adds components.
          level: prev?.level ?? d.level,
          components: d.components || prev?.components,
          connected: prev?.connected || d.connected,
        });
      }
    });
    return [...merged.entries()].map(([key, d]) => ({
      id: `mac:${key}`,
      name: d.name,
      kind: d.kind,
      level: d.level,
      connected: d.connected,
      components: d.components,
    }));
  },
};
