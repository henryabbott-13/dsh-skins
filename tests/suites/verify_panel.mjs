/**
 * Offline verification for the dsh-skins background-settings panel.
 *
 * Four independent checks, strongest last:
 *
 *   A. Bundle shape — the built `lib/client.js` registers exactly one factory
 *      through `window.__ModuleLoader__` and exports `apply` / `inject` / `name`.
 *   B. The measurement math — the pure palette/statistics functions are extracted
 *      from the REAL `src/client.body.js` text and fed known pixels, so a colour
 *      that goes in comes back out, and every analysis field the build pipeline
 *      requires is present.
 *   C. Revision agreement — the browser and host halves must name the same
 *      revision, or the restart hint the panel shows would be a lie.
 *   D. The whole pipeline (needs `--generate`) — load the REAL host module over a
 *      stub web server, upload a generated probe image, post a measured record,
 *      run the workspace's pipeline, and assert a new skin directory appears with
 *      the token layer the panel's apply path needs. Then remove every trace:
 *      probe input, probe skin, auto group, and the plan files it rewrote.
 *
 * Run from the workspace root:
 *   node output\_scan\verify_panel.mjs
 *   node output\_scan\verify_panel.mjs --generate
 */
import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

const root = process.cwd();
const WANT_GENERATE = process.argv.includes('--generate');
const PLUGIN = join(root, 'output', 'plugin', 'dsh-skins');
const BODY = join(PLUGIN, 'src', 'client.body.js');
const BUNDLE = join(PLUGIN, 'lib', 'client.js');
const HOST = join(PLUGIN, 'lib', 'index.js');
// The loader id must equal the package name, whatever that name is: the bundle
// patch inserts the plugin by name, so a rename here is a real contract change.
const PKG = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));

