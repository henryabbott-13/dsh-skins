/**
 * Write the demo skins that ship with this repository.
 *
 * Every still is drawn here — a two-stop gradient plus a soft band — so the
 * repository contains real image files without containing anyone's artwork.
 * The measured records are synthetic too: they describe the generated stills, so
 * the demo skins are honest about where their colours come from.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSkin } from '../packages/toolkit/lib/index.mjs';
import { png } from './png.mjs';

const outRoot = fileURLToPath(new URL('../skins/demo/', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'dsh-skins-demo-'));

function record({ primary, accent, neutrals, secondaries, luma, saturation, temperature, busyness }) {
  return {
    firstImpression: 'procedurally generated demo',
    primaryColor: primary,
    secondaryColors: secondaries,
    accentColor: accent,
    neutrals,
    luminance: luma,
    contrast: 'medium',
    saturation,
    temperature,
    material: 'flat gradient',
    lighting: 'none',
    composition: 'generated',
    busyness,
    styleKeywords: ['demo', 'generated'],
    mood: ['calm'],
    backgroundSuitability: { dark: { verdict: luma < 0.5 ? 'good' : 'workable' }, light: { verdict: luma < 0.5 ? 'workable' : 'good' } },
    paletteProposal: { accent, surface: neutrals[0], companion: secondaries[0] ?? accent, scheme: luma < 0.5 ? 'dark' : 'light', rationale: 'generated demo' },
  };
}

function meta(skinId, name, nameZh) {
  return {
    skinId,
    slug: skinId.split('_')[1],
    name,
    nameZh,
    kind: 'image',
    source: `${skinId}.png`,
    sourceBytes: 0,
    sourceSize: { width: 640, height: 360 },
    durationSeconds: null,
    bitrateMbps: null,
    analysisRecord: 'tools/make-demo-skins.mjs (synthetic)',
    artwork: {},
    material: 'flat gradient',
    lighting: 'none',
    busyness: 'calm',
    styleKeywords: ['demo', 'generated'],
    mood: ['calm'],
    frameCount: null,
    sampledTimes: null,
    frameDrift: null,
    motionNote: null,
    posterAdvice: null,
  };
}

/** Two-stop gradient with a diagonal band, deterministic and dependency-free. */
function still(path, [top, bottom], band) {
  const width = 640;
  const height = 360;
  writeFileSync(
    path,
    png(width, height, (x, y) => {
      const t = (x / width) * 0.45 + (y / height) * 0.55;
      const inBand = Math.abs(y - height * 0.62 - Math.sin(x / 70) * 18) < 26;
      const from = inBand && band !== undefined ? band : top;
      const to = inBand && band !== undefined ? band : bottom;
      return [
        Math.round(from[0] + (to[0] - from[0]) * t),
        Math.round(from[1] + (to[1] - from[1]) * t),
        Math.round(from[2] + (to[2] - from[2]) * t),
      ];
    }),
  );
}

const demos = [
  {
    skinId: 'img_demo-ember_6b1f2c3d',
    name: 'Demo Ember',
    nameZh: '示例·余烬',
    still: [38, 30, 34],
    band: [193, 118, 74],
    record: record({
      primary: '#2a1e22',
      accent: '#c1764a',
      neutrals: ['#1a1518', '#6a5550', '#efe4da'],
      secondaries: ['#c1764a', '#8fb3d9'],
      luma: 0.24,
      saturation: 'muted',
      temperature: 'warm',
      busyness: 'calm',
    }),
  },
  {
    skinId: 'img_demo-frost_9c8d7e6f',
    name: 'Demo Frost',
    nameZh: '示例·霜白',
    still: [214, 222, 234],
    band: [63, 111, 176],
    record: record({
      primary: '#d6deea',
      accent: '#3f6fb0',
      neutrals: ['#f2f5fa', '#9aa3b4', '#22262f'],
      secondaries: ['#3f6fb0', '#b4551f'],
      luma: 0.78,
      saturation: 'balanced',
      temperature: 'cool',
      busyness: 'moderate',
    }),
  },
  {
    skinId: 'img_demo-teal_4d5e6f70',
    name: 'Demo Teal',
    nameZh: '示例·青碧',
    still: [26, 46, 46],
    band: [47, 156, 148],
    record: record({
      primary: '#1b2f2f',
      accent: '#2f9c94',
      neutrals: ['#121a1a', '#4a6464', '#dfe9e7'],
      secondaries: ['#2f9c94', '#c69a5f'],
      luma: 0.2,
      saturation: 'muted',
      temperature: 'cool',
      busyness: 'calm',
    }),
  },
];

for (const demo of demos) {
  const stillPath = join(work, `${demo.skinId}.png`);
  still(stillPath, [demo.still, demo.still.map((v) => Math.min(255, v + 26))], demo.band);
  const built = buildSkin({
    record: demo.record,
    meta: meta(demo.skinId, demo.name, demo.nameZh),
    assets: { wallpaper: stillPath },
    outRoot,
  });
  console.log(`built ${demo.skinId} -> ${built.dir} (${Object.keys(built.tokens.presentedTokens).length} tokens)`);
}

rmSync(work, { recursive: true, force: true });
