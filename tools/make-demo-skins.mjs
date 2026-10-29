/**
 * Write the demo skins that ship with this repository.
 *
 * Every still is drawn here — the palettes live in `demo-palette.mjs`, shared
 * with the social-preview renderer — so the repository contains real image files
 * without containing anyone's artwork. The measured records are synthetic too:
 * they describe the generated stills, so the demo skins are honest about where
 * their colours come from.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSkin } from '../packages/toolkit/lib/index.mjs';
import { DEMOS, gradientPaint } from './demo-palette.mjs';
import { png } from './png.mjs';

const outRoot = fileURLToPath(new URL('../skins/demo/', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'dsh-skins-demo-'));

/** Complete the measured record: only the colour/luminance fields vary per skin. */
function record(fields) {
  return {
    firstImpression: 'procedurally generated demo',
    ...fields,
    secondaryColors: fields.secondaries,
    contrast: 'medium',
    material: 'flat gradient',
    lighting: 'none',
    composition: 'generated',
    styleKeywords: ['demo', 'generated'],
    mood: ['calm'],
    backgroundSuitability: {
      dark: { verdict: fields.luma < 0.5 ? 'good' : 'workable' },
      light: { verdict: fields.luma < 0.5 ? 'workable' : 'good' },
    },
    paletteProposal: {
      accent: fields.accent,
      surface: fields.neutrals[0],
      companion: fields.secondaries[0] ?? fields.accent,
      scheme: fields.luma < 0.5 ? 'dark' : 'light',
      rationale: 'generated demo',
    },
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

for (const demo of DEMOS) {
  const stillPath = join(work, `${demo.skinId}.png`);
  writeFileSync(stillPath, png(640, 360, gradientPaint([demo.still, demo.still], demo.band)));
  const built = buildSkin({
    record: record(demo.record),
    meta: meta(demo.skinId, demo.name, demo.nameZh),
    assets: { wallpaper: stillPath },
    outRoot,
  });
  console.log(`built ${demo.skinId} -> ${built.dir} (${Object.keys(built.tokens.presentedTokens).length} tokens)`);
}

rmSync(work, { recursive: true, force: true });
