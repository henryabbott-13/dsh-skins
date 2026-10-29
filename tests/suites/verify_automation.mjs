/**
 * Phase-4 verification: the automation rules and their teardown.
 *
 * Two halves, and the second one is the point of the exercise:
 *
 *   1. The precedence table and the clock arithmetic are pure functions, so the
 *      whole rule set is testable without a browser — including the case a naive
 *      implementation gets backwards (a range that wraps midnight).
 *   2. **Teardown is executed, not inspected.** `startAutomation` runs against a
 *      window/document/context whose listeners, intervals and subscriptions are
 *      counted; then `stopAutomation` must return every counter to zero, and a
 *      second start must not accumulate. Grepping for `removeEventListener` would
 *      only prove the text exists.
 *
 *   node output\_scan\verify_automation.mjs
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

const sliceBetween = (from, to) => {
  const fromIndex = body.indexOf(from);
  const start = fromIndex === -1 ? -1 : body.lastIndexOf('/*', fromIndex);
  const end = body.lastIndexOf('/*', body.indexOf(to));
  if (start === -1 || end === -1 || end <= start) throw new Error(`could not slice ${from} .. ${to}`);
  return body.slice(start, end);
};

// The automation block lives between the knobs and the store, so one slice from
// the top of the constants to the store banner contains it — together with the
// storage keys and the tick constant it reads. Slicing it twice would re-declare
// its constants.
const knobs = sliceBetween('/** Route prefix owned by the host half.', ' * A tiny subscribable view model');
const panel = sliceBetween(' * Panel components', 'function panelGlyph');

/* ── one environment for the pure code and the rendered panel ─────────────── */
const counters = { window: 0, document: 0, media: 0, intervals: 0, subscribes: 0 };
const live = { window: new Set(), document: new Set(), media: new Set(), intervals: new Set(), subs: new Set() };
let nextId = 1;

const makeWindow = (matches) => ({
  innerWidth: 1000,
  innerHeight: 800,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  addEventListener: (type) => {
    if (live.window.has(type)) return;
    live.window.add(type);
    counters.window += 1;
  },
  removeEventListener: (type) => {
    if (live.window.delete(type)) counters.window -= 1;
  },
  setInterval: () => {
    const id = nextId++;
    live.intervals.add(id);
    counters.intervals += 1;
    return id;
  },
  clearInterval: (id) => {
    if (live.intervals.delete(id)) counters.intervals -= 1;
  },
  clearTimeout: () => {},
  setTimeout: () => 0,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  matchMedia: () => ({
    matches: matches === true,
    addEventListener: () => {
      if (live.media.has('change')) return;
      live.media.add('change');
      counters.media += 1;
    },
    removeEventListener: () => {
      if (live.media.delete('change')) counters.media -= 1;
    },
  }),
});
const makeDocument = () => ({
  addEventListener: (type) => {
    if (live.document.has(type)) return;
    live.document.add(type);
    counters.document += 1;
  },
  removeEventListener: (type) => {
    if (live.document.delete(type)) counters.document -= 1;
  },
  documentElement: { style: { setProperty: () => {}, removeProperty: () => {} } },
  querySelector: () => null,
  createElement: () => ({ style: {} }),
  createElementNS: () => ({ setAttribute: () => {}, append: () => {}, style: {}, querySelector: () => null }),
  getElementById: () => null,
  head: { append: () => {} },
  body: { append: () => {} },
});

const windowStub = makeWindow(false);
const documentStub = makeDocument();
const reactStub = {
  createElement: (type, props, ...children) => {
    const merged = Object.assign({}, props ?? {});
    if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
    if (typeof type === 'function') return { type: type.name || 'Anonymous', props: merged, children: [type(merged)] };
    return { type, props: merged, children };
  },
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
};

/** The calls the automation makes into the rest of the plugin. */
const calls = { switches: [] };
const stubs = `
function publish() {}
function switchTo(ctx, state, skin, reason) { globalThis.__switchTo(skin, reason); return Promise.resolve({}); }
function useView(store) { return store.view; }
function applyById() {}
function startGenerate() {}
function refreshLiveTokens() {}
function applyLayerTweaks() {}
function scheduleLiveTokens() {}
`;
globalThis.__switchTo = (skin, reason) => calls.switches.push({ skinId: skin === null ? null : skin.skinId, reason });

