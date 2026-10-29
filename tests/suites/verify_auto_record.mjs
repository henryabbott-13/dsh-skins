/**
 * Does a panel-measured record actually produce a shippable skin?
 *
 * This closes the one loop the route harness cannot: the renderer's measurement
 * functions are extracted from the REAL `src/client.body.js`, fed synthetic
 * pixels, and their record is pushed through the REAL deriveDesign /
 * buildTokens / themeCss from `skin_derive.mjs` — including the same contrast
 * self-check `build_all_skins.mjs` runs before it writes anything.
 *
 * No spawn, no input files, no writes: it needs nothing the file sandbox blocks.
 *
 *   node output\_scan\verify_auto_record.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const BODY = join(root, 'output', 'plugin', 'dsh-skins', 'src', 'client.body.js');

const results = [];
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

/* ── the renderer's measurement code, taken verbatim from the source ───────── */
const body = readFileSync(BODY, 'utf8');
const start = body.indexOf('function rgbToHsl(');
const end = body.indexOf('/** Decode an image file and sample it down');
const api = new Function(`${body.slice(start, end)}; return { analyzeSample, pickPalette, buildRecord, hslToHex, rgbToHsl };`)();

/* ── the derivation the build itself uses ─────────────────────────────────── */
const derive = await import(pathToFileURL(join(root, 'output', '_scan', 'skin_derive.mjs')).href);
const { deriveDesign, buildTokens, themeCss } = derive;

/** A 64x64 synthetic background: a dark field, a saturated blob, and grain. */
function pixels({ base, blob, grain, size = 64 }) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      const inBlob = Math.abs(x - size * 0.35) < size * 0.18 && Math.abs(y - size * 0.4) < size * 0.22;
      const source = inBlob ? blob : base;
      const noise = ((x * 37 + y * 17) % 7) - 3;
      data[at] = source[0] + noise * grain;
      data[at + 1] = source[1] + noise * grain;
      data[at + 2] = source[2] + noise * grain;
      data[at + 3] = 255;
    }
  }
  return data;
}

/** Mirror of the `meta` object build_all_skins.mjs assembles before buildTokens. */
function metaFor(record, scan, spec) {
  return {
    skinId: scan.skinId,
    slug: scan.slug,
    name: 'Probe Measured Still',
    nameZh: '探针·实测',
    kind: scan.kind,
    source: scan.relPath,
    sourceBytes: scan.bytes,
    sourceSize: { width: scan.width, height: scan.height },
    durationSeconds: scan.durationSeconds ?? null,
    bitrateMbps: scan.bitrateMbps ?? null,
    analysisRecord: 'output/_scan/image_groups/group_e.json (auto-measured)',
    artwork: {
      primaryColor: record.primaryColor,
      secondaryColors: record.secondaryColors,
      accentColor: record.accentColor,
      neutrals: record.neutrals,
      temperature: record.temperature,
      saturation: record.saturation,
      luminance: record.luminance,
      contrast: record.contrast,
    },
    material: record.material,
    lighting: record.lighting,
    busyness: record.busyness,
    styleKeywords: record.styleKeywords ?? [],
    mood: record.mood ?? [],
    posterProvenance: '',
    frameCount: record.frameCount ?? null,
    sampledTimes: record.sampledTimes ?? null,
    frameDrift: record.frameDrift ?? null,
    motionNote: record.motionNote ?? null,
    posterAdvice: record.posterAdvice ?? null,
  };
}

/** The build's own gate, reproduced. */
function selfCheck(tokens) {
  const failures = [];
  for (const [key, value] of Object.entries(tokens.contrast?.wcag ?? {})) {
    const needsBody = key.includes('ink on') || key.includes('secondary on') || key.includes('button label');
    const needsGraphics = key.includes('accent on');
    if (needsBody && !value.bodyText) failures.push(`${key}=${value.ratio}`);
    if (needsGraphics && !value.graphics) failures.push(`${key}=${value.ratio}`);
  }
  return failures;
}

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([^)]+\))$/u;