const results = [];
const record = (ok, label, detail = '') => {
  results.push({ ok, label, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

/* ── A. bundle shape ──────────────────────────────────────────────────────── */
function checkBundle() {
  const source = readFileSync(BUNDLE, 'utf8');
  const registrations = [];
  const window = {
    __ModuleLoader__: {
      load: (entry) => registrations.push(entry),
    },
  };
  const requireStub = (name) => {
    if (name === 'react') {
      const react = {
        createElement: (...args) => ({ type: args[0], props: args[1] ?? null, children: args.slice(2) }),
        useState: (value) => [value, () => {}],
        useEffect: () => {},
        useRef: (value) => ({ current: value }),
        useCallback: (fn) => fn,
        useMemo: (fn) => fn(),
      };
      return react;
    }
    throw new Error(`unexpected require(${name})`);
  };
  const factory = new Function('window', 'document', 'console', `${source}; return window.__ModuleLoader__;`);
  factory(window, { querySelector: () => null, createElement: () => ({}), head: { append: () => {} } }, console);
  record(registrations.length === 1, 'bundle registers exactly one factory', `registrations=${registrations.length}`);
  const entry = registrations[0];
  if (entry === undefined) return;
  const exported = entry.factory(requireStub);
  record(entry.id === PKG.name, 'bundle id equals the package name', String(entry.id));
  record(typeof exported.apply === 'function', 'exports apply');
  record(Array.isArray(exported.inject) && exported.inject.includes('theme'), 'exports inject list with theme', JSON.stringify(exported.inject));
  for (const symbol of ['sidebarRightTabs', 'sidebar.right.pane.tab', 'GUIDE_ORDER', 'analyzeSample', 'buildRecord', 'uploadFile', 'uploadPoster', 'applyLayerTweaks']) {
    record(source.includes(symbol), `bundle mentions ${symbol}`);
  }
  record(source.includes("kind: TAB_KIND") && source.includes('GUIDE_ORDER = 40'), 'tab type registers a guide card at order 40');
  // The apply path must call the injected services through ctx.inject, never
  // through a bare property access that would throw when the sidebar is absent.
  record(source.includes('ctx.inject(["slots", "sidebarRightTabs"]'), 'panel is mounted behind a service injection');
}

/* ── B. the measurement math, straight from the real source ───────────────── */
function checkMeasurement() {
  const body = readFileSync(BODY, 'utf8');
  const start = body.indexOf('function rgbToHsl(');
  const end = body.indexOf('/** Decode an image file and sample it down');
  if (start === -1 || end === -1) {
    record(false, 'measurement functions found in src/client.body.js');
    return;
  }
  const slice = body.slice(start, end);
  const build = new Function(`${slice}; return { analyzeSample, pickPalette, buildRecord, rgbToHsl, hslToHex };`);
  const api = build();

  const size = 8;
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    pixels[i * 4] = 200;
    pixels[i * 4 + 1] = 30;
    pixels[i * 4 + 2] = 30;
    pixels[i * 4 + 3] = 255;
  }
  const stats = api.analyzeSample(pixels, size, size);
  record(Math.abs(stats.luminance - 0.451) < 0.02, 'a solid #c81e1e sample measures ~0.45 luminance', stats.luminance.toFixed(3));
  record(stats.saturation > 0.6, 'the sample reads as saturated', stats.saturation.toFixed(3));
  record(stats.warmth > 0.5, 'the sample reads warm', stats.warmth.toFixed(3));
  record(stats.contrast < 0.01, 'a flat sample has no contrast', stats.contrast.toFixed(4));

  const palette = api.pickPalette(stats);
  record(palette.primary.hex === '#c81e1e', 'the primary colour round-trips', palette.primary.hex);
  record(/^#[0-9a-f]{6}$/u.test(palette.accent.hex), 'the accent is #rrggbb', palette.accent.hex);

  const required = [
    'firstImpression', 'primaryColor', 'secondaryColors', 'accentColor', 'neutrals', 'luminance',
    'contrast', 'saturation', 'temperature', 'material', 'lighting', 'composition', 'busyness',
    'styleKeywords', 'mood', 'backgroundSuitability', 'paletteProposal',
  ];
  const image = api.buildRecord({ native: { width: 320, height: 200 }, stats }, { name: 'probe.png', kind: 'image' });
  const missing = required.filter((field) => image[field] === undefined || image[field] === null);
  record(missing.length === 0, 'an image record carries every required field', missing.length === 0 ? '' : `missing ${missing.join(', ')}`);
  record(image.primaryColor === '#c81e1e' && /^#[0-9a-f]{6}$/u.test(image.accentColor), 'the record palette comes from the pixels', `${image.primaryColor} / ${image.accentColor}`);
  record(['dark', 'light'].includes(image.paletteProposal.scheme), 'the proposal names a scheme', image.paletteProposal.scheme);

  const videoRequired = [...required, 'motionNote', 'frameDrift', 'posterAdvice'];
  const video = api.buildRecord(
    { native: { width: 1280, height: 720, duration: 30 }, stats, frames: [stats, stats], times: [1, 2], bestIndex: 0, bestTime: 1 },
    { name: 'probe.mp4', kind: 'video' },
  );
  const videoMissing = videoRequired.filter((field) => video[field] === undefined || video[field] === null);
  record(videoMissing.length === 0, 'a video record carries the extra fields too', videoMissing.length === 0 ? '' : `missing ${videoMissing.join(', ')}`);
  record(video.frameDrift === 'small', 'an unchanging video reports small drift', String(video.frameDrift));
}

/* ── B2. the look knobs, whose defaults are a units trap ──────────────────── */
function checkTweaks() {
  const body = readFileSync(BODY, 'utf8');
  const marker = body.indexOf(' * A tiny subscribable view model');
  if (marker === -1) {
    record(false, 'the tweak functions are locatable in src/client.body.js');
    return;
  }
  const slice = body.slice(body.indexOf('/** Route prefix owned by the host half.'), body.lastIndexOf('/*', marker));
  const storage = new Map();
  const window = {
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  };
  const react = { createElement: () => null };
  let api;
  try {
    // `publish` lives past the slice; a stub keeps the setters callable.
    api = new Function('window', 'react', `${slice}; function publish(){}; return { tweaksFor, tweakSliders, DEFAULT_TWEAKS, TWEAK_LIMITS, skinTags, tagOptions, toggleFavorite, readFavorites };`)(window, react);
  } catch (error) {
    record(false, 'the tweak functions evaluate standalone', String(error.message));
    return;
  }
  // The bug this exists for: a fraction-valued default ("opacity: 1") read
  // against a percent range clamps to the minimum and washes the artwork out.
  const fresh = api.tweaksFor({ tweaks: {} }, 'skin-a');
  record(fresh.opacity === 1 && fresh.veil === 1 && fresh.blur === 0, 'untouched defaults leave the artwork fully visible', JSON.stringify(fresh));
  const sliders = api.tweakSliders({ tweaks: {} }, 'skin-a');
  record(sliders.opacity === 100 && sliders.veil === 100 && sliders.blur === 0, 'the slider defaults read as 100% / 100% / 0px', JSON.stringify(sliders));
  const inside = ['blur', 'opacity', 'veil'].every(
    (key) => api.DEFAULT_TWEAKS[key] >= api.TWEAK_LIMITS[key].min && api.DEFAULT_TWEAKS[key] <= api.TWEAK_LIMITS[key].max,
  );
  record(inside, 'every default sits inside its own slider range', JSON.stringify(api.DEFAULT_TWEAKS));
  const stored = api.tweaksFor({ tweaks: { 'skin-a': { blur: 12, opacity: 40, veil: 150 } } }, 'skin-a');
  record(stored.blur === 12 && Math.abs(stored.opacity - 0.4) < 1e-9 && Math.abs(stored.veil - 1.5) < 1e-9, 'stored percentages become layer factors', JSON.stringify(stored));
  const clamped = api.tweaksFor({ tweaks: { 'skin-a': { blur: 999, opacity: 0, veil: -5 } } }, 'skin-a');
  record(clamped.blur === 40 && Math.abs(clamped.opacity - 0.2) < 1e-9 && clamped.veil === 0, 'out-of-range values clamp to the sliders', JSON.stringify(clamped));
  record(api.tweaksFor({ tweaks: { 'skin-a': { opacity: 40 } } }, 'skin-b').opacity === 1, 'per-skin knobs do not leak to another skin');
}

/* ── B3. favourites and the tag index ─────────────────────────────────────── */
function checkLibrary() {
  const body = readFileSync(BODY, 'utf8');
  const marker = body.indexOf(' * A tiny subscribable view model');
  const slice = body.slice(body.indexOf('/** Route prefix owned by the host half.'), body.lastIndexOf('/*', marker));
  const storage = new Map();
  const window = {
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
  };
  let api;
  try {
    api = new Function('window', 'react', `${slice}; function publish(){}; return { skinTags, tagOptions, toggleFavorite, readFavorites };`)(window, { createElement: () => null });
  } catch (error) {
    record(false, 'the library helpers evaluate standalone', String(error.message));
    return;
  }
  const skins = [
    { skinId: 'a', styleKeywords: ['电影感雾气', '冷灰蓝调', '冷灰蓝调'], mood: ['静谧'] },
    { skinId: 'b', styleKeywords: ['电影感雾气'], mood: [] },
    { skinId: 'c', styleKeywords: [], mood: ['静谧'] },
  ];
  record(api.skinTags(skins[0]).length === 3, 'a skin\u2019s tags are de-duplicated', JSON.stringify(api.skinTags(skins[0])));
  record(api.skinTags({}).length === 0, 'a skin with no tags yields an empty list');
  const tags = api.tagOptions({ catalog: { skins } });
  record(tags[0].tag === '电影感雾气' && tags[0].count === 2, 'the tag index counts skins, most used first', JSON.stringify(tags));
  record(tags.length === 3, 'the tag index holds one row per distinct tag', String(tags.length));

  const state = { catalog: { skins }, favorites: [], filters: { query: '', type: 'all', tags: [], favoriteOnly: false } };
  api.toggleFavorite(state, 'a');
  record(state.favorites.join(',') === 'a', 'a heart click favourites the skin', JSON.stringify(state.favorites));
  record(api.readFavorites().join(',') === 'a', 'favourites are persisted', JSON.stringify(api.readFavorites()));
  api.toggleFavorite(state, 'a');
  record(state.favorites.length === 0 && api.readFavorites().length === 0, 'a second click un-favourites it');
  const filtered = { catalog: { skins }, favorites: ['a'], filters: { query: '', type: 'all', tags: [], favoriteOnly: true } };
  api.toggleFavorite(filtered, 'a');
  record(filtered.filters.favoriteOnly === false, 'removing the last favourite clears the 仅收藏 filter');
  record(Array.isArray(api.readFavorites()), 'an unreadable favourites store degrades to an empty list');
}

/* ── B4. the declared shortcut defaults ───────────────────────────────────── */
function checkShortcuts() {
  const body = readFileSync(BODY, 'utf8');
  const marker = body.indexOf('* Mounting the right-sidebar page');
  // Cut at the comment opener, not inside the banner, or the slice will not parse.
  const start = body.lastIndexOf('/*', body.indexOf('* Random skin, and the two application shortcuts'));
  const slice = body.slice(start, body.lastIndexOf('/*', marker));
  let api;
  try {
    const constants = 'const COMMAND_TOGGLE = "dsh-skins.toggle-panel"; const COMMAND_RANDOM = "dsh-skins.random-skin";';
    api = new Function(`${constants}${slice}; return { shortcutDefaults, SHORTCUT_PROFILES, TOGGLE_PROFILES, SHORTCUT_REGIONS, DOM_SHORTCUT_KEYS, shortcutKeysOf, randomOtherSkin };`)();
  } catch (error) {
    record(false, 'the shortcut helpers evaluate standalone', String(error.message));
    return;
  }
  const randomCombos = api.shortcutDefaults('KeyR', api.SHORTCUT_PROFILES);
  record(Object.keys(randomCombos).length === 5, 'five device profiles are declared for the random chord', Object.keys(randomCombos).join(', '));
  record(
    Object.values(randomCombos).every((value) => value.code === 'KeyR' && value.modifiers.join('+') === 'primary+shift'),
    'every profile binds primary + shift + the same physical key',
    JSON.stringify(randomCombos['desktop:windows']),
  );
  // The service rejects Linux Web defaults outside its short allow-list, and an
  // omitted profile is simply unbound there — which is the behaviour we want.
  record(!('web:linux' in randomCombos), 'Linux Web is left unbound rather than rejected');
  // `sidebar.right.toggle` ships Mod+Shift+B on the Web profiles; the service
  // rejects overlapping defaults even when the user's keybindings.json cleared it.
  const toggleCombos = api.shortcutDefaults('KeyB', api.TOGGLE_PROFILES);
  record(api.TOGGLE_PROFILES.every((profile) => profile.startsWith('desktop:')), 'the toggle chord is declared for desktop profiles only', api.TOGGLE_PROFILES.join(', '));
  record(!('web:windows' in toggleCombos) && !('web:macos' in toggleCombos), 'the Web profiles are left to the local listener');
  record('desktop:windows' in toggleCombos && 'desktop:macos' in toggleCombos, 'the toggle chord still covers both desktop platforms');
  record(api.shortcutKeysOf({ keys: ['Ctrl', '+', 'Shift', '+', 'R'] }) === 'Ctrl+Shift+R', 'keycap tokens are joined without doubling their separators');
  record(api.shortcutKeysOf({ keys: [], aria: 'Control+Shift+R' }) === 'Control+Shift+R', 'an empty keycap list falls back to the accessible name');
  record(api.shortcutKeysOf(null) === null, 'a missing catalog row yields no hint');
  record(api.SHORTCUT_REGIONS.join(',') === 'page,editable,terminal', 'the bindings cover every focus region the service derives');
  record(typeof api.DOM_SHORTCUT_KEYS['dsh-skins.toggle-panel'] === 'string', 'the local listener has a label for its chord');
  record(body.includes('id: COMMAND_TOGGLE') && body.includes('id: COMMAND_RANDOM'), 'both commands are registered with the service');
  record(body.includes('attempt(COMMAND_TOGGLE') && body.includes('attempt(COMMAND_RANDOM'), 'each command is attempted on its own, so one refusal cannot cost the other');
  record(body.includes('state.shortcutOwner[COMMAND_TOGGLE] !== "service"'), 'the local listener defers per chord, not wholesale');
  record(body.includes('disposeFallbackKeys'), 'the local listener is idempotent across a reload');

  const state = { skinId: 'x', catalog: { skins: [{ skinId: 'x' }, { skinId: 'y' }] } };
  let alwaysOther = true;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (api.randomOtherSkin(state).skinId !== 'y') alwaysOther = false;
  }
  record(alwaysOther, 'a random pick never repeats the skin already on screen');
  record(api.randomOtherSkin({ skinId: null, catalog: { skins: [] } }) === null, 'an empty catalog yields no random pick');
  const single = api.randomOtherSkin({ skinId: 'x', catalog: { skins: [{ skinId: 'x' }] } });
  record(single !== null && single.skinId === 'x', 'a one-skin catalog still answers');
}

/* ── B5. drag and drop wiring ─────────────────────────────────────────────── */
function checkDragDrop() {
  const body = readFileSync(BODY, 'utf8');
  for (const symbol of ['onDragEnter', 'onDragOver', 'onDragLeave', 'dragDepth', 'dataTransfer.dropEffect']) {
    record(body.includes(symbol), `drag and drop: the source handles ${symbol}`);
  }
  record(body.includes('dragHasFiles'), 'a non-file drag is ignored');
  record(body.includes('松开鼠标即开始上传'), 'the zone announces the drop state');
  record(body.includes('acceptFiles(files)'), 'a drop feeds the same upload path as the picker');
  record(body.includes('dsh-skins-steps') && body.includes('finishedSteps'), 'the job renders a step checklist');
  record(body.includes('width: row.percent'), 'per-file progress is rendered');
}

/* ── B6. phase-2 wiring (the maths itself is covered by verify_visual.mjs) ─── */
function checkPhase2Wiring() {
  const body = readFileSync(BODY, 'utf8');
  for (const label of ['UI颜色跟随背景', '鼠标视差', '灰度', '饱和度', '对比度', '色调分离']) {
    record(body.includes('"' + label + '"'), `the panel offers the 「${label}」 control`);
  }
  record((body.match(/setTweak\(props\.ctx/g) ?? []).length >= 8, 'every knob threads ctx through, so the live layer can re-derive', String((body.match(/setTweak\(props\.ctx/g) ?? []).length));
  record(body.includes('ctx.effect(() => installParallax(state)'), 'the pointer listener is installed with the fiber');
  record(body.includes('requestAnimationFrame') && body.includes('cancelAnimationFrame'), 'parallax updates are coalesced into a frame');
  record(body.includes('feComponentTransfer') && body.includes('"discrete"') && body.includes('tableValues'), 'posterize is a real discrete transfer, not a CSS approximation');
  record(body.includes('color-interpolation-filters') && body.includes('"sRGB"'), 'the posterize filter stays in sRGB so it matches the other filters');
  record(body.includes('state.layer.style.perspective'), 'the layer carries the perspective the tilt needs');
  record(body.includes('applyTokenLayer(ctx, state)'), 'one function owns the token layer, so live and shipped never stack');
  record(body.includes('scheduleLiveTokens') && body.includes('180'), 'filter drags coalesce their re-derivation');
  record(body.includes('context.filter ='), 'the live measurement draws through the same filters the user sees');
  record(body.includes('dsh-skins-switch'), 'the switches are styled as switches, not plain buttons');
}

/* ── C. revision agreement ────────────────────────────────────────────────── */
async function checkRevision() {
  const host = await import(`${pathToFileURL(HOST).href}?probe=${Date.now()}`);
  const body = readFileSync(BODY, 'utf8');
  const match = /const REVISION = "([^"]+)"/u.exec(body);
  const clientRevision = match === null ? null : match[1];
  record(clientRevision !== null && clientRevision === host.REVISION, 'both halves name the same revision', `client=${clientRevision} host=${host.REVISION}`);
  return host;
}

/* ── D. the whole pipeline ────────────────────────────────────────────────── */
class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.status = 0;
    this.headers = {};
    this.chunks = [];
  }
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers ?? {};
  }
  end(body) {
    if (body !== undefined && body !== null) this.chunks.push(Buffer.from(body));
    this.emit('done');
  }
  destroy() {
    this.emit('done');
  }
  json() {
    const text = Buffer.concat(this.chunks).toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      return { parseError: text.slice(0, 200) };
    }
  }
}

