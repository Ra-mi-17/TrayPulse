'use strict';
// Tiny dependency-free anti-aliased rasterizer + PNG encoder.
// Used to draw tray icons (battery %, mic state) at any DPI without a renderer process.
const zlib = require('zlib');

const SS = 4; // supersampling per axis

class Raster {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Float32Array(w * h * 4); // premultiplied RGBA 0..1
  }

  // Fill the region where inside(x, y) is true. bbox = [x0, y0, x1, y1] in pixels.
  fill(inside, color, bbox) {
    const [r, g, b, a = 1] = color;
    const x0 = Math.max(0, Math.floor(bbox[0]));
    const y0 = Math.max(0, Math.floor(bbox[1]));
    const x1 = Math.min(this.w, Math.ceil(bbox[2]));
    const y1 = Math.min(this.h, Math.ceil(bbox[3]));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let hit = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            if (inside(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hit++;
          }
        }
        if (!hit) continue;
        const cov = (hit / (SS * SS)) * a;
        const i = (y * this.w + x) * 4;
        const inv = 1 - cov;
        this.px[i] = r * cov + this.px[i] * inv;
        this.px[i + 1] = g * cov + this.px[i + 1] * inv;
        this.px[i + 2] = b * cov + this.px[i + 2] * inv;
        this.px[i + 3] = cov + this.px[i + 3] * inv;
      }
    }
  }

  rect(x, y, w, h, color) {
    this.fill((px, py) => px >= x && px < x + w && py >= y && py < y + h, color, [x, y, x + w, y + h]);
  }

  roundRect(x, y, w, h, rad, color) {
    rad = Math.min(rad, w / 2, h / 2);
    this.fill(
      (px, py) => {
        const cx = Math.min(Math.max(px, x + rad), x + w - rad);
        const cy = Math.min(Math.max(py, y + rad), y + h - rad);
        return (px - cx) ** 2 + (py - cy) ** 2 <= rad * rad && px >= x && px <= x + w && py >= y && py <= y + h;
      },
      color,
      [x, y, x + w, y + h]
    );
  }

  // Outline of a rounded rect with stroke width t.
  roundRectStroke(x, y, w, h, rad, t, color) {
    const inner = (px, py, ox, oy, ow, oh, orad) => {
      orad = Math.max(0, Math.min(orad, ow / 2, oh / 2));
      if (px < ox || px > ox + ow || py < oy || py > oy + oh) return false;
      const cx = Math.min(Math.max(px, ox + orad), ox + ow - orad);
      const cy = Math.min(Math.max(py, oy + orad), oy + oh - orad);
      return (px - cx) ** 2 + (py - cy) ** 2 <= orad * orad;
    };
    this.fill(
      (px, py) => inner(px, py, x, y, w, h, rad) && !inner(px, py, x + t, y + t, w - 2 * t, h - 2 * t, rad - t),
      color,
      [x, y, x + w, y + h]
    );
  }

  circle(cx, cy, rad, color) {
    this.fill((px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= rad * rad, color, [cx - rad, cy - rad, cx + rad, cy + rad]);
  }

  // Line segment with round caps.
  line(x0, y0, x1, y1, t, color) {
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy || 1;
    const r = t / 2;
    this.fill(
      (px, py) => {
        let u = ((px - x0) * dx + (py - y0) * dy) / len2;
        u = Math.max(0, Math.min(1, u));
        const qx = x0 + u * dx, qy = y0 + u * dy;
        return (px - qx) ** 2 + (py - qy) ** 2 <= r * r;
      },
      color,
      [Math.min(x0, x1) - r, Math.min(y0, y1) - r, Math.max(x0, x1) + r, Math.max(y0, y1) + r]
    );
  }

  // Lower half ring (U shape) used for the microphone glyph.
  arcBottom(cx, cy, rad, t, color) {
    this.fill(
      (px, py) => {
        const d = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
        return py >= cy && d <= rad + t / 2 && d >= rad - t / 2;
      },
      color,
      [cx - rad - t, cy, cx + rad + t, cy + rad + t]
    );
  }

  // Erase (make transparent) pixels within a band around a line — used for "slash" cut-outs.
  clearLine(x0, y0, x1, y1, t) {
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy || 1;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        let hit = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
            let u = ((px - x0) * dx + (py - y0) * dy) / len2;
            u = Math.max(0, Math.min(1, u));
            if ((px - (x0 + u * dx)) ** 2 + (py - (y0 + u * dy)) ** 2 <= (t / 2) ** 2) hit++;
          }
        }
        if (!hit) continue;
        const keep = 1 - hit / (SS * SS);
        const i = (y * this.w + x) * 4;
        for (let k = 0; k < 4; k++) this.px[i + k] *= keep;
      }
    }
  }

  toPNG() {
    const { w, h } = this;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
      raw[y * (w * 4 + 1)] = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const a = this.px[i + 3];
        const o = y * (w * 4 + 1) + 1 + x * 4;
        // un-premultiply
        raw[o] = a ? Math.round(Math.min(1, this.px[i] / a) * 255) : 0;
        raw[o + 1] = a ? Math.round(Math.min(1, this.px[i + 1] / a) * 255) : 0;
        raw[o + 2] = a ? Math.round(Math.min(1, this.px[i + 2] / a) * 255) : 0;
        raw[o + 3] = Math.round(Math.min(1, a) * 255);
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// 3x5 pixel font for tray digits.
const FONT = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
  '-': ['000', '000', '111', '000', '000'],
  '?': ['111', '001', '011', '000', '010'],
};

// Draws text with the pixel font. Returns nothing; `cell` is the size of one font pixel.
function drawText(r, text, x, y, cell, color) {
  let cx = x;
  for (const ch of text) {
    const g = FONT[ch];
    if (!g) { cx += 4 * cell; continue; }
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (g[row][col] === '1') r.rect(cx + col * cell, y + row * cell, cell, cell, color);
      }
    }
    cx += 4 * cell;
  }
}

function textWidthCells(text) {
  return text.length * 4 - 1;
}

module.exports = { Raster, drawText, textWidthCells };
