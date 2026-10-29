/**
 * Phase-3 verification: the video-only controls.
 *
 * The load-bearing requirement is *hiding*: the transport and the audio switch
 * must not exist for an image background. Asserting that by grepping the source
 * would only prove a guard is written somewhere, so this renders the REAL
 * `SkinsPanel` — extracted verbatim from `src/client.body.js`, with React stubbed
 * by a recorder — and walks the returned element tree twice: once with an image
 * skin in the catalog, once with a video skin. The video group is then either
 * present with all its controls, or absent entirely.
 *
 * It also checks the transport helpers (rate snapping, mute-before-play) and the
 * pulse wiring (a variable-based filter term, a lazily created graph, ceiling
 * values that stay slight).
 *
 *   node output\_scan\verify_video.mjs
 */
import { readFileSync } from 'node:fs';
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
  const fromIndex = body.indexOf(from);
  // Both ends are pulled back to a comment opener: a marker that sits inside a
  // banner comment would otherwise leave an unterminated comment in the slice.
  const start = fromIndex === -1 ? -1 : body.lastIndexOf('/*', fromIndex);
  const end = body.lastIndexOf('/*', body.indexOf(to));
  if (start === -1 || end === -1 || end <= start) throw new Error(`could not slice ${from} .. ${to}`);
  return body.slice(start, end);
};

const knobs = sliceBetween('/** Route prefix owned by the host half.', ' * A tiny subscribable view model');
const layer = sliceBetween('/** The CSS `filter` list the current knobs describe.', '/** How many tonal steps the posterize slider asks for');
const panel = sliceBetween(' * Panel components', 'function panelGlyph');

/* ── a React stub that renders the tree instead of mounting it ────────────── *
 * Function components ARE invoked, and `children` is passed through `props`
 * exactly as React does — otherwise a component like `Section` (which reads
 * `props.children`) would render nothing and the assertions below would pass for
 * the wrong reason.
 * ------------------------------------------------------------------------- */
const createElement = (type, props, ...children) => {
  const merged = Object.assign({}, props ?? {});
  if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
  if (typeof type === 'function') return { type: type.name || 'Anonymous', props: merged, children: [type(merged)] };
  return { type, props: merged, children };
};
const reactStub = {
  createElement,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
};

/** Everything the panel reaches for that lives outside the two extracted slices. */
const stubs = `
function useView(store) { return store.view; }
function publish() {}
function applyById() {}
function startGenerate() {}
function refreshLiveTokens() {}
function applyLayerTweaks() {}
`;

const storage = new Map();
const windowStub = {
  localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  innerWidth: 1000,
  innerHeight: 800,
};

let api;
try {
  api = new Function(
    'window',
    'document',
    'react',
    `${knobs}\n${layer}\n${panel}\n${stubs}\n` +
      'return { SkinsPanel, layerFilter, nearestRate, tweakSliders, VIDEO_RATES, AUDIO_SCALE_MAX, AUDIO_BRIGHTNESS_MAX, AUDIO_SCALE_VAR, AUDIO_BRIGHTNESS_VAR };',
  )(windowStub, { querySelector: () => null, createElement: () => ({ style: {} }), head: { append: () => {} }, documentElement: { style: { setProperty: () => {}, removeProperty: () => {} } } }, reactStub);
} catch (error) {
  record(false, 'the panel evaluates standalone', String(error.message));
  process.exit(1);
}

/* ── walk the recorded tree ───────────────────────────────────────────────── */
const walk = (node, visit) => {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ text: String(node) });
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  walk(node.children, visit);
};
const textsOf = (tree) => {
  const out = [];
  walk(tree, (node) => {
    if (typeof node.text === 'string') out.push(node.text);
  });
  return out;
};
const classNamesOf = (tree) => {
  const out = [];
  walk(tree, (node) => {
    if (typeof node.props?.className === 'string') out.push(node.props.className);
  });
  return out;
};
/** The text inside every button, so a readout next to the buttons cannot be mistaken for one. */
const buttonTexts = (tree) => {
  const out = [];
  walk(tree, (node) => {
    if (node.type !== 'button') return;
    const parts = [];
    walk(node.children, (child) => {
      if (typeof child.text === 'string') parts.push(child.text);
    });
    out.push(parts.join(''));
  });
  return out;
};

