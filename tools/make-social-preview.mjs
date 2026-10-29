/**
 * Render `docs/social-preview.png` (1280×640): a wordmark over the three demo
 * skins. Everything is drawn by this file — gradients from `demo-palette.mjs`
 * and a hand-rolled 5×7 bitmap font — so the image needs no artwork, no font
 * file and no native dependency.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEMOS, gradientPaint } from './demo-palette.mjs';
import { png } from './png.mjs';

const WIDTH = 1280;
const HEIGHT = 640;
const outDir = fileURLToPath(new URL('../docs/', import.meta.url));

/** 5×7 glyphs for the letters the wordmark needs. */
const FONT = {
  d: ['00000', '00001', '00001', '01111', '10001', '10001', '01111'],
  s: ['00000', '00000', '01111', '10000', '01110', '00001', '11110'],
  h: ['10000', '10000', '11110', '10001', '10001', '10001', '10001'],
  '-': ['00000', '00000', '00000', '01110', '00000', '00000', '00000'],
  i: ['00100', '00000', '01100', '00100', '00100', '00100', '01110'],
  n: ['00000', '00000', '11110', '10001', '10001', '10001', '10001'],
  k: ['10000', '10000', '10010', '10100', '11000', '10100', '10010'],
};

const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 3);
const put = (x, y, [r, g, b], alpha = 1) => {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const at = (y * WIDTH + x) * 3;
  pixels[at] = pixels[at] * (1 - alpha) + r * alpha;
  pixels[at + 1] = pixels[at + 1] * (1 - alpha) + g * alpha;
  pixels[at + 2] = pixels[at + 2] * (1 - alpha) + b * alpha;
};

/* ── background: a diagonal blend of the three demo moods ─────────────────── */
// Deliberately a plain two-stop blend: the demo gradient's sinusoidal band is a
// nice wallpaper, but across 1280px it reads as a ribbon cutting the wordmark.
const bgFrom = [26, 20, 24];
const bgTo = [17, 33, 33];
for (let y = 0; y < HEIGHT; y += 1) {
  for (let x = 0; x < WIDTH; x += 1) {
    const t = Math.min(1, Math.max(0, (x / WIDTH) * 0.62 + (y / HEIGHT) * 0.38));
    put(x, y, [
      Math.round(bgFrom[0] + (bgTo[0] - bgFrom[0]) * t),
      Math.round(bgFrom[1] + (bgTo[1] - bgFrom[1]) * t),
      Math.round(bgFrom[2] + (bgTo[2] - bgFrom[2]) * t),
    ]);
  }
}

/* ── the three demo skins as panels on the right ──────────────────────────── */
const panelX = 664;
const panelW = 552;
const panelH = 168;
const panelY = (index) => 46 + index * 186;
const radius = 16;

for (const [index, demo] of DEMOS.entries()) {
  const paint = gradientPaint([demo.still, demo.still], demo.band);
  const top = panelY(index);
  for (let y = 0; y < panelH; y += 1) {
    for (let x = 0; x < panelW; x += 1) {
      // Rounded corners: skip the pixels outside the inscribed circle of each corner.
      const nearX = x < radius ? radius - x : x >= panelW - radius ? x - (panelW - radius - 1) : 0;
      const nearY = y < radius ? radius - y : y >= panelH - radius ? y - (panelH - radius - 1) : 0;
      if (nearX > 0 && nearY > 0 && nearX * nearX + nearY * nearY > radius * radius) continue;
      put(panelX + x, top + y, paint(x, y, panelW, panelH), 1);
    }
  }
  // A hairline in the demo's accent keeps the panels legible against the blend.
  const accent = hexToRgb(demo.accent);
  for (let x = 0; x < panelW; x += 1) {
    put(panelX + x, top + panelH, accent, 0.5);
  }
}

/* ── wordmark: "dsh-skins" ────────────────────────────────────────────────── */
const word = 'dsh-skins';
const scale = 9;
const glyphW = 5 * scale;
const gap = scale;
let cursor = 96;
const baseline = 300;
for (const char of word) {
  const glyph = FONT[char];
  if (glyph === undefined) continue;
  for (let row = 0; row < 7; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      if (glyph[row][col] !== '1') continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          put(cursor + col * scale + dx, baseline + row * scale + dy, [242, 242, 245]);
        }
      }
    }
  }
  cursor += glyphW + gap;
}

// Accent bar under the wordmark, then a quiet second line of the same glyphs:
// "skins for dsh" would need more letters, so the tagline is drawn as three
// small colour chips instead of more text.
const barY = baseline + 7 * scale + 26;
for (let x = 96; x < 96 + 220; x += 1) put(x, barY, [193, 118, 74]);
for (let x = 96 + 220; x < 96 + 320; x += 1) put(x, barY, [47, 156, 148]);

DEMOS.forEach((demo, index) => {
  const x = 96 + index * 28;
  const y = barY + 34;
  const rgb = hexToRgb(demo.accent);
  for (let dy = 0; dy < 18; dy += 1) for (let dx = 0; dx < 18; dx += 1) put(x + dx, y + dy, rgb);
});

/* ── vignette + encode ────────────────────────────────────────────────────── */
const centreX = WIDTH / 2;
const centreY = HEIGHT / 2;
const maxDistance = Math.hypot(centreX, centreY);
for (let y = 0; y < HEIGHT; y += 1) {
  for (let x = 0; x < WIDTH; x += 1) {
    const d = Math.hypot(x - centreX, y - centreY) / maxDistance;
    put(x, y, [0, 0, 0], Math.min(0.28, d * 0.34));
  }
}

mkdirSync(outDir, { recursive: true });
const target = join(outDir, 'social-preview.png');
writeFileSync(target, png(WIDTH, HEIGHT, (x, y) => {
  const at = (y * WIDTH + x) * 3;
  return [pixels[at], pixels[at + 1], pixels[at + 2]];
}));
console.log(`wrote ${target}`);

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}