let api;
try {
  api = new Function(
    'window',
    'document',
    'react',
    `${knobs}\n${panel}\n${stubs}\n` +
      'return { defaultAutomation, parseClock, insideRange, workspaceKey, workspaceLabel, automationDecision, rotationPick, readAutomation, harvestWorkspaces, bindableWorkspaces, refreshWorkspaceFromSession, startAutomation, stopAutomation, evaluateAutomation, SkinsPanel, AUTOMATION_ORDER, AUTOMATION_TICK_MS };',
  )(windowStub, documentStub, reactStub);
} catch (error) {
  record(false, 'the automation code evaluates standalone', String(error.message));
  process.exit(1);
}

/* ── 1. clock arithmetic ──────────────────────────────────────────────────── */
const clocks = [
  ['08:00', 480],
  ['18:00', 1080],
  ['00:00', 0],
  ['23:59', 1439],
  ['8:05', 485],
];
const clockFailures = clocks.filter(([input, expected]) => api.parseClock(input) !== expected);
record(clockFailures.length === 0, 'a clock string parses to minutes', clockFailures.length === 0 ? '' : JSON.stringify(clockFailures));
for (const bad of ['24:00', '08:60', '0800', '', 'ab:cd', null, undefined, '12']) {
  record(api.parseClock(bad) === null, `a non-clock value is rejected (${JSON.stringify(bad)})`);
}

const ranges = [
  { now: '09:00', start: '08:00', end: '18:00', inside: true },
  { now: '07:59', start: '08:00', end: '18:00', inside: false },
  { now: '18:00', start: '08:00', end: '18:00', inside: false },
  { now: '17:59', start: '08:00', end: '18:00', inside: true },
  // A range that wraps midnight is the case a naive comparison gets backwards.
  { now: '23:00', start: '22:00', end: '06:00', inside: true },
  { now: '02:00', start: '22:00', end: '06:00', inside: true },
  { now: '06:00', start: '22:00', end: '06:00', inside: false },
  { now: '12:00', start: '22:00', end: '06:00', inside: false },
  { now: '12:00', start: '12:00', end: '12:00', inside: false },
];
const rangeFailures = ranges.filter((row) => api.insideRange(api.parseClock(row.now), api.parseClock(row.start), api.parseClock(row.end)) !== row.inside);
record(rangeFailures.length === 0, 'range membership handles wrap-around and half-open ends', rangeFailures.length === 0 ? '' : JSON.stringify(rangeFailures));

/* ── 2. workspace identity ────────────────────────────────────────────────── */
record(api.workspaceKey('E:\\Data\\Proj\\Project_7\\') === 'e:/data/proj/project_7', 'the binding key is a normalised path', String(api.workspaceKey('E:\\Data\\Proj\\Project_7\\')));
record(api.workspaceKey('E:/Data/Proj/Project_7') === api.workspaceKey('E:\\Data\\Proj\\Project_7'), 'both separators normalise to the same key');
record(api.workspaceKey('   ') === null && api.workspaceKey(null) === null, 'an empty path has no key');
record(api.workspaceLabel('E:\\Work\\Demo\\Project_7') === 'Project_7', 'the label is the last segment', api.workspaceLabel('E:\\Work\\Demo\\Project_7'));

