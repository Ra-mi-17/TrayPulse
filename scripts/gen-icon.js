'use strict';
// Generates build/icon.png (app icon for installers) with the same rasterizer used for tray icons.
// Usage: node scripts/gen-icon.js [--preview <dir>]
const fs = require('fs');
const path = require('path');
const { Raster } = require('../src/main/graphics/raster');
const { drawBatteryGlyph, COLORS } = require('../src/main/graphics/icons');

function appIcon(S) {
  const r = new Raster(S, S);
  r.roundRect(S * 0.06, S * 0.06, S * 0.88, S * 0.88, S * 0.22, [0.13, 0.15, 0.2]);
  // Draw battery glyph in a smaller box centered in the tile.
  const pad = S * 0.18;
  const G = S - pad * 2;
  const g = new Raster(Math.round(G), Math.round(G));
  drawBatteryGlyph(g, G, 0.65, COLORS.white, COLORS.green);
  // pulse line
  const t = G * 0.06;
  const y = G / 2;
  g.line(G * 0.16, y, G * 0.3, y, t, [0.13, 0.15, 0.2]);
  g.line(G * 0.3, y, G * 0.38, y - G * 0.14, t, [0.13, 0.15, 0.2]);
  g.line(G * 0.38, y - G * 0.14, G * 0.48, y + G * 0.14, t, [0.13, 0.15, 0.2]);
  g.line(G * 0.48, y + G * 0.14, G * 0.55, y, t, [0.13, 0.15, 0.2]);
  g.line(G * 0.55, y, G * 0.66, y, t, [0.13, 0.15, 0.2]);
  // composite g onto r
  const ox = Math.round(pad), oy = Math.round(pad);
  for (let yy = 0; yy < g.h; yy++) {
    for (let xx = 0; xx < g.w; xx++) {
      const si = (yy * g.w + xx) * 4;
      const a = g.px[si + 3];
      if (!a) continue;
      const di = ((yy + oy) * S + (xx + ox)) * 4;
      for (let k = 0; k < 4; k++) r.px[di + k] = g.px[si + k] + r.px[di + k] * (1 - a);
    }
  }
  return r.toPNG();
}

const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'icon.png'), appIcon(512));
console.log('wrote build/icon.png');

const i = process.argv.indexOf('--preview');
if (i > 0) {
  // Writes sample tray icons for visual inspection.
  const dir = process.argv[i + 1];
  fs.mkdirSync(dir, { recursive: true });
  const fakeNative = {
    createFromBuffer: (buf) => {
      const reps = [buf];
      return { addRepresentation: ({ buffer }) => reps.push(buffer), setTemplateImage() {}, reps };
    },
  };
  const icons = require('../src/main/graphics/icons');
  const cases = [
    ['bat-85-dark', icons.batteryIcon(fakeNative, { level: 85, low: 20, dark: true, platform: 'win32' })],
    ['bat-42-dark', icons.batteryIcon(fakeNative, { level: 42, low: 20, dark: true, platform: 'win32' })],
    ['bat-7-dark', icons.batteryIcon(fakeNative, { level: 7, low: 20, dark: true, platform: 'win32' })],
    ['bat-100-light', icons.batteryIcon(fakeNative, { level: 100, low: 20, dark: false, platform: 'win32' })],
    ['bat-null-light', icons.batteryIcon(fakeNative, { level: null, low: 20, dark: false, platform: 'win32' })],
    ['mic-on-dark', icons.micIcon(fakeNative, { muted: false, dark: true, platform: 'win32' })],
    ['mic-off-dark', icons.micIcon(fakeNative, { muted: true, dark: true, platform: 'win32' })],
    ['app-dark', icons.appIcon(fakeNative, { dark: true, platform: 'win32' })],
  ];
  for (const [name, img] of cases) {
    img.reps.forEach((b, k) => fs.writeFileSync(path.join(dir, `${name}-${k}.png`), b));
  }
  console.log('wrote previews to', dir);
}
