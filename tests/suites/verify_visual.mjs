/**
 * Phase-2 verification: live UI colours, real-time filters, mouse parallax.
 *
 * The important half is the contrast guarantee. The live token layer is derived
 * from pixels, so unlike the build-time palette it cannot be eyeballed once and
 * trusted — every background polarity has to clear its floors. This feeds the
 * REAL `deriveLiveTokens` (extracted verbatim from `src/client.body.js`) a table
 * of synthetic backgrounds and asserts the WCAG floors on each one, including
 * the case the brief called out: a background that is too light must move the
 * text to dark ink.
 *
 * It also checks that the layer covers exactly the token set the shipped skins
 * cover (so it is a drop-in replacement), that the filter string composes in the
 * right order, that the posterize levels are monotonic, and that the parallax
 * offset can never exceed the 10px ceiling.
 *
 *   node output\_scan\verify_visual.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const BODY = join(root, 'output', 'plugin', 'dsh-skins', 'src', 'client.body.js');
const body = readFileSync(BODY, 'utf8');

const results = [];
const record = (ok, label, detail = '') => {
  results.push({ ok, label, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

/** Cut from the first marker to just before the second, on clean comment bounds. */
const sliceBetween = (from, to) => {
  const start = body.indexOf(from);
  const end = body.lastIndexOf('/*', body.indexOf(to));
  if (start === -1 || end === -1 || end <= start) throw new Error(`could not slice ${from} .. ${to}`);
  return body.slice(start, end);
};

/* ── assemble the pure code under test ────────────────────────────────────── */
const knobs = sliceBetween('const DEFAULT_TWEAKS', ' * A tiny subscribable view model');
const maths = sliceBetween('function rgbToHsl(', '/** Decode an image file and sample it down');
const layer = sliceBetween('/** The CSS `filter` list the current knobs describe.', 'function ensurePosterizeFilter');
const parallax = sliceBetween('function setParallax', 'function installParallax');

const storage = new Map();
const windowStub = {
  innerWidth: 1000,
  innerHeight: 800,
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
};
const documentStub = { getElementById: () => null, createElementNS: () => ({ setAttribute: () => {}, append: () => {}, style: {} }) };

let api;
try {
  api = new Function(
    'window',
    'document',
    'react',
    // The slice starts below the top-of-file constants, so the few it reads at
    // construction time are supplied here.
    'const ROUTE = "/dsh-skins"; const PACKAGE_ID = "dsh-plugin-skins"; const STYLE_ATTRIBUTE = "data-plugin-css";\n' +
      `${knobs}\n${maths}\n${layer}\n${parallax}\nfunction applyLayerTweaks(){}\n` +
      'return { deriveLiveTokens, liveAccent, contrastRatio, mixHex, rgbaOf, layerFilter, posterizeLevels, setParallax, tweakSliders, analyzeSample, PARALLAX_MAX_X, PARALLAX_MAX_Y, PARALLAX_TILT_DEG, POSTERIZE_FILTER_ID, DEFAULT_TWEAKS, TWEAK_LIMITS };',
  )(windowStub, documentStub, { createElement: () => null });
} catch (error) {
  record(false, 'the phase-2 helpers evaluate standalone', String(error.message));
  process.exit(1);
}

/* ── 1. the contrast guarantee ────────────────────────────────────────────── */
const measured = (row) => ({
  luminance: row.luma,
  luminanceP10: row.p10 ?? Math.max(0, row.luma - 0.2),
  luminanceP22: row.p22,
  luminanceP78: row.p78,
  luminanceP90: row.p90 ?? Math.min(1, row.luma + 0.2),
  artworkHue: row.hue ?? 0.6,
  artworkSat: row.sat ?? 0.25,
  accentHue: row.accentHue ?? 0.58,
  accentSat: row.accentSat ?? 0.7,
  accentLightness: row.accentL ?? 0.5,
  temperature: row.temp ?? 'neutral',
});

const backgrounds = [
  { name: '很亮的背景', luma: 0.88, p22: 0.78, p78: 0.96, p10: 0.7, p90: 0.98, temp: 'warm' },
  { name: '纯白', luma: 1, p22: 1, p78: 1, p10: 1, p90: 1 },
  { name: '亮冷背景', luma: 0.72, p22: 0.6, p78: 0.85, p10: 0.5, p90: 0.9, hue: 0.55, sat: 0.3, accentHue: 0.52, temp: 'cool' },
  { name: '中间灰', luma: 0.5, p22: 0.35, p78: 0.66, p10: 0.25, p90: 0.75 },
  { name: '很暗的背景', luma: 0.12, p22: 0.04, p78: 0.22, p10: 0.0, p90: 0.3, temp: 'cool' },
  { name: '纯黑', luma: 0, p22: 0, p78: 0, p10: 0, p90: 0 },
  { name: '高对比黑白', luma: 0.45, p22: 0.05, p78: 0.9, p10: 0.0, p90: 0.98 },
];