/* ── 3. the precedence table ──────────────────────────────────────────────── */
const base = () => ({
  automation: {
    system: { enabled: true, dark: 'skin-sys-dark', light: 'skin-sys-light' },
    time: { enabled: true, start: '08:00', end: '18:00', day: 'skin-day', night: 'skin-night' },
    project: { enabled: true, bindings: { 'e:/x/project_7': 'skin-project' } },
    rotation: { enabled: true, minutes: 30, favoritesOnly: false },
  },
  currentWorkspaceKey: 'e:/x/project_7',
  currentWorkspaceLabel: 'Project_7',
  catalog: { skins: [] },
  favorites: [],
  skinId: null,
});
const at = (hours, minutes = 0) => new Date(2026, 8, 30, hours, minutes, 0);
record(api.automationDecision(base(), at(12)).source === 'project', 'a project binding outranks everything', String(api.automationDecision(base(), at(12)).source));
const noProject = base();
noProject.currentWorkspaceKey = 'e:\\x\\other';
record(api.automationDecision(noProject, at(12)).source === 'time', 'an unbound workspace falls through to the schedule', String(api.automationDecision(noProject, at(12)).source));
record(api.automationDecision(base(), at(12)).skinId === 'skin-project', 'the winning rule names its skin');
record(api.automationDecision(noProject, at(12)).skinId === 'skin-day', 'inside the range the day skin wins');
record(api.automationDecision(noProject, at(20)).skinId === 'skin-night', 'outside the range the night skin wins');
const noTime = base();
noTime.currentWorkspaceKey = null;
noTime.automation.time.enabled = false;
record(api.automationDecision(noTime, at(12)).source === 'system', 'with no schedule the system rule answers', String(api.automationDecision(noTime, at(12)).source));
record(api.automationDecision(noTime, at(12)).skinId === 'skin-sys-light', 'a light system preference picks the light skin');
record(api.automationDecision(noTime, at(12)).detail === '系统浅色', 'the decision explains itself', api.automationDecision(noTime, at(12)).detail);
const darkWindow = new Function('window', 'document', 'react', `${knobs}\nreturn { automationDecision };`)(makeWindow(true), makeDocument(), reactStub);
record(darkWindow.automationDecision(noTime, at(12)).skinId === 'skin-sys-dark', 'a dark system preference picks the dark skin');
const allOff = base();
allOff.automation.project.enabled = false;
allOff.automation.time.enabled = false;
allOff.automation.system.enabled = false;
record(api.automationDecision(allOff, at(12)) === null, 'with every rule off nothing claims the moment');
const emptySlot = base();
emptySlot.automation.project.bindings = {};
emptySlot.automation.time.day = null;
emptySlot.automation.time.enabled = true;
record(api.automationDecision(emptySlot, at(12)) === null || api.automationDecision(emptySlot, at(12)).source === 'system', 'a rule whose skin slot is empty does not win with nothing');
const wrap = base();
wrap.currentWorkspaceKey = null;
wrap.automation.project.enabled = false;
wrap.automation.time.start = '22:00';
wrap.automation.time.end = '06:00';
record(api.automationDecision(wrap, at(23)).skinId === 'skin-day', 'a wrapping schedule uses the day skin after 22:00');
record(api.automationDecision(wrap, at(12)).skinId === 'skin-night', 'and the night skin at noon');
record(api.AUTOMATION_ORDER.join('>') === 'project>time>system', 'the documented precedence is project > time > system', api.AUTOMATION_ORDER.join(' > '));

/* ── 4. rotation ──────────────────────────────────────────────────────────── */
const rot = base();
rot.automation.project.enabled = false;
rot.automation.time.enabled = false;
rot.automation.system.enabled = false;
rot.catalog = { skins: [{ skinId: 'a' }, { skinId: 'b' }, { skinId: 'c' }] };
rot.skinId = 'a';
let picks = new Set();
for (let attempt = 0; attempt < 60; attempt += 1) picks.add(api.rotationPick(rot).skinId);
record(!picks.has('a'), 'rotation never re-picks the skin already on screen', [...picks].join(','));
record(picks.size === 2, 'rotation draws from the rest of the catalog', [...picks].join(','));
const rotOff = Object.assign({}, rot, { automation: Object.assign({}, rot.automation, { rotation: { enabled: false, minutes: 30, favoritesOnly: false } }) });
record(api.rotationPick(rotOff) === null, 'rotation does nothing while it is off');
const rotRule = Object.assign({}, rot, { automation: Object.assign({}, rot.automation, { rotation: { enabled: true, minutes: 30, favoritesOnly: false }, system: { enabled: true, dark: 'a', light: 'b' } }) });
record(api.rotationPick(rotRule) === null, 'rotation yields to a rule that claims the moment');
const rotFav = Object.assign({}, rot, { automation: Object.assign({}, rot.automation, { rotation: { enabled: true, minutes: 30, favoritesOnly: true } }), favorites: ['b'] });
record(api.rotationPick(rotFav).skinId === 'b', '仅收藏 draws only from the favourites', api.rotationPick(rotFav).skinId);
const rotEmptyFav = Object.assign({}, rotFav, { favorites: [] });
record(api.rotationPick(rotEmptyFav) === null, '仅收藏 with no favourites picks nothing');
record(api.rotationPick(Object.assign({}, rot, { catalog: { skins: [{ skinId: 'a' }] } })) === null, 'a one-skin catalog leaves rotation with nothing to do');