function runCase(label, options, scan, measuredInput) {
  const stats = measuredInput === undefined ? api.analyzeSample(pixels(options), 64, 64) : null;
  const record = api.buildRecord(measuredInput ?? { native: { width: scan.width, height: scan.height }, stats }, scan);
  const spec = deriveDesign(record, scan);
  const tokens = buildTokens(spec, metaFor(record, scan, spec));
  const css = themeCss(spec, metaFor(record, scan, spec));

  console.log(`\n--- ${label} ---`);
  console.log(`    record: primary ${record.primaryColor} accent ${record.accentColor} luma ${record.luminance} ${record.temperature}/${record.saturation}/${record.busyness}`);
  console.log(`    skin:   anchor ${spec.anchorScheme} accent ${spec.light.accent} substituted=${spec.accentWasSubstituted} name=${record.firstImpression.slice(0, 28)}…`);

  const pairs = Object.entries(tokens.presentedTokens ?? {});
  check(pairs.length >= 20, `${label}: the token layer is complete`, `${pairs.length} tokens`);
  const malformed = pairs.filter(([, value]) => typeof value?.light !== 'string' || typeof value?.dark !== 'string');
  check(malformed.length === 0, `${label}: every presented token is a light/dark string pair`);
  const notColor = pairs.filter(([, value]) => !COLOR.test(value.light) || !COLOR.test(value.dark));
  check(notColor.length === 0, `${label}: every presented value is a CSS colour`, notColor.length === 0 ? '' : JSON.stringify(notColor[0]));
  // The shell paints its own surfaces from these, so the panel would vanish
  // behind an opaque background.
  const surfaces = pairs.filter(([name]) => name.includes('bg-base') || name.includes('bg-layer'));
  const opaque = surfaces.filter(([, value]) => /^#[0-9a-f]{6}$/u.test(value.dark) || !value.dark.includes('rgba'));
  check(surfaces.length > 0 && opaque.length === 0, `${label}: the shell's surfaces stay translucent`, `surfaces=${surfaces.length} opaque=${opaque.length}`);

  const failures = selfCheck(tokens);
  check(failures.length === 0, `${label}: the build's contrast self-check passes`, failures.join(', '));
  check(typeof css === 'string' && css.includes('--dsw-') && css.includes(`[data-skin="${scan.skinId}"]`), `${label}: theme.css is scoped and tokenised`, `${css.length} bytes`);
  check(typeof spec.light?.accent === 'string' && typeof spec.dark?.accent === 'string', `${label}: both schemes carry an accent`);
  return { record, spec, tokens };
}

/* ── the cases ────────────────────────────────────────────────────────────── */
check(api.hslToHex(0, 0, 0) === '#000000', 'hslToHex handles zero lightness', api.hslToHex(0, 0, 0));
check(api.hslToHex(0, 0, 1) === '#ffffff', 'hslToHex handles full lightness', api.hslToHex(0, 0, 1));

const imageScan = {
  kind: 'image',
  skinId: 'img_zzz-probe-panel_00000000',
  slug: 'zzz-probe-panel',
  hash8: '00000000',
  name: 'zzz_probe_panel.png',
  relPath: 'input_image/zzz_probe_panel.png',
  bytes: 12345,
  width: 320,
  height: 200,
};

runCase('dark image', { base: [28, 34, 52], blob: [200, 40, 120], grain: 9 }, imageScan);
runCase('bright image', { base: [232, 236, 240], blob: [90, 160, 210], grain: 6 }, imageScan);
runCase('warm muted image', { base: [64, 46, 38], blob: [160, 96, 52], grain: 4 }, imageScan);

const videoScan = {
  kind: 'video',
  skinId: 'video_zzz-probe-clip_00000000',
  slug: 'zzz-probe-clip',
  hash8: '00000000',
  name: 'zzz_probe_clip.mp4',
  relPath: 'input_video/zzz_probe_clip.mp4',
  bytes: 999999,
  width: 1920,
  height: 1080,
  durationSeconds: 12.5,
  bitrateMbps: 24,
};
const frameStats = (options) => api.analyzeSample(pixels(options), 64, 64);
const frames = [
  frameStats({ base: [30, 30, 44], blob: [180, 60, 90], grain: 8 }),
  frameStats({ base: [70, 60, 90], blob: [200, 90, 140], grain: 8 }),
];
const videoStats = Object.assign({}, frames[0], {
  luminance: (frames[0].luminance + frames[1].luminance) / 2,
  contrast: (frames[0].contrast + frames[1].contrast) / 2,
  saturation: (frames[0].saturation + frames[1].saturation) / 2,
  warmth: (frames[0].warmth + frames[1].warmth) / 2,
  edgeEnergy: (frames[0].edgeEnergy + frames[1].edgeEnergy) / 2,
  buckets: [...frames[0].buckets, ...frames[1].buckets].sort((a, b) => b.share - a.share).slice(0, 40),
});
const video = runCase('video frames', {}, videoScan, {
  native: { width: 1920, height: 1080, duration: 12.5 },
  stats: videoStats,
  frames,
  times: [1, 4.4],
  bestIndex: 0,
  bestTime: 1,
});
check(video.record.frameCount === 2 && Array.isArray(video.record.sampledTimes), 'the video record keeps its sampled times', JSON.stringify(video.record.sampledTimes));
check(typeof video.record.frameDrift === 'string' && video.record.motionNote.length > 0, 'the video record reports drift and a motion note', `${video.record.frameDrift}`);

const failed = results.filter((row) => !row.ok);
console.log(`\nchecks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  for (const row of failed) console.log(`FAILED ${row.label} ${row.detail}`);
  process.exitCode = 1;
}