const derived = new Map();
for (const row of backgrounds) {
  const output = api.deriveLiveTokens(measured(row), {});
  derived.set(row.name, output);
  const check = output.check;
  record(check.text >= 4.5, `${row.name}：正文对比 ≥ 4.5:1`, `${check.text}:1（${output.scheme} 面板 α ${output.alpha}）`);
  record(check.secondary >= 4.5, `${row.name}：次级文字对比 ≥ 4.5:1`, `${check.secondary}:1`);
  record(check.tertiary >= 3, `${row.name}：三级文字对比 ≥ 3:1`, `${check.tertiary}:1`);
  record(check.accentOnSurface >= 3, `${row.name}：强调色对面板 ≥ 3:1`, `${check.accentOnSurface}:1`);
  record(check.inkOnAccent >= 4.5, `${row.name}：按钮文字对强调色 ≥ 4.5:1`, `${check.inkOnAccent}:1`);
  record(output.degraded === false, `${row.name}：不需要降级`, String(output.degraded));
}

// The explicit requirement from the brief.
for (const bright of ['很亮的背景', '纯白', '亮冷背景']) {
  const output = derived.get(bright);
  record(output.scheme === 'light', `${bright}：自动选择浅色面板`, output.scheme);
  record(output.ink === '#10131a', `${bright}：文字自动转为深色`, output.ink);
}
for (const dark of ['很暗的背景', '纯黑']) {
  const output = derived.get(dark);
  record(output.scheme === 'dark', `${dark}：自动选择深色面板`, output.scheme);
  record(output.ink === '#f2f2f5', `${dark}：文字自动转为浅色`, output.ink);
}
// A bright frame must never keep an almost-opaque dark panel instead: the whole
// point of the layer is following the wallpaper, not hiding it.
record(derived.get('很亮的背景').alpha <= 0.5, '亮背景不会为了对比把面板变得不透明', String(derived.get('很亮的背景').alpha));

/* ── 2. the layer is a drop-in replacement for a shipped palette ──────────── */
const skinsDir = join(root, 'output', 'skins');
const sampleSkin = readdirSync(skinsDir).find((name) => name.startsWith('img_'));
const shipped = JSON.parse(readFileSync(join(skinsDir, sampleSkin, 'tokens.json'), 'utf8'));
const shippedKeys = Object.keys(shipped.presentedTokens).sort();
const liveKeys = Object.keys(derived.get('中间灰').tokens).sort();
record(
  liveKeys.length === shippedKeys.length && liveKeys.every((key, index) => key === shippedKeys[index]),
  'the live layer covers exactly the token set the shipped skins cover',
  `${liveKeys.length} tokens`,
);
const live = derived.get('中间灰');
const badValues = Object.entries(live.tokens).filter(([, value]) => !/^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, [\d.]+\))$/u.test(value.light) || value.light !== value.dark);
record(badValues.length === 0, 'every token is a legal colour and both preference slots agree', badValues.length === 0 ? '' : JSON.stringify(badValues[0]));
const opaqueSurfaces = Object.entries(live.tokens).filter(([key, value]) => (key.includes('bg-base') || key.includes('bg-layer') || key.includes('sidebar-fill')) && !value.light.startsWith('rgba'));
record(opaqueSurfaces.length === 0, 'the shell surfaces stay translucent so the wallpaper shows', opaqueSurfaces.length === 0 ? '' : JSON.stringify(opaqueSurfaces[0]));
record(/^rgba/u.test(live.tokens['--dsw-alias-interactive-bg-hover'].light), 'hover fill is derived from the accent at an alpha');
record(live.tokens['--dsw-alias-brand-primary'].light === live.tokens['--dsw-alias-link'].light, 'the accent and the link colour stay one value (the shipped rule)');

/* ── 3. the filter string ─────────────────────────────────────────────────── */
record(
  api.layerFilter({ blur: 0, grayscale: 0, saturate: 100, contrast: 100, posterize: 0 }) === 'none',
  'neutral knobs produce no filter at all',
);
const full = api.layerFilter({ blur: 6, grayscale: 40, saturate: 150, contrast: 120, posterize: 60 });
record(
  full === 'blur(6px) grayscale(40%) saturate(150%) contrast(120%) url(#dsh-skin-posterize)',
  'all four filters compose in one declaration, posterize last',
  full,
);
record(api.layerFilter({ blur: 0, grayscale: 0, saturate: 100, contrast: 130, posterize: 0 }) === 'contrast(130%)', 'a single filter needs no separators');
record(api.posterizeLevels(0) === 0, 'posterize 0 is off', String(api.posterizeLevels(0)));
record(api.posterizeLevels(100) === 2, 'posterize 100 is the hardest banding', String(api.posterizeLevels(100)));
record(api.posterizeLevels(50) === 17, 'posterize 50 is mid-way', String(api.posterizeLevels(50)));
record(
  api.posterizeLevels(10) > api.posterizeLevels(50) && api.posterizeLevels(50) > api.posterizeLevels(90),
  'more slider means fewer tonal steps',
);