/* ── 5. the harvest and the session → workspace mapping ───────────────────── */
const harvested = { catalog: { skins: [] }, workspaceIndex: { at: null, fingerprint: null, items: [] }, currentSessionId: null, currentWorkspaceKey: null, currentWorkspaceLabel: null, currentWorkspaceTitle: null };
api.harvestWorkspaces(harvested, {
  items: [
    { workspaceId: 'w1', path: 'E:\\Work\\Demo\\Project_7', title: 'Project_7', sessionIds: ['s-7'] },
    { workspaceId: 'w2', path: 'E:\\Work\\Demo\\Project_2\\', title: 'Project_2', sessionIds: ['s-2', 's-2b'] },
    { workspaceId: 'w1', path: 'E:\\Work\\Demo\\Project_7', title: 'duplicate', sessionIds: ['s-7b'] },
    { workspaceId: 'bad', title: 'no path' },
  ],
});
record(api.bindableWorkspaces(harvested).length === 2, 'the picker de-duplicates by path and drops entries without one', JSON.stringify(api.bindableWorkspaces(harvested).map((row) => row.label)));
api.refreshWorkspaceFromSession(harvested, 's-2b');
record(harvested.currentWorkspaceKey === 'e:/work/demo/project_2', 'a session resolves to its workspace key', String(harvested.currentWorkspaceKey));
record(harvested.currentWorkspaceLabel === 'Project_2', 'and to a readable project name', String(harvested.currentWorkspaceLabel));
api.refreshWorkspaceFromSession(harvested, 'unknown-session');
record(harvested.currentWorkspaceKey === null, 'an unknown session resolves to nothing rather than a wrong workspace');
api.refreshWorkspaceFromSession(harvested, undefined);
record(harvested.currentWorkspaceKey === null && harvested.currentSessionId === null, 'no session on screen clears the binding context');

/* ── 6. teardown, executed ────────────────────────────────────────────────── */
const ctxStub = {
  get: (name) =>
    name === 'sidebarRight'
      ? {
          mounted: {
            getSnapshot: () => 's-7',
            subscribe: () => {
              if (!live.subs.has('mounted')) {
                live.subs.add('mounted');
                counters.subscribes += 1;
              }
              return () => {
                if (live.subs.delete('mounted')) counters.subscribes -= 1;
              };
            },
          },
        }
      : undefined,
};
const runtimeState = () => ({
  automation: {
    system: { enabled: true, dark: 'skin-a', light: 'skin-b' },
    time: { enabled: true, start: '08:00', end: '18:00', day: 'skin-a', night: 'skin-b' },
    project: { enabled: true, bindings: {} },
    rotation: { enabled: true, minutes: 30, favoritesOnly: false },
  },
  catalog: { skins: [{ skinId: 'skin-a', name: 'A', nameZh: 'A' }, { skinId: 'skin-b', name: 'B', nameZh: 'B' }] },
  favorites: [],
  skinId: null,
  workspaceIndex: { at: null, fingerprint: null, items: [] },
  currentSessionId: null,
  currentWorkspaceKey: null,
  currentWorkspaceLabel: null,
  currentWorkspaceTitle: null,
  automationDisposers: [],
  automationNote: null,
  automationDecision: null,
  automationApplied: null,
  automationBusy: false,
  mountedSource: null,
});

const totals = () => ({ ...counters });
const allZero = () => Object.values(counters).every((value) => value === 0);

