'use strict';
// Builds tray icons (multi-DPI nativeImage) from the tiny rasterizer.
const { Raster, drawText, textWidthCells } = require('./raster');

const COLORS = {
  green: [0.22, 0.8, 0.4],
  amber: [1, 0.69, 0.1],
  red: [1, 0.3, 0.26],
  blue: [0.25, 0.6, 1],
  white: [1, 1, 1],
  black: [0.08, 0.08, 0.08],
};

const WIN_SIZES = [
  [16, 1],
  [20, 1.25],
  [24, 1.5],
  [32, 2],
  [40, 2.5],
];
const MAC_SIZES = [
  [18, 1],
  [36, 2],
];

function levelColor(level, lowThreshold) {
  if (level <= lowThreshold) return COLORS.red;
  if (level <= 50) return COLORS.amber;
  return COLORS.green;
}

function withAlpha(c, a) {
  return [c[0], c[1], c[2], a];
}

// Horizontal battery glyph filling most of the square.
function drawBatteryGlyph(r, S, fraction, fg, fillColor) {
  const t = Math.max(1, S / 14);
  const h = S * 0.5;
  const y = (S - h) / 2;
  const x = S * 0.06;
  const w = S * 0.8;
  r.roundRectStroke(x, y, w, h, S * 0.1, t, fg);
  r.roundRect(x + w + t * 0.3, y + h * 0.3, S * 0.09, h * 0.4, S * 0.03, fg);
  const pad = t * 1.6;
  const fw = Math.max(0, (w - 2 * pad) * Math.min(1, Math.max(0, fraction)));
  if (fw > 0) r.roundRect(x + pad, y + pad, fw, h - 2 * pad, S * 0.04, fillColor);
}

function drawPercent(r, S, level, fg, low) {
  if (level >= 100) {
    drawBatteryGlyph(r, S, 1, fg, COLORS.green);
    return;
  }
  const text = level == null ? '--' : String(Math.max(0, Math.round(level)));
  const barH = Math.max(2, Math.round(S * 0.14));
  const gap = Math.max(1, Math.round(S * 0.08));
  let cell = Math.max(1, Math.round((S * 0.62) / 5));
  while (cell > 1 && textWidthCells(text) * cell > S) cell--;
  const tw = textWidthCells(text) * cell;
  const th = 5 * cell;
  const ty = Math.max(0, Math.round((S - barH - gap - th) / 2));
  const tx = Math.round((S - tw) / 2);
  const isLow = level != null && level <= low;
  drawText(r, text, tx, ty, cell, isLow ? COLORS.red : fg);

  const by = ty + th + gap;
  const bx = Math.round(S * 0.06);
  const bw = S - 2 * bx;
  r.roundRect(bx, by, bw, barH, barH / 2, withAlpha(fg, 0.3));
  if (level != null && level > 0) {
    r.roundRect(bx, by, Math.max(barH, (bw * level) / 100), barH, barH / 2, levelColor(level, low));
  }
}

function drawMic(r, S, fg, muted) {
  const color = muted ? COLORS.red : fg;
  const cw = S * 0.34;
  const ch = S * 0.5;
  const cx = S / 2;
  const t = Math.max(1, S / 12);
  r.roundRect(cx - cw / 2, S * 0.08, cw, ch, cw / 2, color);
  r.arcBottom(cx, S * 0.08 + ch * 0.55, S * 0.29, t, color);
  r.line(cx, S * 0.08 + ch * 0.55 + S * 0.29, cx, S * 0.88, t, color);
  r.line(cx - S * 0.18, S * 0.9, cx + S * 0.18, S * 0.9, t, color);
  if (muted) {
    r.clearLine(S * 0.12, S * 0.1, S * 0.88, S * 0.9, t * 3);
    r.line(S * 0.14, S * 0.1, S * 0.88, S * 0.86, t, COLORS.red);
  }
}

function drawAppGlyph(r, S, fg) {
  drawBatteryGlyph(r, S, 0.62, fg, COLORS.blue);
}

function buildImage(nativeImage, sizes, draw, template) {
  let img = null;
  for (const [S, scale] of sizes) {
    const r = new Raster(S, S);
    draw(r, S);
    const png = r.toPNG();
    if (!img) img = nativeImage.createFromBuffer(png, { scaleFactor: scale });
    else img.addRepresentation({ scaleFactor: scale, buffer: png });
  }
  if (template) img.setTemplateImage(true);
  return img;
}

/**
 * @param {Electron.nativeImage} nativeImage
 * @param {object} o { level:number|null, low:number, dark:boolean, platform }
 */
function batteryIcon(nativeImage, o) {
  if (o.platform === 'darwin') {
    // Template glyph – macOS tints it; the % is shown via tray.setTitle().
    return buildImage(nativeImage, MAC_SIZES, (r, S) => drawBatteryGlyph(r, S, (o.level ?? 0) / 100, COLORS.black, COLORS.black), true);
  }
  const fg = o.dark ? COLORS.white : COLORS.black;
  return buildImage(nativeImage, WIN_SIZES, (r, S) => drawPercent(r, S, o.level, fg, o.low ?? 20), false);
}

function micIcon(nativeImage, o) {
  if (o.platform === 'darwin') {
    return buildImage(nativeImage, MAC_SIZES, (r, S) => drawMic(r, S, COLORS.black, o.muted), !o.muted);
  }
  const fg = o.dark ? COLORS.white : COLORS.black;
  return buildImage(nativeImage, WIN_SIZES, (r, S) => drawMic(r, S, fg, o.muted), false);
}

function appIcon(nativeImage, o) {
  if (o.platform === 'darwin') {
    return buildImage(nativeImage, MAC_SIZES, (r, S) => drawBatteryGlyph(r, S, 0.62, COLORS.black, COLORS.black), true);
  }
  const fg = o.dark ? COLORS.white : COLORS.black;
  return buildImage(nativeImage, WIN_SIZES, (r, S) => drawAppGlyph(r, S, fg), false);
}

module.exports = { batteryIcon, micIcon, appIcon, drawBatteryGlyph, COLORS };
