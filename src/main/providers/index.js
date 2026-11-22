'use strict';
// Battery provider registry. Built-in providers + user plugins.
//
// A provider is a CommonJS module exporting:
//   {
//     id: 'unique-id',
//     name: 'Human readable name',
//     platforms: ['win32', 'darwin', 'linux'],   // optional, default = all
//     async init(ctx) {},                          // optional
//     async getDevices(ctx) {                      // required
//       return [{ id, name, kind, level, connected, components? }];
//     },
//     dispose() {},                                // optional
//   }
// Device fields:
//   id         stable unique string (prefix it with your provider id)
//   kind       'mouse' | 'keyboard' | 'headset' | 'gamepad' | 'phone' | 'other'
//   level      0-100 or null if unknown
//   connected  true / false / null (unknown)
//   components optional [{ key: 'left'|'right'|'case'|string, level }]
//
// User plugins: drop a .js file (or a folder with index.js) into <userData>/plugins and restart.
const fs = require('fs');
const path = require('path');

const BUILTIN = [require('./win-bluetooth'), require('./mac-bluetooth')];

function loadPlugins(dir, log) {
  const list = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const file = entry.isDirectory() ? path.join(full, 'index.js') : full;
      if (!file.endsWith('.js') || !fs.existsSync(file)) continue;
      try {
        const mod = require(file);
        if (mod && mod.id && typeof mod.getDevices === 'function') {
          list.push({ ...mod, plugin: true, file });
        } else {
          log(`plugin ${entry.name} ignored: missing id/getDevices`);
        }
      } catch (e) {
        log(`plugin ${entry.name} failed to load: ${e.message}`);
      }
    }
  } catch (e) {
    log('plugin dir error', e.message);
  }
  return list;
}

function loadProviders(pluginDir, log) {
  const all = [...BUILTIN, ...loadPlugins(pluginDir, log)];
  return all.filter((p) => !p.platforms || p.platforms.includes(process.platform));
}

module.exports = { loadProviders };
