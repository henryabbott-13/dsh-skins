/**
 * Toolkit checks: assemble a skin from a measured record, then read it back.
 *
 * These run with plain node and no decoder: the record is written by hand and the
 * stills are generated PNGs, so the test proves the *contract* (ids, token pairs,
 * scoping, asset fallbacks) without depending on any image library.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSkin, checkSkinDir } from '../packages/toolkit/lib/index.mjs';
import { png } from '../tools/png.mjs';

const results = [];
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

const work = mkdtempSync(join(tmpdir(), 'dsh-skins-toolkit-'));

/** A measured record, shaped like the panel's `buildRecord` output. */
function record({ primary, accent, neutrals, secondaries, luma, saturation, temperature, busyness }) {
  return {
    firstImpression: 'synthetic fixture',
    primaryColor: primary,
    secondaryColors: secondaries,
    accentColor: accent,
    neutrals,
    luminance: luma,
    contrast: 'medium',
    saturation,
    temperature,
    material: 'flat colour',
    lighting: 'none',
    composition: 'fixture',
    busyness,
    styleKeywords: ['demo'],
    mood: [],
    backgroundSuitability: { dark: { verdict: luma < 0.5 ? 'good' : 'workable' }, light: { verdict: luma < 0.5 ? 'workable' : 'good' } },
    paletteProposal: { accent, surface: neutrals[0], companion: secondaries[0] ?? accent, scheme: luma < 0.5 ? 'dark' : 'light', rationale: 'fixture' },
  };
}

function meta(skinId, name, kind = 'image') {
  return {
    skinId,
    slug: skinId.split('_')[1],
    name,
    nameZh: name,
    kind,
    source: `${skinId}.png`,
    sourceBytes: 1234,
    sourceSize: { width: 320, height: 180 },
    durationSeconds: null,
    bitrateMbps: null,
    analysisRecord: 'tests/toolkit.mjs',
    artwork: {},
    material: 'flat colour',
    lighting: 'none',
    busyness: 'calm',
    styleKeywords: ['demo'],
    mood: [],
    frameCount: null,
    sampledTimes: null,
    frameDrift: null,
    motionNote: null,
    posterAdvice: null,
  };
}

const darkStill = join(work, 'dark.png');
const lightStill = join(work, 'light.png');
const thumb = join(work, 'thumb.png');
writeFileSync(darkStill, png(64, 36, (x, y) => [30 + x, 34 + y, 44]));
writeFileSync(lightStill, png(64, 36, (x, y) => [220 - x, 224 - y, 236]));
writeFileSync(thumb, png(32, 18, () => [90, 96, 110]));

const darkRecord = record({
  primary: '#1e2230',
  accent: '#c1764a',
  neutrals: ['#14161c', '#5a6070', '#e6e8ee'],
  secondaries: ['#8fb3d9', '#c1764a'],
  luma: 0.2,
  saturation: 'muted',
  temperature: 'warm',
  busyness: 'calm',
});
const lightRecord = record({
  primary: '#dfe3ec',
  accent: '#3f6fb0',
  neutrals: ['#f4f6fa', '#9aa3b4', '#22262f'],
  secondaries: ['#3f6fb0', '#b4551f'],
  luma: 0.82,
  saturation: 'balanced',
  temperature: 'cool',
  busyness: 'moderate',
});

const builtDark = buildSkin({
  record: darkRecord,
  meta: meta('img_demo-dark_1a2b3c4d', 'Demo Dark'),
  assets: { wallpaper: darkStill, thumb },
  outRoot: join(work, 'skins'),
});
const builtLight = buildSkin({
  record: lightRecord,
  meta: meta('img_demo-light_5e6f7a8b', 'Demo Light'),
  assets: { wallpaper: lightStill },
  outRoot: join(work, 'skins'),
});

const darkState = checkSkinDir(builtDark.dir);
const lightState = checkSkinDir(builtLight.dir);
check(darkState.problems.length === 0, 'a dark skin passes its own check', darkState.problems.join('; '));
check(lightState.problems.length === 0, 'a light skin passes its own check', lightState.problems.join('; '));

const darkTokens = JSON.parse(readFileSync(join(builtDark.dir, 'tokens.json'), 'utf8'));
const pairs = Object.entries(darkTokens.presentedTokens ?? {});
check(pairs.length >= 20, 'the token layer is complete', `${pairs.length} tokens`);
check(pairs.every(([, pair]) => typeof pair?.light === 'string' && typeof pair?.dark === 'string'), 'every token is a {light,dark} pair');
check(builtDark.spec.anchorScheme === 'dark' && builtLight.spec.anchorScheme === 'light', 'the anchor follows the measured luminance');

const lightSkin = JSON.parse(readFileSync(join(work, 'skins', 'img_demo-light_5e6f7a8b', 'skin.json'), 'utf8'));
check(lightSkin.assets.thumb === 'assets/wallpaper.png', 'thumb falls back to the wallpaper', lightSkin.assets.thumb);
check(lightSkin.assets.poster === 'assets/wallpaper.png', 'poster falls back to the wallpaper', lightSkin.assets.poster);

const css = readFileSync(join(builtDark.dir, 'theme.css'), 'utf8');
check(css.includes('[data-skin="img_demo-dark_1a2b3c4d"]'), 'the stylesheet is scoped to the skin id');

let rejected = false;
try {
  buildSkin({ record: darkRecord, meta: meta('not-a-skin-id', 'Bad'), assets: { wallpaper: darkStill }, outRoot: work });
} catch {
  rejected = true;
}
check(rejected, 'an invalid skin id is refused');

rmSync(work, { recursive: true, force: true });

const failed = results.filter((row) => !row.ok);
console.log(`\nchecks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  for (const row of failed) console.log(`FAILED ${row.label} ${row.detail}`);
  process.exitCode = 1;
}