const full = runtimeState();
api.startAutomation(ctxStub, full);
await new Promise((settle) => setTimeout(settle, 0));
const acquired = totals();
record(
  acquired.window === 1 && acquired.document === 1 && acquired.media === 1 && acquired.intervals === 2 && acquired.subscribes === 1,
  'startAutomation acquires exactly what the config needs (2 intervals, 3 listeners, 1 subscription)',
  JSON.stringify(acquired),
);
record(full.automationDisposers.length === 5, 'every acquired resource has a disposer recorded', String(full.automationDisposers.length));
record(full.mountedSource === 'sidebarRight', 'the session observable is preferred over polling', String(full.mountedSource));
record(calls.switches.length === 1 && calls.switches[0].reason === 'auto-time', 'the mount-time evaluation applied the rule once', JSON.stringify(calls.switches));

api.stopAutomation(full);
record(allZero(), 'stopAutomation releases every one of them', JSON.stringify(totals()));
record(full.automationDisposers.length === 0, 'the disposer list is emptied, not merely iterated');

calls.switches.length = 0;
api.startAutomation(ctxStub, full);
api.startAutomation(ctxStub, full);
api.startAutomation(ctxStub, full);
await new Promise((settle) => setTimeout(settle, 0));
const afterThree = totals();
record(
  JSON.stringify(afterThree) === JSON.stringify(acquired),
  'three consecutive starts leave exactly one set of resources (a config edit cannot stack timers)',
  JSON.stringify(afterThree),
);
api.stopAutomation(full);
record(allZero(), 'and they are all released again');

const minimal = runtimeState();
minimal.automation.time.enabled = false;
minimal.automation.project.enabled = false;
minimal.automation.rotation.enabled = false;
api.startAutomation(ctxStub, minimal);
const thin = totals();
record(thin.intervals === 0 && thin.media === 1 && thin.window === 1 && thin.document === 1 && thin.subscribes === 1, 'with every rule off only the always-on listeners remain', JSON.stringify(thin));
api.stopAutomation(minimal);
record(allZero(), 'a disabled config still tears down cleanly');
record(counters.intervals === 0 && live.intervals.size === 0, 'no interval survives any path', String(live.intervals.size));

// A context without the sidebar observable must degrade to polling, not throw.
const noSidebar = { get: () => undefined };
const bare = runtimeState();
api.startAutomation(noSidebar, bare);
record(bare.mountedSource === 'panel-only' && counters.subscribes === 0, 'without the observable the automation falls back to its tick', String(bare.mountedSource));
api.stopAutomation(bare);
record(allZero(), 'and that path tears down too');