/* ── 4. the parallax ceiling ──────────────────────────────────────────────── */
const state = { parallax: { x: 0, y: 0 } };
const offsets = [];
for (const [x, y] of [[0, 0], [1000, 800], [-500, -400], [-99999, 99999], [500, 400]]) {
  api.setParallax(state, x, y);
  offsets.push({ x, y, dx: state.parallax.x, dy: state.parallax.y });
}
record(api.PARALLAX_MAX_X <= 10 && api.PARALLAX_MAX_Y <= 10, 'both parallax ceilings are at or under 10px', `${api.PARALLAX_MAX_X}/${api.PARALLAX_MAX_Y}`);
const beyond = offsets.filter((row) => Math.abs(row.dx) > 10 || Math.abs(row.dy) > 10);
record(beyond.length === 0, 'no pointer position can push the frame past 10px', JSON.stringify(offsets.map((row) => [row.dx, row.dy])));
record(offsets.some((row) => row.dx > 0) && offsets.some((row) => row.dx < 0), 'the offset moves both ways around the window centre');
record(api.PARALLAX_TILT_DEG <= 1, 'the tilt stays subtle', `${api.PARALLAX_TILT_DEG}deg`);

/* ── 5. the knobs' defaults and ranges ────────────────────────────────────── */
const fresh = api.tweakSliders({ tweaks: {} }, 'skin-a');
record(
  fresh.grayscale === 0 && fresh.saturate === 100 && fresh.contrast === 100 && fresh.posterize === 0,
  'the filter defaults are neutral',
  JSON.stringify({ grayscale: fresh.grayscale, saturate: fresh.saturate, contrast: fresh.contrast, posterize: fresh.posterize }),
);
record(fresh.parallax === false && fresh.uiFollow === false, 'both switches default to off');
const booleans = ['parallax', 'uiFollow'].every((key) => api.DEFAULT_TWEAKS[key] === false);
record(booleans, 'the stored defaults are booleans, not the strings a slider would leave behind');
const coerced = api.tweakSliders({ tweaks: { 'skin-a': { parallax: 'true', uiFollow: 1, grayscale: 999, saturate: -5 } } }, 'skin-a');
record(coerced.parallax === false && coerced.uiFollow === false, 'a non-boolean stored value is not read as on', JSON.stringify({ parallax: coerced.parallax, uiFollow: coerced.uiFollow }));
record(coerced.grayscale === 100 && coerced.saturate === 0, 'out-of-range filters clamp to their sliders', JSON.stringify({ grayscale: coerced.grayscale, saturate: coerced.saturate }));

/* ── 6. the percentiles the derivation depends on ─────────────────────────── */
const size = 32;
const pixels = new Uint8ClampedArray(size * size * 4);
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const value = Math.round((x / (size - 1)) * 255);
    const at = (y * size + x) * 4;
    pixels[at] = value;
    pixels[at + 1] = value;
    pixels[at + 2] = value;
    pixels[at + 3] = 255;
  }
}
const stats = api.analyzeSample(pixels, size, size);
record(
  stats.luminanceP10 <= stats.luminanceP22 && stats.luminanceP22 <= stats.luminanceP78 && stats.luminanceP78 <= stats.luminanceP90,
  'the percentiles are ordered',
  `${stats.luminanceP10.toFixed(3)} ≤ ${stats.luminanceP22.toFixed(3)} ≤ ${stats.luminanceP78.toFixed(3)} ≤ ${stats.luminanceP90.toFixed(3)}`,
);
record(stats.luminanceP10 < 0.25 && stats.luminanceP90 > 0.75, 'a black-to-white gradient spans the range', `${stats.luminanceP10.toFixed(2)}..${stats.luminanceP90.toFixed(2)}`);
record(Math.abs(stats.luminance - 0.5) < 0.06, 'the mean sits in the middle of a symmetric gradient', stats.luminance.toFixed(3));

const failed = results.filter((row) => !row.ok);
console.log(`\nchecks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  for (const row of failed) console.log(`FAILED ${row.label} ${row.detail}`);
  process.exitCode = 1;
}
