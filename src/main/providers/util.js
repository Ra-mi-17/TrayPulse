'use strict';
const { execFile } = require('child_process');

/** Guess a device kind from its name. Returns 'mouse' | 'keyboard' | 'headset' | 'gamepad' | 'phone' | 'other'. */
function guessKind(name = '', fallback = 'other') {
  const n = name.toLowerCase();
  if (/mouse|mx master|mx anywhere|trackball|trackpad|マウス/.test(n)) return 'mouse';
  if (/keyboard|keys|キーボード/.test(n)) return 'keyboard';
  if (/controller|gamepad|dualsense|dualshock|joy-?con|xbox|コントローラー/.test(n)) return 'gamepad';
  if (/airpods|buds|headphone|headset|earbud|earphone|wh-|wf-|eah-|beats|jabra|bose|speaker|イヤホン|ヘッドホン/.test(n)) return 'headset';
  if (/iphone|galaxy|pixel|phone|s\d\d ultra|android/.test(n)) return 'phone';
  return fallback;
}

function execText(cmd, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

function parsePercent(v) {
  if (v == null) return null;
  const m = String(v).match(/(\d{1,3})/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 100 ? n : null;
}

module.exports = { guessKind, execText, parsePercent };