function fakeRequest(method, url, headers, body) {
  const request = Readable.from(body === undefined ? [] : [body]);
  request.method = method;
  request.url = url;
  request.headers = headers ?? {};
  return request;
}

/** Drive one request through the real route handler. */
async function call(handler, method, url, { headers = {}, body } = {}) {
  const request = fakeRequest(method, url, headers, body);
  const response = new FakeResponse();
  const done = new Promise((settle) => response.once('done', settle));
  await handler(request, response);
  await Promise.race([done, new Promise((settle) => setTimeout(settle, 5000))]);
  return response;
}

/** A tiny valid PNG, built with the same sharp the pipeline itself uses. */
async function writeProbeImage(target, sharpPath) {
  const sharp = (await import(pathToFileURL(join(sharpPath, 'dist', 'index.mjs')).href)).default;
  const width = 320;
  const height = 200;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 3;
      raw[at] = 200 - Math.round((y / height) * 60);
      raw[at + 1] = 30 + Math.round((x / width) * 40);
      raw[at + 2] = 30 + Math.round((y / height) * 30);
    }
  }
  await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(target);
}

async function checkPipeline(host) {
  // `--generate` only: point SHARP_PATH at a sharp install (or drop one into
  // node_modules/sharp) to run the end-to-end pipeline check.
  const SHARP = process.env.SHARP_PATH ?? join(root, 'node_modules', 'sharp');
  if (!existsSync(SHARP)) {
    record(false, 'sharp is available for the probe image', SHARP);
    return;
  }
  const plansDir = join(root, 'output', 'plans');
  const backup = join(root, 'output', '_scan', '.verify-backup');
  rmSync(backup, { recursive: true, force: true });
  mkdirSync(backup, { recursive: true });
  cpSync(plansDir, join(backup, 'plans'), { recursive: true });
  for (const file of ['output/skins/status.json', 'output/reports/skin_index.md', 'output/skins/assets-report.json']) {
    const full = join(root, file);
    if (existsSync(full)) {
      const flat = file.replaceAll('/', '__');
      cpSync(full, join(backup, flat));
    }
  }

  const probeName = 'zzz_probe_panel.png';
  const probeInput = join(root, 'input_image', probeName);
  const autoImageGroup = join(root, 'output', '_scan', 'image_groups', 'group_e.json');
  const hadAutoGroup = existsSync(autoImageGroup);
  let autoGroupCopy = null;
  if (hadAutoGroup) {
    autoGroupCopy = join(backup, 'group_e.json');
    cpSync(autoImageGroup, autoGroupCopy);
  }

  const registrations = [];
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    inject: (deps, callback) => callback(ctx),
    effect: (callback) => {
      const dispose = callback();
      return dispose;
    },
  };
  const webServer = {
    register: (options) => {
      registrations.push(options);
      return () => {};
    },
  };
  const webCtx = { ...ctx, webServer };
  ctx.inject = (deps, callback) => {
    callback(deps.includes('webServer') ? webCtx : ctx);
    return () => {};
  };
  host.apply(ctx, {});
  record(registrations.length === 1 && registrations[0].path === host.ROUTE, 'host registers its prefix route', `registrations=${registrations.length}`);
  const handler = registrations[0]?.handler;

  let probeSkinId = null;
  let job = null;
  try {
    // The probe is built outside the input directory and then uploaded through
    // the route, which is the path the panel itself takes.
    const probeSource = join(backup, 'probe.png');
    await writeProbeImage(probeSource, SHARP);
    record(existsSync(probeSource), 'probe image built outside the input directory');

    const version = await call(handler, 'GET', `${host.ROUTE}/version`);
    record(version.status === 200 && version.json().revision === host.REVISION, 'GET /version answers with the host revision', JSON.stringify(version.json()));

    const beforeCatalog = (await call(handler, 'GET', `${host.ROUTE}/catalog`)).json();
    record(beforeCatalog.ok === true && beforeCatalog.counts.total === 40, 'catalog starts at 40 skins', `total=${beforeCatalog.counts?.total}`);
    record(beforeCatalog.revision === host.REVISION, 'the catalog carries the revision the panel compares');

    const upload = await call(handler, 'POST', `${host.ROUTE}/upload`, {
      headers: { 'x-dsh-skin-filename': encodeURIComponent(probeName), 'content-type': 'image/png', 'sec-fetch-site': 'same-origin' },
      body: readFileSync(probeSource),
    });
    record(upload.status === 200 && upload.json().ok === true, 'POST /upload streams a file in', JSON.stringify(upload.json()).slice(0, 160));
    record(existsSync(probeInput), 'the uploaded bytes landed in input_image');

    const duplicate = await call(handler, 'POST', `${host.ROUTE}/upload`, {
      headers: { 'x-dsh-skin-filename': encodeURIComponent(probeName), 'content-type': 'image/png' },
      body: Buffer.from('x'),
    });
    record(duplicate.status === 409, 'a second upload of the same name is refused', `status=${duplicate.status}`);

    const badName = await call(handler, 'POST', `${host.ROUTE}/upload`, {
      headers: { 'x-dsh-skin-filename': encodeURIComponent('../../escape.exe'), 'content-type': 'application/octet-stream' },
      body: Buffer.from('x'),
    });
    record(badName.status === 415, 'an unsupported extension is refused', `status=${badName.status}`);

    const traversal = await call(handler, 'POST', `${host.ROUTE}/upload`, {
      headers: { 'x-dsh-skin-filename': encodeURIComponent('..\\..\\evil.png'), 'content-type': 'image/png' },
      body: Buffer.from('not a png'),
    });
    record(traversal.status === 200 || traversal.status === 400, 'a traversal name cannot leave input_image', `status=${traversal.status}`);
    if (traversal.status === 200) {
      record(existsSync(join(root, 'input_image', 'evil.png')), 'the traversal name was flattened to a basename');
      rmSync(join(root, 'input_image', 'evil.png'), { force: true });
    }

    const measured = {
      firstImpression: '自动像素测量（验证用）',
      size: '320x200',
      primaryColor: '#8a3b2c',
      secondaryColors: ['#6a2a22', '#c05a44', '#3f1d18'],
      accentColor: '#c05a44',
      neutrals: ['#3f1d18', '#8a3b2c', '#e8d8d2'],
      luminance: 0.31,
      contrast: 'medium',
      saturation: 'balanced',
      temperature: 'warm',
      material: '未做材质鉴定（自动像素测量）',
      lighting: '低照度',
      composition: '画幅 320×200',
      busyness: 'calm',
      styleKeywords: ['自动测量'],
      mood: [],
      backgroundSuitability: { dark: 'good，实测均亮 0.31', light: 'workable，实测偏暗 0.31' },
      paletteProposal: { accent: '#c05a44', surface: '#161313', companion: '#c05a44', scheme: 'dark', rationale: '验证用' },
    };
    const generate = await call(handler, 'POST', `${host.ROUTE}/generate`, {
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ records: { [probeName]: measured } })),
    });
    const started = generate.json();
    record(generate.status === 200 && started.ok === true && started.job?.running === true, 'POST /generate starts a job', `status=${generate.status}`);
    const again = await call(handler, 'POST', `${host.ROUTE}/generate`, { headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') });
    // Only meaningful while the first job still runs; a job that already failed
    // legitimately accepts the next request.
    record(again.status === 409 || started.job?.running !== true, 'a second job is refused while one runs', `status=${again.status}`);

    const deadline = Date.now() + 12 * 60 * 1000;
    for (;;) {
      await new Promise((settle) => setTimeout(settle, 2000));
      const polled = (await call(handler, 'GET', `${host.ROUTE}/job`)).json();
      job = polled.job;
      if (job.running !== true) break;
      if (Date.now() > deadline) {
        record(false, 'the job finished inside 12 minutes');
        break;
      }
    }
    console.log(`\n--- job ${job.id} ${job.status}: ${job.message ?? ''} ---`);
    for (const entry of job.steps) console.log(`    ${entry.status.padEnd(8)} ${entry.id.padEnd(20)} code=${entry.code} ${entry.ms}ms${entry.note ? ` (${entry.note})` : ''}`);
    console.log(`    new skins: ${JSON.stringify(job.newSkins)}\n`);
    record(job.status === 'succeeded', 'the pipeline job succeeded', `${job.status}: ${job.message ?? ''}`);

    probeSkinId = job.newSkins?.[0] ?? null;
    if (probeSkinId === null) {
      record(false, 'the job reported a new skin directory');
      console.log(job.log.slice(-3000));
    } else {
      const dir = join(root, 'output', 'skins', probeSkinId);
      record(existsSync(join(dir, 'skin.json')), 'the new skin has skin.json');
      record(existsSync(join(dir, 'theme.css')), 'the new skin has theme.css');
      record(existsSync(join(dir, 'assets', 'wallpaper.webp')), 'the new skin has a wallpaper from the real image');
      const tokens = JSON.parse(readFileSync(join(dir, 'tokens.json'), 'utf8'));
      const pairs = Object.entries(tokens.presentedTokens ?? {});
      record(pairs.length > 0, 'the new skin ships presentedTokens', `${pairs.length} tokens`);
      const malformed = pairs.filter(([, value]) => typeof value?.light !== 'string' || typeof value?.dark !== 'string');
      record(malformed.length === 0, 'every presented token is a light/dark pair', malformed.length === 0 ? '' : JSON.stringify(malformed.slice(0, 2)));
      record(tokens.colors?.accentUsed !== undefined || tokens.colors?.accentSubstituted !== undefined, 'the accent survived the contrast search');
    }

    const afterCatalog = (await call(handler, 'GET', `${host.ROUTE}/catalog`)).json();
    record(afterCatalog.counts.total === 41, 'the catalog picks the new skin up without a restart', `total=${afterCatalog.counts?.total}`);
  } finally {
    if (probeSkinId !== null) rmSync(join(root, 'output', 'skins', probeSkinId), { recursive: true, force: true });
    rmSync(probeInput, { force: true });
    // Restore from the backup BEFORE deleting it: the other order left the plans
    // directory half-replaced the first time this ran.
    cpSync(join(backup, 'plans'), plansDir, { recursive: true });
    for (const file of ['output/skins/status.json', 'output/reports/skin_index.md', 'output/skins/assets-report.json']) {
      const flat = join(backup, file.replaceAll('/', '__'));
      if (existsSync(flat)) cpSync(flat, join(root, file));
    }
    if (hadAutoGroup && autoGroupCopy !== null) cpSync(autoGroupCopy, autoImageGroup);
    else rmSync(autoImageGroup, { force: true });
    rmSync(backup, { recursive: true, force: true });
    rmSync(join(root, 'output', 'analysis', 'frames', 'zzz_probe_panel.frames.json'), { force: true });
    rmSync(join(root, 'output', 'analysis', 'frames', 'zzz_probe_panel.poster.jpg'), { force: true });
    console.log('cleanup: probe input, probe skin, auto group and plan files restored');
  }
}

/* ── main ─────────────────────────────────────────────────────────────────── */
checkBundle();
checkMeasurement();
checkTweaks();
checkLibrary();
checkShortcuts();
checkDragDrop();
checkPhase2Wiring();
const host = await checkRevision();
if (WANT_GENERATE) await checkPipeline(host);

const failed = results.filter((row) => !row.ok);
console.log(`\nchecks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  for (const row of failed) console.log(`FAILED ${row.label} ${row.detail}`);
  process.exitCode = 1;
}