const viewFor = (skin) => ({
  version: 1,
  revision: 'x',
  uiVersion: 'x',
  catalog: { ok: true, counts: { total: 1, image: skin.type === 'image' ? 1 : 0, video: skin.type === 'video' ? 1 : 0 }, skins: [skin] },
  catalogError: null,
  skinId: skin.skinId,
  tweaks: { blur: 0, opacity: 1, veil: 1 },
  slider: { blur: 0, opacity: 100, veil: 100, grayscale: 0, saturate: 100, contrast: 100, posterize: 0, parallax: false, uiFollow: false, videoPlaying: true, videoMuted: true, videoRate: 1, audioReactive: false },
  favorites: [],
  filters: { query: '', type: 'all', tags: [], favoriteOnly: false },
  tags: [],
  job: null,
  hostRevision: 'x',
  staleHost: false,
  panelReady: true,
  panelError: null,
  shortcutMode: 'service',
  shortcutKeys: { toggle: 'Ctrl+Shift+B', random: 'Ctrl+Shift+R' },
  tokenSource: 'skin',
  liveTokensNote: null,
  liveTokensCheck: null,
  liveTokensSource: null,
  parallaxOn: false,
  reducedMotion: false,
  videoPlaying: true,
  videoMuted: true,
  videoRate: 1,
  videoHasAudio: null,
  videoSilent: null,
  videoNote: null,
  audioReactiveOn: false,
  audioLevel: 0,
});

const imageSkin = { skinId: 'img_a', name: 'Still', nameZh: '静帧', type: 'image', assets: {}, styleKeywords: [], mood: [], design: '' };
const videoSkin = { skinId: 'video_a', name: 'Motion', nameZh: '动态', type: 'video', assets: {}, styleKeywords: [], mood: [], design: '', video: { src: '/x.mp4', durationSeconds: 5 } };

const renderPanel = (skin, overrides) => {
  const view = Object.assign(viewFor(skin), overrides ?? {});
  const store = { view, tweaks: {}, catalog: view.catalog, filters: view.filters, favorites: [], job: null, listeners: new Set() };
  return api.SkinsPanel({ store, ctx: { get: () => undefined, theme: { overrideTokens: () => () => {} } } });
};

let imageTree;
let videoTree;
try {
  imageTree = renderPanel(imageSkin);
  videoTree = renderPanel(videoSkin);
} catch (error) {
  record(false, 'the panel renders with a stubbed React', String(error.message));
  process.exit(1);
}

/* ── 1. the group exists for video only ───────────────────────────────────── */
const videoGroup = classNamesOf(videoTree).filter((name) => name.includes('dsh-skins-video'));
const imageGroup = classNamesOf(imageTree).filter((name) => name.includes('dsh-skins-video'));
record(videoGroup.length === 1, 'a video background renders exactly one video group', String(videoGroup.length));
record(imageGroup.length === 0, 'an image background renders no video group at all', String(imageGroup.length));

const videoLabels = ['视频控制', '播放速度', '音频律动'];
for (const label of videoLabels) {
  record(textsOf(videoTree).includes(label), `the video panel offers 「${label}」`);
  record(!textsOf(imageTree).includes(label), `「${label}」 is absent for an image background`);
}
record(textsOf(videoTree).some((text) => text.includes('暂停')) || textsOf(videoTree).some((text) => text.includes('播放')), 'the transport offers play/pause');
record(textsOf(videoTree).some((text) => text.includes('静音')) || textsOf(videoTree).some((text) => text.includes('有声')), 'the transport offers a mute switch');
const rates = api.VIDEO_RATES.map((rate) => rate + 'x');
const videoButtons = buttonTexts(videoTree);
const rateButtons = videoButtons.filter((text) => rates.includes(text));
record(rateButtons.length === api.VIDEO_RATES.length, 'every offered speed is its own button', rateButtons.join(' '));
record(api.VIDEO_RATES.every((rate) => videoButtons.includes(rate + 'x')), 'the speeds are offered as buttons, not only as a readout');
record(!buttonTexts(imageTree).some((text) => rates.includes(text)), 'no speed buttons leak into an image background');
record(api.VIDEO_RATES[0] === 0.5 && api.VIDEO_RATES[api.VIDEO_RATES.length - 1] === 2, 'the speeds span 0.5x to 2x', api.VIDEO_RATES.join(', '));

// The audio switch must be discoverable as a switch, not a plain button.
const switches = (tree) => {
  const out = [];
  walk(tree, (node) => {
    if (node.props?.role === 'switch' && typeof node.props['aria-label'] === 'string') out.push(node.props['aria-label']);
  });
  return out;
};
record(switches(videoTree).includes('音频律动'), '音频律动 is a real switch', switches(videoTree).join(', '));
record(!switches(imageTree).includes('音频律动'), 'the audio switch is absent for an image background');
record(!switches(videoTree).includes('UI颜色跟随背景') === false, 'the general switches are still there for video');