/* ── 7. the source-level guarantees a counter cannot show ─────────────────── */
record(body.includes('ctx.effect(() => {\n    startAutomation(ctx, state);\n    return () => stopAutomation(state);'), 'the automation lives in one effect whose cleanup stops it');
const startsWithStop = /function startAutomation\(ctx, state\) \{\s*stopAutomation\(state\);/.test(body);
record(startsWithStop, 'startAutomation tears the old set down before building a new one');
record(/state\.automation = next;[\s\S]{0,200}?startAutomation\(ctx, state\);[\s\S]{0,200}?void evaluateAutomation/u.test(body), 'a config change rebuilds the schedule and re-decides');
const automationSlice = body.slice(body.indexOf(' * Automation: the rules, and the timers that watch them'), body.indexOf(' * Assets: encoder settings'));
record((automationSlice.match(/window\.setInterval/gu) ?? []).length === 2, 'the automation owns exactly two intervals (other features may own their own)', String((automationSlice.match(/window\.setInterval/gu) ?? []).length));
record(body.includes('props.useWorkspaces') && body.includes('harvestWorkspaces(store, workspaceSnapshot)'), 'the panel harvests the workspace snapshot it receives as a slot prop');
record(body.includes('mounted.getSnapshot()'), 'the session on screen is read from the sidebar observable in plain JS');
record(body.includes('detectedWorkspace') === false, 'no placeholder left behind');

/* ── 8. the rendered section ──────────────────────────────────────────────── */
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
const switchesOf = (tree) => {
  const out = [];
  walk(tree, (node) => {
    if (node.props?.role === 'switch' && typeof node.props['aria-label'] === 'string') out.push(node.props['aria-label']);
  });
  return out;
};

const makeView = (overrides) =>
  Object.assign(
    {
      version: 1,
      catalog: { ok: true, counts: { total: 2, image: 2, video: 0 }, skins: [{ skinId: 'skin-a', name: 'Alpha', nameZh: '甲', type: 'image', assets: {}, styleKeywords: [], mood: [] }, { skinId: 'skin-b', name: 'Beta', nameZh: '乙', type: 'image', assets: {}, styleKeywords: [], mood: [] }] },
      catalogError: null,
      skinId: 'skin-a',
      tweaks: { blur: 0, opacity: 1, veil: 1 },
      slider: { blur: 0, opacity: 100, veil: 100, grayscale: 0, saturate: 100, contrast: 100, posterize: 0, parallax: false, uiFollow: false, videoPlaying: true, videoMuted: true, videoRate: 1, audioReactive: false },
      favorites: [],
      filters: { query: '', type: 'all', tags: [], favoriteOnly: false },
      tags: [],
      job: null,
      staleHost: false,
      panelReady: true,
      panelError: null,
      tokenSource: 'skin',
      reducedMotion: false,
      videoPlaying: false,
      videoMuted: true,
      videoRate: 1,
      videoHasAudio: null,
      videoSilent: null,
      videoNote: null,
      audioReactiveOn: false,
      audioLevel: 0,
      automation: api.defaultAutomation(),
      automationNote: null,
      automationDecision: null,
      automationTimers: 0,
      workspaceItems: [],
      workspaceIndexAt: null,
      currentWorkspaceLabel: null,
      mountedSource: 'sidebarRight',
      referenced: [],
      assets: { autoCompress: true, thresholdMB: 50, targetHeight: 1080, bitrateMbps: 5, includeSource: false },
      ffmpeg: null,
      assetJob: null,
      exportResult: null,
      importResult: null,
      cleanup: null,
    },
    overrides ?? {},
  );

const renderAutomation = (overrides) => {
  const view = makeView(overrides);
  const store = {
    view,
    tweaks: {},
    catalog: view.catalog,
    filters: view.filters,
    favorites: [],
    job: null,
    listeners: new Set(),
    workspaceIndex: { at: '2026-09-30T12:00:00.000Z', fingerprint: 'x', items: [] },
    automation: view.automation,
  };
  return api.SkinsPanel({ store, ctx: { get: () => undefined, theme: { overrideTokens: () => () => {} } } });
};

const offTree = renderAutomation();
const offLabels = switchesOf(offTree);
for (const label of ['跟随系统深浅色', '时间段切换', '项目绑定', '轮播']) {
  record(offLabels.includes(label), `the automation area offers the 「${label}」 switch`);
  record(textsOf(offTree).includes('自动化'), 'the automation area is titled');
}
record(
  !textsOf(offTree).some((text) => text === '时段内') && !textsOf(offTree).some((text) => text === '深色'),
  'a disabled rule shows no skin pickers',
  '',
);

const onConfig = api.defaultAutomation();
onConfig.system.enabled = true;
onConfig.time.enabled = true;
onConfig.rotation.enabled = true;
onConfig.project.enabled = true;
const onTree = renderAutomation({ automation: onConfig, workspaceItems: [{ key: 'e:\\x\\project_7', label: 'Project_7', path: 'E:\\x\\Project_7' }], currentWorkspaceLabel: 'Project_7' });
const onTexts = textsOf(onTree);
for (const label of ['深色', '浅色', '时段内', '其余', 'Project_7', '仅收藏']) {
  record(onTexts.includes(label), `an enabled rule renders its control (${label})`);
}
const selects = [];
walk(onTree, (node) => {
  if (node.type === 'select') selects.push(node.props['aria-label']);
});
record(selects.length >= 5, 'every skin slot has a select', selects.join(' | '));
record(onTexts.some((text) => text.startsWith('优先级：')), 'the precedence is stated in the panel');
record(onTexts.some((text) => text.includes('工作区列表采集于')), 'the harvest time is shown, so a stale index is visible');
record(switchesOf(onTree).length === offLabels.length, 'the same four switches are present, now expanded');

const failed = results.filter((row) => !row.ok);
console.log(`\nchecks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  for (const row of failed) console.log(`FAILED ${row.label} ${row.detail}`);
  process.exitCode = 1;
}
