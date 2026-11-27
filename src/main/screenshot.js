'use strict';
// Screenshot helpers.
//  region: uses the OS tool (Windows Snipping overlay / macOS screencapture -i)
//  full  : captures the display under the cursor with desktopCapturer and saves a PNG.
const { app, desktopCapturer, screen, shell, clipboard, ClipboardItem, nativeImage } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function outputDir(store) {
  const dir = store.get('screenshotDir') || path.join(app.getPath('pictures'), 'TrayPulse');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// Electron 45 replaced clipboard.writeImage() with the W3C-style clipboard.write([ClipboardItem]).
// A failed copy must not turn an already-saved screenshot into an error.
async function copyImage(img) {
  try {
    const png = img.toPNG();
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
  } catch (e) {
    console.error('copy screenshot to clipboard failed', e);
  }
}

async function region(store) {
  if (process.platform === 'win32') {
    // Opens the built-in snipping overlay (copies to clipboard, Windows 11 also auto-saves).
    await shell.openExternal('ms-screenclip:');
    return null;
  }
  if (process.platform === 'darwin') {
    const file = path.join(outputDir(store), `Screenshot_${stamp()}.png`);
    await new Promise((resolve) => execFile('/usr/sbin/screencapture', ['-i', file], () => resolve()));
    if (!fs.existsSync(file)) return null; // cancelled
    if (store.get('screenshotCopyToClipboard')) await copyImage(nativeImage.createFromPath(file));
    return file;
  }
  return full(store);
}

async function full(store) {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const size = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!src) throw new Error('no screen source');
  const img = src.thumbnail;
  const file = path.join(outputDir(store), `Screenshot_${stamp()}.png`);
  fs.writeFileSync(file, img.toPNG());
  if (store.get('screenshotCopyToClipboard')) await copyImage(img);
  return file;
}

module.exports = { region, full, outputDir };