// The reduced-motion policy must be visible rather than silently ignored.
const stillTree = renderPanel(videoSkin, { reducedMotion: true });
const playButtonDisabled = (() => {
  let found = false;
  walk(stillTree, (node) => {
    if (node.type === 'button' && typeof node.props?.disabled === 'boolean' && node.props.disabled === true) found = true;
  });
  return found;
})();
record(playButtonDisabled, 'with reduced motion the transport is visibly disabled');

/* ── 2. the transport helpers ─────────────────────────────────────────────── */
const snap = [
  [0.6, 0.5], [1.9, 2], [1.1, 1], [0.8, 0.75], ['1.25', 1.25], [Number.NaN, 1], [undefined, 1], [99, 2],
];
const snapped = snap.map(([input, expected]) => [input, api.nearestRate(input), expected]);
const snapFailures = snapped.filter(([, actual, expected]) => actual !== expected);
record(snapFailures.length === 0, 'a stored speed snaps onto an offered step', snapFailures.length === 0 ? '' : JSON.stringify(snapFailures));

const fresh = api.tweakSliders({ tweaks: {} }, 'video');
record(fresh.videoPlaying === true, 'a fresh video starts playing');
record(fresh.videoMuted === true, 'a fresh video starts muted, which is what autoplay admission checks', String(fresh.videoMuted));
record(fresh.videoRate === 1, 'a fresh video plays at 1x');
record(fresh.audioReactive === false, 'the pulse is off by default');
const coerced = api.tweakSliders({ tweaks: { video: { videoMuted: 'yes', videoRate: 1.2, audioReactive: 1 } } }, 'video');
record(coerced.videoMuted === true && coerced.audioReactive === false, 'a non-boolean stored value is not read as on', JSON.stringify({ muted: coerced.videoMuted, audio: coerced.audioReactive }));
record(coerced.videoRate === 1.25, 'a hand-edited speed is snapped', String(coerced.videoRate));

/* ── 3. the pulse wiring ──────────────────────────────────────────────────── */
const neutral = { blur: 0, grayscale: 0, saturate: 100, contrast: 100, posterize: 0 };
record(api.layerFilter(neutral, true).includes('brightness(var(' + api.AUDIO_BRIGHTNESS_VAR), 'the pulse adds a variable brightness term', api.layerFilter(neutral, true));
record(!api.layerFilter(neutral, false).includes('brightness'), 'without the pulse no brightness term is written');
const withPosterize = api.layerFilter({ ...neutral, posterize: 60 }, true);
record(
  withPosterize.indexOf('brightness') < withPosterize.indexOf('url(#'),
  'the pulse lands before the posterize filter, so banding still reacts',
  withPosterize,
);
record(api.AUDIO_SCALE_MAX <= 0.03 && api.AUDIO_BRIGHTNESS_MAX <= 0.2, 'the pulse ceilings stay slight', `${api.AUDIO_SCALE_MAX} / ${api.AUDIO_BRIGHTNESS_MAX}`);
record(body.includes('scale(var(" + AUDIO_SCALE_VAR'), 'the scale part of the pulse is also a variable');
record(body.includes('requestAnimationFrame') && body.includes('state.audioFrame'), 'the pulse runs on an animation frame');
record(body.includes('MediaElementAudioSourceNode') || body.includes('createMediaElementSource'), 'the amplitude comes from a real audio graph');
record(body.includes('existingGraph.element === video'), 'the graph is created once per element, as the platform requires');
record(body.includes('graph.gain.gain.value = wanted.videoMuted ? 0 : 1'), "once routed, the gain node is the audible authority (Chromium bypasses the element's own mute)");
record(body.includes('await graph.context.resume()'), 'a suspended audio context is resumed from the switch gesture');
record(body.indexOf('video.muted = wanted.videoMuted') !== -1 && body.indexOf('video.muted = wanted.videoMuted') < body.indexOf('const attempt = video.play()'), 'mute is set before the play attempt');
record(body.includes('AUDIO_SILENCE_FRAMES'), 'a silent analyser is reported instead of looking broken');
const loopBody = body.slice(body.indexOf('function startAudioLoop'), body.indexOf('async function applyAudioReactive'));
const publishes = (loopBody.match(/publish\(state, \{\}\)/gu) ?? []).length;
record(publishes === 2, 'the loop publishes only on the two silence-verdict flips, never per frame', `${publishes} publish calls`);
record(body.includes('"play", "pause", "ratechange", "volumechange"'), 'the element keeps the panel truthful about transport state');

const failed = results.filter((row) => !row.ok);
console.log(`\nchecks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  for (const row of failed) console.log(`FAILED ${row.label} ${row.detail}`);
  process.exitCode = 1;
}
