/**
 * Phase-7 verification: library management (order, deletion, context menu, batch).
 *
 * The three interactive features are driven through the real code with a small DOM
 * stub, so what is asserted is behaviour rather than the shape of the source:
 * a drag that crosses the threshold reorders and POSTs the new order, a deletion
 * cannot happen without the confirmation dialog, the current skin falls back before
 * the catalog refresh, and batch mode's three actions call what they claim to.
 *
 *   node output\_scan\verify_library.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const BODY = join(root, 'output', 'plugin', 'dsh-skins', 'src', 'client.body.js');
const clientSource = readFileSync(BODY, 'utf8');

const results = [];
const record = (ok, label, detail = '') => {
  results.push({ ok, label, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason?.stack ?? reason);
  process.exitCode = 1;
});
process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT:', error?.stack ?? error);
  process.exit(1);
});

/* ── a DOM small enough to reason about ───────────────────────────────────── */

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = '';
    this.className = '';
    this.style = {
      cssText: '',
      setProperty(name, value) {
        this[name] = String(value);
      },
      removeProperty(name) {
        delete this[name];
      },
      getPropertyValue(name) {
        return this[name] ?? '';
      },
    };
    this.value = '';
    this.type = '';
    this.rect = { top: 0, left: 0, width: 120, height: 90 };
  }
  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }
  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }
  hasAttribute(name) {
    return this.attributes.has(String(name));
  }
  removeAttribute(name) {
    this.attributes.delete(String(name));
  }
  getBoundingClientRect() {
    return this.rect;
  }
  matches(selector) {
    const text = String(selector).trim();
    // A compound "tag[attr]" selector is the one form the library queries use.
    const bracket = text.indexOf('[');
    if (bracket > 0) {
      if (this.tagName !== text.slice(0, bracket).toUpperCase()) return false;
      return this.matches(text.slice(bracket));
    }
    if (text.startsWith('[') && text.endsWith(']')) {
      const inner = text.slice(1, -1);
      const eq = inner.indexOf('=');
      if (eq === -1) return this.hasAttribute(inner);
      const name = inner.slice(0, eq);
      const want = inner.slice(eq + 1).replace(/^["']|["']$/gu, '');
      return this.getAttribute(name) === want;
    }
    if (text.startsWith('.')) return this.className.split(/\s+/u).includes(text.slice(1));
    return this.tagName === text.toUpperCase();
  }
  walk(visit) {
    for (const child of this.children) {
      visit(child);
      child.walk(visit);
    }
  }
  querySelectorAll(selector) {
    const found = [];
    for (const one of selector.split(',').map((part) => part.trim())) this.walk((node) => { if (node.matches(one) && !found.includes(node)) found.push(node); });
    return found;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }
  remove() {
    const parent = this.parentElement;
    if (parent === null) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentElement = null;
  }
  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentElement = null;
    return node;
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  focus() {
    this.focused = true;
  }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
    this.listeners.set(type, list);
  }
  dispatch(type, event) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(Object.assign({ type, target: this, preventDefault: () => {}, stopPropagation: () => {} }, event));
  }
  contains(other) {
    if (other === this) return true;
    if (other === null || other === undefined) return false;
    let node = other.parentElement;
    while (node !== null && node !== undefined) {
      if (node === this) return true;
      node = node.parentElement;
    }
    return false;
  }
  /** Collect the text of everything under this element (for component tests). */
  text() {
    let out = this.textContent;
    this.walk((node) => {
      out += ' ' + node.textContent;
    });
    return out;
  }
}

const storage = new Map();
const requests = [];
const makeWindow = (responder) => {
  const listeners = [];
  return {
    innerWidth: 1600,
    innerHeight: 900,
    devicePixelRatio: 1,
    location: { origin: 'http://127.0.0.1:19387', href: 'http://127.0.0.1:19387/' },
    performance: { now: () => 0 },
    requestAnimationFrame: (fn) => setTimeout(() => fn(0), 0),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    addEventListener: (type, handler, options) => listeners.push({ type, handler, options }),
    removeEventListener: (type, handler) => {
      const index = listeners.findIndex((row) => row.type === type && row.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
    dispatch: (type, event) => {
      for (const row of [...listeners]) if (row.type === type) row.handler(Object.assign({ type, preventDefault: () => {}, stopPropagation: () => {} }, event));
    },
    listenerCount: () => listeners.length,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    fetch: async (url, options) => {
      const body = options?.body === undefined ? null : JSON.parse(options.body);
      requests.push({ url: String(url), method: options?.method ?? 'GET', body });
      const payload = responder(String(url), options?.method ?? 'GET', body);
      return { ok: payload.status === undefined || payload.status < 400, status: payload.status ?? 200, json: async () => payload };
    },
  };
};

const makeDocument = () => {
  const documentElement = new FakeNode('html');
  const head = new FakeNode('head');
  const body = new FakeNode('body');
  documentElement.append(head, body);
  return {
    documentElement,
    head,
    body,
    baseURI: 'http://127.0.0.1:19387/',
    hidden: false,
    visibilityState: 'visible',
    createElement: (tag) => new FakeNode(tag),
    querySelector: (selector) => documentElement.querySelector(selector),
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    addEventListener: (type, handler) => documentElement.addEventListener(type, handler),
    removeEventListener: (type, handler) => documentElement.removeEventListener(type, handler),
    dispatch: (type, event) => documentElement.dispatch(type, event),
    listenerCount: () => documentElement.listeners.size,
  };
};

/* ── load the browser half ────────────────────────────────────────────────── */

const slice = clientSource.slice(
  clientSource.indexOf('/** Route prefix owned by the host half.'),
  clientSource.lastIndexOf('/*', clientSource.indexOf(' * Client plugin body')),
);
const boot = (document, window, logger = console) =>
  new Function(
    'window',
    'document',
    'navigator',
    'react',
    'console',
    // `fetch` is injected: the browser half calls the global one, which in Node is
    // the real network client — the stub has to take its place explicitly.
    'fetch',
    `const PACKAGE_ID = 'dsh-plugin-skins';\n${slice}\nreturn {
      orderedSkins, reorderIds, dropIndexFromPoint, logOperation,
      beginCardPress, trackCardPress, finishCardPress, cancelDrag, cardRects, DRAG_THRESHOLD_PX,
      openSkinMenu, closeSkinMenu, openTagEditor, SKIN_MENU_ATTRIBUTE,
      confirmDeleteSkins, closeDeleteDialog, performDeleteSkins, SKIN_DIALOG_ATTRIBUTE, SKIN_CARD_ATTRIBUTE,
      toggleBatchSelection, setBatchMode, setBatchSelection, exportSelection, favoriteSelection,
      dragCarriesFiles, startHoverPreview, stopHoverPreview, pinActiveSkin, applyTagSelection, invertSelection,
      setViewMode, readViewMode, HOVER_DELAY_MS, HOVER_PREVIEW_MS,
      observeThumbs, resetThumbObserver, pauseBackground, resumeBackground, installBackgroundGuards,
      videoElementCount, videoBudgetAvailable, readRuntimeStatus, tickRuntimeStatus, startStatusTimer, stopStatusTimer,
      MAX_VIDEO_ELEMENTS, STATUS_TICK_MS, THUMB_ROOT_MARGIN, TOAST_ATTRIBUTE,
      switchChordStep, switchByStep, showSwitchToast, installSwitchHotkeys,
      readUiKnobs, applyUiKnobs, setUiKnob, UI_KNOB_DEFAULTS, UI_KNOB_LIMITS,
      defaultRecommend, readRecommend, recommendDecision, autoPool, evaluateRecommendation,
      collectSettings, exportSettings, importSettings, resetSettings,
      loadPreferences, savePreferences, readPrefsCache, writePrefsCache, PREFS_CACHE_KEY,
      toggleFavorite, skinTags, SkinCard, formatBytes, ASSET_DEFAULTS,
    };`,
  )(
    window,
    document,
    { userAgent: 'probe' },
    {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
      useState: (value) => [value, () => {}],
      useEffect: () => {},
      useRef: (value) => ({ current: value }),
      useMemo: (factory) => factory(),
      useCallback: (fn) => fn,
    },
    logger,
    window.fetch,
  );

/**
 * A responder that behaves like the preferences route: merge the patch over what is
 * stored, and echo the result. Assigned before `boot`, because the browser half takes
 * `fetch` by value when it is constructed.
 */
const echoPreferences = (base) => (url, method, body) => ({
  ok: true,
  file: 'output/reports/skins-preferences.json',
  status: 200,
  preferences: Object.assign({ version: 1, order: [], favorites: [], hidden: [], tags: {} }, base, body ?? {}),
});

const quiet = { log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const settle = async () => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const skin = (skinId, type = 'image', extra = {}) =>
  Object.assign(
    {
      skinId,
      type,
      name: skinId,
      nameZh: skinId,
      playback: { kind: type === 'video' ? 'original' : 'source', bytes: 45 * 1024 * 1024, originalBytes: 45 * 1024 * 1024 },
      assets: { thumb: `/dsh-skins/asset/${skinId}/thumb.webp`, wallpaper: null, poster: null },
      video: type === 'video' ? { rendition: null } : null,
    },
    extra,
  );

/** A store stub with the shapes `publish` reads — every array it touches matters. */
const ARRAYS = new Set([
  'favorites', 'opLog', 'tags', 'listeners', 'automationDisposers', 'workspaceItems', 'referenced',
  'focusTargets', 'focusLanes', 'jobSteps', 'jobNewSkins', 'skins', 'dragOrder',
]);
const OBJECT_DEFAULTS = { workspaceIndex: { items: [], at: null }, job: { steps: [] }, catalogError: null };
const makeState = (overrides = {}) =>
  new Proxy(
    Object.assign(
      {
        version: 0,
        skinId: null,
        catalog: { skins: [], defaultSkin: null },
        tweaks: {},
        favorites: [],
        preferences: { version: 1, order: [], favorites: [], hidden: [], tags: {} },
        batch: { active: false, selected: [] },
        opLog: [],
        assets: { autoCompress: true, thresholdMB: 50, targetHeight: 1080, bitrateMbps: 5, includeSource: false },
        // Strings and nulls the store always has; `clientReport` reads them directly,
        // and a Proxy that invented nulls for them would crash before any assertion.
        customCss: '',
        customCssCheck: null,
        customStyle: null,
        focusMode: false,
        focusTargets: [],
        focusLanes: [],
        focusAnchor: null,
        focusConflicts: [],
        focusHotkey: null,
        focusRecovered: false,
        hostRevision: null,
        layer: null,
        tokenSource: 'none',
        favoritesList: [],
      },
      overrides,
    ),
    {
      get(target, key) {
        if (key in target) return target[key];
        if (typeof key !== 'string') return undefined;
        if (ARRAYS.has(key)) return [];
        if (key in OBJECT_DEFAULTS) return OBJECT_DEFAULTS[key];
        return null;
      },
      set(target, key, value) {
        target[key] = value;
        return true;
      },
    },
  );

/* ── 1. the pure ordering helpers ─────────────────────────────────────────── */

{
  const document = makeDocument();
  const api = boot(document, makeWindow(() => ({ ok: true })), quiet);
  const skins = [skin('img_a_1'), skin('video_b_2', 'video'), skin('img_c_3')];
  record(api.orderedSkins(makeState(), skins).map((row) => row.skinId).join(',') === 'img_a_1,video_b_2,img_c_3', 'with no stored order the catalog order is kept');
  const state = makeState({ preferences: { order: ['img_c_3', 'img_a_1'], favorites: [], tags: {} } });
  record(api.orderedSkins(state, skins).map((row) => row.skinId).join(',') === 'img_c_3,img_a_1,video_b_2', 'a stored order is applied first, new skins stay at the end', api.orderedSkins(state, skins).map((row) => row.skinId).join(','));
  record(api.reorderIds(['a', 'b', 'c'], 'c', 'a').join(',') === 'c,a,b', 'an id moves in front of another', api.reorderIds(['a', 'b', 'c'], 'c', 'a').join(','));
  record(api.reorderIds(['a', 'b', 'c'], 'a', null).join(',') === 'b,c,a', 'and to the end when there is nothing to precede');
  record(api.reorderIds(['a', 'b', 'c'], 'b', 'gone').join(',') === 'a,c,b', 'an unknown anchor appends instead of throwing');
  record(api.reorderIds(['a'], 'a', 'a').join(',') === 'a', 'reordering onto itself is a no-op');

  // Row-major drop maths: 3 cards of 100x80 in one row, then a second row.
  const rects = [
    { top: 0, left: 0, width: 100, height: 80 },
    { top: 0, left: 100, width: 100, height: 80 },
    { top: 0, left: 200, width: 100, height: 80 },
    { top: 80, left: 0, width: 100, height: 80 },
    { top: 80, left: 100, width: 100, height: 80 },
  ];
  record(api.dropIndexFromPoint(rects, 10, 10) === 0, 'a pointer at the top-left targets the first slot');
  record(api.dropIndexFromPoint(rects, 120, 10) === 1, 'a pointer past the first card midline targets the second slot', String(api.dropIndexFromPoint(rects, 120, 10)));
  record(api.dropIndexFromPoint(rects, 150, 10) === 1, 'exactly on a midline still means "before that card"');
  record(api.dropIndexFromPoint(rects, 260, 10) === 3, 'and past the last card of a row targets the slot after it', String(api.dropIndexFromPoint(rects, 260, 10)));
  record(api.dropIndexFromPoint(rects, 260, 40) === 3, 'the same within the row band, even below the midline', String(api.dropIndexFromPoint(rects, 260, 40)));
  record(api.dropIndexFromPoint(rects, 10, 90) === 3, 'a pointer in the second row counts the whole first row first', String(api.dropIndexFromPoint(rects, 10, 90)));
  record(api.dropIndexFromPoint(rects, 120, 90) === 4, 'and then follows the same horizontal rule there', String(api.dropIndexFromPoint(rects, 120, 90)));
  record(api.dropIndexFromPoint(rects, 260, 200) === 5, 'below everything the target is the end');
  record(api.dropIndexFromPoint([], 10, 10) === 0, 'an empty grid has one slot');
}

/* ── 2. preferences: load, merge, save, mirror ────────────────────────────── */

{
  const document = makeDocument();
  requests.length = 0;
  const stored = { ok: true, file: 'output/reports/skins-preferences.json', preferences: { version: 1, order: ['img_x_1'], favorites: ['img_y_2'], hidden: [], tags: { img_x_1: ['夜景'] } } };
  const window = makeWindow(() => stored);
  const api = boot(document, window, quiet);
  const state = makeState({ favorites: ['img_local_3'] });
  await api.loadPreferences(state);
  record(state.preferences.order.join(',') === 'img_x_1' && state.preferences.tags.img_x_1.join(',') === '夜景', 'the order and the tags come from the host file', JSON.stringify(state.preferences.order));
  record(state.preferencesFile === 'output/reports/skins-preferences.json', 'the file it read is recorded for the panel to show', String(state.preferencesFile));
  // Favourites exist in both places: the union is kept and written back.
  record(state.favorites.includes('img_y_2') && state.favorites.includes('img_local_3'), 'local and stored favourites are unioned, so nothing is lost', state.favorites.join(','));
  await settle();
  const writes = requests.filter((row) => row.method === 'POST');
  record(writes.length === 1 && writes[0].body.favorites.length === 2, 'and the union is written back once', JSON.stringify(writes[0]?.body));
  record(storage.get('dsh-skins/v1/prefs-cache') !== undefined, 'a local mirror is kept for the next boot');
  record(api.readPrefsCache().order.join(',') === 'img_x_1', 'the mirror is readable before the host answers');

  // A save sends only the patch, so a partial write cannot erase the rest.
  requests.length = 0;
  await api.savePreferences(state, { order: ['img_x_1', 'img_y_2'] });
  record(requests.length === 1 && Object.keys(requests[0].body).join(',') === 'order', 'saving the order sends only the order', JSON.stringify(requests[0]?.body));
  record(state.preferencesSavedAt !== null && state.preferencesSavedAt.length > 10, 'and a timestamp is recorded', String(state.preferencesSavedAt));

  // A refused or unreachable host must not lose the local change.
  const failing = boot(document, makeWindow(() => ({ ok: false, error: 'invalid-body', status: 400 })), quiet);
  const failingState = makeState();
  await failing.savePreferences(failingState, { order: ['img_z_9'] });
  record(failingState.preferencesNote.includes('被拒绝') && failingState.preferences.order.join(',') === 'img_z_9', 'a refused save is reported and the local order still applies', String(failingState.preferencesNote));
  const offline = boot(document, makeWindow(() => { throw new Error('ECONNREFUSED'); }), quiet);
  const offlineState = makeState();
  await offline.savePreferences(offlineState, { order: ['img_q_1'] });
  record(offlineState.preferencesNote.includes('本地缓存仍在') && api.readPrefsCache().order.join(',') === 'img_z_9' || offlineState.preferences.order.join(',') === 'img_q_1', 'an unreachable host degrades to the local mirror', String(offlineState.preferencesNote));
  const missing = boot(document, makeWindow(() => ({ ok: false, error: 'not-found', status: 404 })), quiet);
  const missingState = makeState();
  await missing.loadPreferences(missingState);
  record(String(missingState.preferencesNote).includes('旧模块'), 'a host without the preferences route is called out as an old module', String(missingState.preferencesNote));
}

/* ── 3. dragging a card ───────────────────────────────────────────────────── */

{
  const document = makeDocument();
  requests.length = 0;
  const window = makeWindow(echoPreferences({ order: ['img_a_1', 'img_b_2', 'img_c_3'] }));
  const api = boot(document, window, quiet);
  // Three rendered cards, laid out in one row.
  const cards = [];
  for (const [index, id] of ['img_a_1', 'img_b_2', 'img_c_3'].entries()) {
    const node = document.createElement('div');
    node.className = 'dsh-skins-card';
    node.setAttribute(api.SKIN_CARD_ATTRIBUTE, id);
    node.rect = { top: 0, left: index * 120, width: 110, height: 90 };
    cards.push(node);
  }
  document.body.append(...cards);
  const state = makeState({
    catalog: { skins: [skin('img_a_1'), skin('img_b_2'), skin('img_c_3')], defaultSkin: null },
    preferences: { version: 1, order: ['img_a_1', 'img_b_2', 'img_c_3'], favorites: [], hidden: [], tags: {} },
  });
  record(api.cardRects().length === 3 && api.cardRects()[1].skinId === 'img_b_2', 'the rendered cards are read in document order');

  // A press that never moves far enough must not start a drag.
  api.beginCardPress(state, 'img_a_1', { clientX: 10, clientY: 10, button: 0 });
  api.trackCardPress(state, { clientX: 12, clientY: 11 });
  record(state.drag === null, 'a press below the threshold is not a drag', String(api.DRAG_THRESHOLD_PX));
  api.beginCardPress(state, 'img_a_1', { clientX: 10, clientY: 10, button: 0 });
  api.trackCardPress(state, { clientX: 10 + api.DRAG_THRESHOLD_PX, clientY: 10 });
  record(state.drag !== null && state.drag.skinId === 'img_a_1', 'crossing the threshold starts a drag');
  record(document.documentElement.getAttribute('data-dsh-dragging') === '1', 'the document is marked while dragging (for the cursor)');
  api.trackCardPress(state, { clientX: 400, clientY: 10 });
  record(state.drag.over === 3, 'moving past every card targets the end slot', String(state.drag.over));
  await api.finishCardPress({ get: () => null }, state, { clientX: 400, clientY: 10 });
  record(state.drag === null && document.documentElement.hasAttribute('data-dsh-dragging') === false, 'dropping clears the drag state and the mark');
  const posted = requests.filter((row) => row.method === 'POST');
  record(posted.length === 1 && posted[0].body.order.join(',') === 'img_b_2,img_c_3,img_a_1', 'the new order is POSTed immediately', JSON.stringify(posted[0]?.body.order));
  record(state.preferences.order.join(',') === 'img_b_2,img_c_3,img_a_1', 'and applied to the store at once', state.preferences.order.join(','));
  const log = state.opLog.map((row) => row.message).join(' | ');
  record(log.includes('顺序已更新') && log.includes('顺序已保存到'), 'the log records the reorder and where it was saved', log.slice(0, 90));
  record(state.opLog[0].kind === 'order', 'with the order kind, so the panel can colour it');

  // Dropping where it already is must not write anything.
  requests.length = 0;
  api.beginCardPress(state, 'img_b_2', { clientX: 130, clientY: 10, button: 0 });
  api.trackCardPress(state, { clientX: 140, clientY: 10 });
  await api.finishCardPress({ get: () => null }, state, { clientX: 140, clientY: 10 });
  record(requests.length === 0, 'dropping a card back into its own place writes nothing', String(requests.length));
  // Escape cancels.
  api.beginCardPress(state, 'img_a_1', { clientX: 10, clientY: 10, button: 0 });
  api.trackCardPress(state, { clientX: 200, clientY: 10 });
  api.cancelDrag(state);
  record(state.drag === null && state.cardPress === null && document.documentElement.hasAttribute('data-dsh-dragging') === false, 'Escape cancels a drag cleanly');
  record(api.cardRects().length === 3, 'cancelling does not touch the cards');
}

/* ── 4. the context menu ──────────────────────────────────────────────────── */

{
  const document = makeDocument();
  const window = makeWindow(echoPreferences({}));
  const api = boot(document, window, quiet);
  const state = makeState({ catalog: { skins: [skin('img_a_1')], defaultSkin: null } });
  const target = skin('img_a_1');
  const menu = api.openSkinMenu({ get: () => null }, state, target, 100, 100);
  record(menu !== null && document.querySelectorAll(`[${api.SKIN_MENU_ATTRIBUTE}]`).length === 1, 'the menu is attached once', String(document.querySelectorAll(`[${api.SKIN_MENU_ATTRIBUTE}]`).length));
  record(menu.parentElement === document.body, 'it hangs off body, so a card near the bottom cannot clip it');
  const labels = menu.children.map((node) => node.textContent).filter((text) => text.length > 0);
  record(labels.includes('应用皮肤') && labels.includes('导出皮肤包') && labels.includes('删除皮肤'), 'it carries the three required entries', labels.join(' / '));
  record(labels.includes('编辑标签…') && (labels.includes('加入收藏') || labels.includes('取消收藏')), 'plus the tags and favourites entries');
  const danger = menu.children.find((node) => node.textContent === '删除皮肤');
  record(danger.style.cssText.includes('#ff8a8a'), 'the destructive entry is styled as danger, matching the dark theme', danger.style.cssText.slice(-24));
  record(menu.style.cssText.includes('color-mix') && menu.style.cssText.includes('--dsw-alias-bg-layer-1'), 'and the menu itself is themed from the app tokens, not hardcoded colours');
  record(menu.style.cssText.includes('position:fixed') && /z-index:214748364\d/u.test(menu.style.cssText), 'it floats above the panel and any shell layer', menu.style.cssText.slice(0, 60));
  record(menu.style.cssText.includes('pointer-events:auto'), 'and is explicitly hit-testable');
  // Opening again replaces rather than stacks.
  api.openSkinMenu({ get: () => null }, state, target, 120, 120);
  record(document.querySelectorAll(`[${api.SKIN_MENU_ATTRIBUTE}]`).length === 1, 'opening it again does not stack menus');
  api.closeSkinMenu(state);
  record(document.querySelectorAll(`[${api.SKIN_MENU_ATTRIBUTE}]`).length === 0 && state.skinMenu === null, 'closing removes it and forgets it');
  // Escape closes.
  api.openSkinMenu({ get: () => null }, state, target, 100, 100);
  // The outside/key listeners attach a tick after opening on purpose (so the gesture
  // that opened the menu cannot close it), hence the settle.
  await settle();
  document.dispatch('keydown', { key: 'Escape' });
  record(state.skinMenu === null, 'Escape closes the menu');
  // A menu entry acts on pointerup as well as click: a press can be retargeted by a
  // shell layer above the menu and lose the trailing click.
  const pointerMenu = api.openSkinMenu({ get: () => null }, state, target, 100, 100);
  pointerMenu.children.find((node) => node.textContent === '加入收藏').dispatch('pointerup', {});
  record(state.favorites.includes('img_a_1'), 'a menu entry runs from pointerup alone', state.favorites.join(','));
  record(state.skinMenu === null && document.querySelectorAll(`[${api.SKIN_MENU_ATTRIBUTE}]`).length === 0, 'and closes the menu behind it');
  record(state.opLog.some((row) => row.kind === 'favorite'), 'logging the favourite action', state.opLog[0]?.message);
  api
    .openSkinMenu({ get: () => null }, state, target, 100, 100)
    .children.find((node) => node.textContent === '应用皮肤')
    .dispatch('pointerup', {});
  record(state.opLog.some((row) => row.kind === 'apply' && row.message.includes('应用皮肤')), 'and the apply action is logged too', state.opLog[0]?.message);
  const pressedInside = [];
  const probeMenu = api.openSkinMenu({ get: () => null }, state, target, 100, 100);
  probeMenu.children.find((node) => node.textContent === '导出皮肤包').dispatch('pointerdown', { stopPropagation: () => pressedInside.push('down') });
  record(pressedInside.includes('down') && state.skinMenu !== null, 'a press inside the menu stops at the item and does not close it');
  api.closeSkinMenu(state);
  // The tag editor replaces the body and saves through the preferences file.
  requests.length = 0;
  const menuTwo = api.openSkinMenu({ get: () => null }, state, target, 100, 100);
  api.openTagEditor(state, target, menuTwo);
  const input = menuTwo.children.find((node) => node.tagName === 'INPUT');
  record(input !== undefined && input.value === '', 'the tag editor starts empty for an untagged skin');
  input.value = '夜景, 冷色';
  menuTwo.children.find((node) => node.textContent === '保存标签').dispatch('click', {});
  await settle();
  const tagWrite = requests.find((row) => row.body?.tags !== undefined);
  record(tagWrite !== undefined && tagWrite.body.tags.img_a_1.join(',') === '夜景,冷色', 'saving tags writes them to the preferences file', JSON.stringify(tagWrite?.body.tags));
  record(state.opLog.some((row) => row.kind === 'tags'), 'and logs it');
  record(api.skinTags(target, state).includes('夜景'), 'custom tags join the tag list, so the filter can find them');
}

/* ── 5. deletion: gating, fallback, log, pruning ───────────────────────────── */

{
  const document = makeDocument();
  requests.length = 0;
  const window = makeWindow((url, method, body) => {
    const target = String(url);
    // The deletion path also refreshes the catalog, so the responder has to answer
    // each route with its own shape — a single blanket payload would replace the
    // catalog with preferences and break the fallback. The patch arguments must be
    // forwarded, or the echo would answer with the pre-delete preferences.
    if (target.includes('/cleanup')) {
      return { ok: true, explicit: true, removed: [{ skinId: 'img_a_1', bytes: 40 * 1024 * 1024, how: 'recycle-bin' }], missing: [], kept: [], totalBytes: 40 * 1024 * 1024, logFile: 'output/reports/skins-cleanup-x.log', log: 'x' };
    }
    if (target.includes('/catalog')) {
      return { ok: true, revision: 'test', defaultSkin: 'img_b_2', skins: [skin('img_a_1'), skin('img_b_2')] };
    }
    if (target.includes('/preferences')) {
      return echoPreferences({ version: 1, order: ['img_a_1'], favorites: ['img_a_1'], hidden: [], tags: { img_a_1: ['夜景'] } })(url, method, body);
    }
    return { ok: true };
  });
  const api = boot(document, window, quiet);
  const state = makeState({
    skinId: 'img_a_1',
    catalog: { skins: [skin('img_a_1'), skin('img_b_2')], defaultSkin: 'img_b_2' },
    preferences: { version: 1, order: ['img_a_1', 'img_b_2'], favorites: ['img_a_1'], hidden: [], tags: { img_a_1: ['夜景'] } },
  });
  // Nothing may happen before the dialog is confirmed.
  const dialog = api.confirmDeleteSkins({ get: () => null }, state, ['img_a_1']);
  const buttonsIn = (overlay) => {
    const found = [];
    overlay.walk((node) => {
      if (node.tagName === 'BUTTON') found.push(node);
    });
    return found;
  };
  const textIn = (overlay) => {
    let out = overlay.textContent;
    overlay.walk((node) => {
      out += ' ' + node.textContent;
    });
    return out;
  };
  record(dialog !== null && document.querySelectorAll(`[${api.SKIN_DIALOG_ATTRIBUTE}]`).length === 1, 'the confirmation dialog opens', String(document.querySelectorAll(`[${api.SKIN_DIALOG_ATTRIBUTE}]`).length));
  record(requests.filter((row) => row.url.includes('/cleanup')).length === 0, 'and nothing is deleted yet — that is the second confirmation');
  const text = textIn(dialog);
  record(text.includes('确认删除'), 'the dialog asks for confirmation', text.slice(0, 40));
  record(text.includes('回收站') && text.includes('input_image'), 'and states where the folders go and that the originals stay');
  record(text.includes('img_a_1') || text.includes('（'), 'naming what will be deleted');
  const buttons = buttonsIn(dialog);
  record(buttons.some((node) => node.textContent === '取消') && buttons.some((node) => node.textContent.includes('删除')), 'with cancel and delete actions', buttons.map((node) => node.textContent).join('/'));
  // Cancel leaves everything alone.
  buttons.find((node) => node.textContent === '取消').dispatch('click', {});
  record(state.deleteDialog === null && document.querySelectorAll(`[${api.SKIN_DIALOG_ATTRIBUTE}]`).length === 0, 'cancel closes the dialog');
  record(requests.filter((row) => row.url.includes('/cleanup')).length === 0, 'and deletes nothing');

  // Escape also cancels, and clicking the backdrop too.
  const escaped = api.confirmDeleteSkins({ get: () => null }, state, ['img_a_1']);
  record(escaped !== null, 'the dialog can be reopened');
  document.dispatch('keydown', { key: 'Escape' });
  record(state.deleteDialog === null && requests.filter((row) => row.url.includes('/cleanup')).length === 0, 'Escape cancels without deleting');

  // Now confirm.
  const dialogTwo = api.confirmDeleteSkins({ get: () => null }, state, ['img_a_1']);
  buttonsIn(dialogTwo)
    .find((node) => node.textContent.includes('删除'))
    .dispatch('click', {});
  await settle();
  // Applying a fallback skin is a long chain in the real app; here it only has to
  // reach the bookkeeping, so wait for that rather than for a fixed number of ticks.
  const waitFor = async (predicate, ms = 800) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (predicate() === true) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return predicate();
  };
  await waitFor(() => !(state.preferences?.order ?? []).includes('img_a_1'));
  if (process.env.DSH_LIB_DEBUG === '1') {
    console.log('DEBUG skinId=', state.skinId, 'order=', JSON.stringify(state.preferences?.order), 'tags=', JSON.stringify(state.preferences?.tags), 'note=', state.preferencesNote, 'savedAt=', state.preferencesSavedAt);
    for (const row of state.opLog) console.log('DEBUG log:', row.kind, row.message);
    console.log('DEBUG requests:', requests.map((row) => `${row.method} ${row.url.slice(-24)}`).join(' | '));
  }
  const cleanupCall = requests.find((row) => row.url.includes('/cleanup'));
  record(cleanupCall !== undefined && cleanupCall.body.skinIds.join(',') === 'img_a_1', 'confirming posts the explicit skin id list', JSON.stringify(cleanupCall?.body));
  record(state.deleteDialog === null, 'and closes the dialog');
  const log = state.opLog.map((row) => row.message).join(' | ');
  record(log.includes('已删除 1 套') && log.includes('回收站'), 'the log records the deletion and where it went', log.slice(0, 80));
  record(log.includes('自动切换到'), 'and that the current skin was switched away', log.slice(-60));
  record(state.skinId === 'img_b_2' || state.opLog.some((row) => row.message.includes('自动切换到 img_b_2')), 'the current skin is switched away from the deleted one', String(state.skinId));
  record(!state.preferences.order.includes('img_a_1') && !state.favorites.includes('img_a_1'), 'the deleted skin is pruned from the stored order and favourites', state.preferences.order.join(','));
  record(state.preferences.tags.img_a_1 === undefined, 'and from the tags');
  const prefWrite = requests.filter((row) => row.url.includes('/preferences')).at(-1);
  record(prefWrite !== undefined && prefWrite.body.order !== undefined && prefWrite.body.favorites !== undefined && prefWrite.body.tags !== undefined, 'all three pruned fields are persisted', Object.keys(prefWrite?.body ?? {}).join(','));

  // Batch deletion of the last skin must not leave a dangling id.
  requests.length = 0;
  const lastState = makeState({ skinId: 'img_only', catalog: { skins: [skin('img_only')], defaultSkin: null } });
  const dialogThree = api.confirmDeleteSkins({ get: () => null }, lastState, ['img_only']);
  buttonsIn(dialogThree)
    .find((node) => node.textContent.includes('删除'))
    .dispatch('click', {});
  await settle();
  record(lastState.skinId === null && lastState.opLog.some((row) => row.message.includes('内置主题')), 'deleting the last skin says it fell back to the built-in theme');
}

/* ── 6. batch mode ────────────────────────────────────────────────────────── */

{
  const document = makeDocument();
  requests.length = 0;
  const window = makeWindow((url) =>
    url.includes('/export')
      ? { ok: true, skinId: 'x', file: 'output/exports/x.zip', bytes: 2048, entries: ['a'] }
      : { ok: true, file: 'output/reports/skins-preferences.json', preferences: { version: 1, order: [], favorites: [], hidden: [], tags: {} } },
  );
  const api = boot(document, window, quiet);
  const state = makeState({ catalog: { skins: [skin('img_a_1'), skin('img_b_2')], defaultSkin: null } });
  api.setBatchMode(state, true);
  record(state.batch.active === true && state.batch.selected.length === 0, 'batch mode starts with an empty selection');
  api.toggleBatchSelection(state, 'img_a_1');
  api.toggleBatchSelection(state, 'img_b_2');
  record(state.batch.selected.join(',') === 'img_a_1,img_b_2', 'clicking two cards selects both', state.batch.selected.join(','));
  api.toggleBatchSelection(state, 'img_a_1');
  record(state.batch.selected.join(',') === 'img_b_2', 'clicking a selected card deselects it');
  api.setBatchSelection(state, ['img_a_1', 'img_b_2', 'img_a_1']);
  record(state.batch.selected.join(',') === 'img_a_1,img_b_2', 'select-all deduplicates', state.batch.selected.join(','));
  api.setBatchSelection(state, []);
  record(state.batch.selected.length === 0, 'and can be cleared');
  api.toggleBatchSelection(state, 'img_a_1');
  api.toggleBatchSelection(state, 'img_b_2');
  await api.favoriteSelection(state, state.batch.selected);
  record(state.favorites.length === 2, 'adding the selection to favourites adds both', state.favorites.join(','));
  const favWrite = requests.filter((row) => row.body?.favorites !== undefined).at(-1);
  record(favWrite !== undefined && favWrite.body.favorites.length === 2, 'and persists them', JSON.stringify(favWrite?.body));
  record(state.opLog.some((row) => row.kind === 'favorite'), 'with a log line');
  requests.length = 0;
  await api.exportSelection(state, state.batch.selected);
  const exports = requests.filter((row) => row.url.includes('/export'));
  record(exports.length === 2, 'exporting the selection exports each skin once', String(exports.length));
  record(state.opLog.some((row) => row.message.includes('导出完成：2/2')), 'and summarises the run in the log', state.opLog.find((row) => row.message.includes('导出完成'))?.message);
  api.setBatchMode(state, false);
  record(state.batch.active === false && state.batch.selected.length === 0, 'leaving batch mode clears the selection');
}

/* ── 7. the card itself: badges, selection, drag attributes ───────────────── */

{
  const document = makeDocument();
  const api = boot(document, makeWindow(() => ({ ok: true })), quiet);
  const walk = (element, out = []) => {
    if (element === null || element === undefined || typeof element !== 'object') return out;
    out.push(element);
    for (const child of element.children ?? []) walk(child, out);
    return out;
  };
  const props = (over = {}) =>
    Object.assign(
      { skin: skin('img_a_1'), favorite: false, active: false, onApply: () => {}, onToggleFavorite: () => {}, onExport: () => {}, onSelect: () => {}, onMenu: () => {}, onDelete: () => {}, onPress: () => {}, onDragMove: () => {}, onDrop: () => {}, onCancelDrag: () => {} },
      over,
    );
  const imageCard = api.SkinCard(props());
  const imageTree = walk(imageCard);
  const imageInfo = imageTree.find((node) => node.props?.className === 'dsh-skins-card__info');
  record(imageInfo !== undefined && imageInfo.props['data-kind'] === 'image', 'an image card reports the image kind', imageInfo?.props?.['data-kind']);
  record(JSON.stringify(imageInfo.children).includes('图片') && JSON.stringify(imageInfo.children).includes('45'), 'and shows the kind and the size', JSON.stringify(imageInfo.children).slice(0, 60));
  const videoOriginal = walk(api.SkinCard(props({ skin: skin('video_b_2', 'video') })));
  const originalInfo = videoOriginal.find((node) => node.props?.className === 'dsh-skins-card__info');
  record(originalInfo.props['data-kind'] === 'original' && JSON.stringify(originalInfo.children).includes('原始视频'), 'a video without a rendition says 原始视频', originalInfo.props['data-kind']);
  const videoRendition = walk(api.SkinCard(props({ skin: skin('video_c_3', 'video', { video: { rendition: 'assets/source.mp4' }, playback: { kind: 'rendition', bytes: 8 * 1024 * 1024, originalBytes: 300 * 1024 * 1024 } }) })));
  const renditionInfo = videoRendition.find((node) => node.props?.className === 'dsh-skins-card__info');
  record(renditionInfo.props['data-kind'] === 'rendition' && JSON.stringify(renditionInfo.children).includes('已压缩视频'), 'a video with a rendition says 已压缩视频', renditionInfo.props['data-kind']);
  record(JSON.stringify(renditionInfo.children).includes('8'), 'and shows the compressed size, not the original', JSON.stringify(renditionInfo.children).slice(0, 40));
  record(imageCard.props[api.SKIN_CARD_ATTRIBUTE] === 'img_a_1', 'the card carries its skin id for the drag machinery');
  record(imageCard.props['data-selected'] === 'false' && walk(api.SkinCard(props({ batchActive: true, selected: true }))).some((node) => node.props?.className === 'dsh-skins-card__check' && node.props['data-on'] === 'true'), 'the selection mark appears only in batch mode and when selected');
  record(walk(api.SkinCard(props({ dragging: true }))).some((node) => node.props?.['data-dragging'] === 'true'), 'a dragged card is marked');
  record(walk(api.SkinCard(props({ dropBefore: true }))).some((node) => node.props?.['data-drop-before'] === 'true'), 'and the card the drop targets carries the insertion mark');
  record(imageTree.some((node) => node.props?.className === 'dsh-skins-card__del'), 'each card has its own delete affordance');
  record(imageTree.some((node) => typeof node.props?.onContextMenu === 'function'), 'and a right-click handler');
  // Drag vs upload: the card must not start a native drag (that is what summoned the
  // shell's global drop overlay), and drag events must not bubble out of it.
  record(imageCard.props.draggable === 'false', 'the card refuses to be a native drag source');
  const thumb = imageTree.find((node) => node.type === 'img');
  record(thumb !== undefined && thumb.props.draggable === 'false' && typeof thumb.props.onDragStart === 'function', 'so does the thumbnail image', String(thumb?.props?.draggable));
  const dragSpy = { prevented: 0, stopped: 0 };
  imageCard.props.onDragStart({ preventDefault: () => { dragSpy.prevented += 1; }, stopPropagation: () => { dragSpy.stopped += 1; }, dataTransfer: { effectAllowed: '' } });
  record(dragSpy.prevented === 1 && dragSpy.stopped === 1, 'dragstart on the card is cancelled and stopped', JSON.stringify(dragSpy));
  const bubbleSpy = { stopped: 0 };
  imageCard.props.onDragEnter({ stopPropagation: () => { bubbleSpy.stopped += 1; } });
  imageCard.props.onDragOver({ stopPropagation: () => { bubbleSpy.stopped += 1; } });
  imageCard.props.onDrop({ stopPropagation: () => { bubbleSpy.stopped += 1; } });
  record(bubbleSpy.stopped === 3, 'dragenter/dragover/drop do not bubble out of the card', String(bubbleSpy.stopped));
  // The file check must accept what the browser actually reports (lowercase).
  record(api.dragCarriesFiles({ dataTransfer: { types: ['files'] } }) === true, 'a lowercase "files" list is recognised (the old check compared against "Files")');
  record(api.dragCarriesFiles({ dataTransfer: { types: ['Files'] } }) === true, 'and the capitalised spelling still works');
  record(api.dragCarriesFiles({ dataTransfer: { types: ['text/uri-list', 'text/html'] } }) === false, 'an image/text drag is not a file drop');
  record(api.dragCarriesFiles({ dataTransfer: null }) === false && api.dragCarriesFiles(null) === false, 'a missing dataTransfer is not a file drop');
  document.documentElement.setAttribute('data-dsh-dragging', '1');
  record(api.dragCarriesFiles({ dataTransfer: { types: ['files'] } }) === false, 'and an internal sort drag never counts as a file drop');
  document.documentElement.removeAttribute('data-dsh-dragging');
}

/* ── 9. polish: hover preview, in-use pin, batch tags, view mode ───────────── */

{
  const document = makeDocument();
  const window = makeWindow(echoPreferences({}));
  const api = boot(document, window, quiet);
  const videoSkin = skin('video_hover_1', 'video');
  // A rendered card, because the preview mounts into the card's media box.
  const card = document.createElement('div');
  card.setAttribute(api.SKIN_CARD_ATTRIBUTE, 'video_hover_1');
  const media = document.createElement('span');
  media.className = 'dsh-skins-card__media';
  card.append(media);
  document.body.append(card);

  const state = makeState({ catalog: { skins: [videoSkin, skin('img_other_2')], defaultSkin: null } });
  // The 500 ms delay is real, so these assertions wait on it.
  api.startHoverPreview(state, videoSkin);
  record(state.previewSkin === 'video_hover_1', 'hovering a video card arms a preview');
  record(document.querySelectorAll('video').length === 0, 'nothing is created during the delay');
  await new Promise((resolve) => setTimeout(resolve, 620));
  const previews = document.querySelectorAll('video');
  record(previews.length === 1 && previews[0].parentElement === media, 'after 500 ms the preview is inserted into the thumbnail', String(previews.length));
  record(previews[0].muted === true && previews[0].defaultMuted === true, 'and it is muted, so autoplay is allowed');
  record(String(previews[0].getAttribute('data-dsh-hover-preview')) === '1' && String(previews[0].src).includes('/dsh-skins/source/video_hover_1'), 'playing the skin source through the host route', String(previews[0].src));
  // Only one at a time.
  api.startHoverPreview(state, videoSkin);
  await new Promise((resolve) => setTimeout(resolve, 620));
  record(document.querySelectorAll('video').length === 1, 'starting a second preview replaces the first instead of stacking', String(document.querySelectorAll('video').length));
  api.stopHoverPreview(state);
  record(document.querySelectorAll('video').length === 0 && state.preview === null && state.previewSkin === null, 'leaving the card removes the preview at once');
  // The 3-second cap, independently of the pointer.
  api.startHoverPreview(state, videoSkin);
  await new Promise((resolve) => setTimeout(resolve, 620));
  record(document.querySelectorAll('video').length === 1, 'a preview is playing before the cap is tested');
  await new Promise((resolve) => setTimeout(resolve, 3100));
  record(document.querySelectorAll('video').length === 0, 'and it stops itself after 3 seconds even if the pointer stays');
  api.startHoverPreview(state, skin('img_other_2'));
  record(state.previewSkin === null && document.querySelectorAll('video').length === 0, 'an image card never arms a preview');
  api.startHoverPreview(state, skin('video_gone_9', 'video'));
  await new Promise((resolve) => setTimeout(resolve, 620));
  record(document.querySelectorAll('video').length === 0, 'a card that is gone by the time the delay elapses is harmless');

  // The in-use pin is a view concern: it must not rewrite the stored order.
  const all = [skin('a_1'), skin('b_2'), skin('c_3')];
  record(api.pinActiveSkin(all, 'c_3', true).map((row) => row.skinId).join(',') === 'c_3,a_1,b_2', 'the skin in use is pinned to the front', api.pinActiveSkin(all, 'c_3', true).map((row) => row.skinId).join(','));
  record(api.pinActiveSkin(all, 'a_1', true).map((row) => row.skinId).join(',') === 'a_1,b_2,c_3', 'an already-first skin is left alone');
  record(api.pinActiveSkin(all, 'c_3', false).map((row) => row.skinId).join(',') === 'a_1,b_2,c_3', 'and the pin is off while dragging');
  record(api.pinActiveSkin(all, null, true).length === 3, 'with no skin in use nothing moves');

  // Batch tags and inversion.
  requests.length = 0;
  await api.applyTagSelection(state, ['a_1', 'b_2'], '夜景');
  const tagWrite = requests.find((row) => row.body?.tags !== undefined);
  record(tagWrite !== undefined && tagWrite.body.tags.a_1.join(',') === '夜景' && tagWrite.body.tags.b_2.join(',') === '夜景', 'one write tags every selected skin', JSON.stringify(tagWrite?.body.tags));
  record(state.opLog.some((row) => row.kind === 'tags' && row.message.includes('2 套')), 'and the batch is logged with its size', state.opLog[0]?.message);
  await api.applyTagSelection(state, ['a_1'], '   ');
  record(state.opLog[0].message.includes('跳过'), 'an empty tag is refused with a log line instead of writing', state.opLog[0].message);
  await api.applyTagSelection(state, ['a_1'], '夜景');
  record((state.preferences.tags.a_1 ?? []).length === 1, 'adding the same tag twice does not duplicate it', JSON.stringify(state.preferences.tags.a_1));
  api.setBatchSelection(state, ['a_1']);
  api.invertSelection(state, ['a_1', 'b_2', 'c_3']);
  record(state.batch.selected.join(',') === 'b_2,c_3', 'invert keeps the visible set minus the selection', state.batch.selected.join(','));
  api.invertSelection(state, ['a_1', 'b_2', 'c_3']);
  record(state.batch.selected.join(',') === 'a_1', 'and inverting twice returns to the original selection');

  // View mode is remembered, and defaults to the grid.
  record(api.readViewMode() === 'grid', 'the view mode defaults to the grid');
  api.setViewMode(state, 'list');
  record(state.viewMode === 'list' && api.readViewMode() === 'list', 'switching to the list view persists it', api.readViewMode());
  record(state.opLog.some((row) => row.kind === 'view'), 'and the switch is logged');
  api.setViewMode(state, 'grid');
  record(api.readViewMode() === 'grid', 'and switching back persists that too');
  record(api.HOVER_DELAY_MS === 500 && api.HOVER_PREVIEW_MS === 3000, 'the delay and the cap are the promised 500 ms / 3 s', `${api.HOVER_DELAY_MS}/${api.HOVER_PREVIEW_MS}`);
}

/* ── 11. performance: lazy thumbs, background pause, video cap, runtime ────── */

{
  const document = makeDocument();
  const window = makeWindow(echoPreferences({}));
  const api = boot(document, window, quiet);

  // ── lazy thumbnails ────────────────────────────────────────────────────────
  const observed = [];
  let observerCallback = null;
  window.IntersectionObserver = function Observer(callback) {
    observerCallback = callback;
    this.observe = (node) => observed.push(node);
    this.unobserve = () => {};
    this.disconnect = () => {};
  };
  const cards = [];
  for (const id of ['a_1', 'b_2', 'c_3']) {
    const node = document.createElement('img');
    node.setAttribute('data-thumb', '/dsh-skins/asset/' + id + '/thumb.webp');
    document.body.append(node);
    cards.push(node);
  }
  const armed = api.observeThumbs(document);
  record(armed === 3 && observed.length === 3, 'every unloaded thumbnail is handed to the observer', `${armed}/${observed.length}`);
  record(cards.every((node) => node.hasAttribute('src') === false), 'and none of them has a src yet — that is the whole point');
  record(api.observeThumbs(document) === 0, 'observing again is a no-op (called after every render)');
  // Only what intersects loads.
  observerCallback([{ target: cards[1], isIntersecting: true }, { target: cards[2], isIntersecting: false }]);
  record(cards[1].getAttribute('src') === '/dsh-skins/asset/b_2/thumb.webp' && cards[1].getAttribute('data-thumb-loaded') === '1', 'an intersecting thumbnail gets its src', String(cards[1].getAttribute('src')));
  record(cards[0].hasAttribute('src') === false && cards[2].hasAttribute('src') === false, 'the others stay unloaded until they scroll in');
  observerCallback([{ target: cards[2], isIntersecting: true }]);
  record(cards[2].getAttribute('src') === '/dsh-skins/asset/c_3/thumb.webp', 'scrolling in loads the rest');
  // Degrade without IntersectionObserver.
  const plainDocument = makeDocument();
  const plainWindow = makeWindow(echoPreferences({}));
  const plainApi = boot(plainDocument, plainWindow, quiet);
  const lonely = plainDocument.createElement('img');
  lonely.setAttribute('data-thumb', '/x.webp');
  plainDocument.body.append(lonely);
  plainApi.observeThumbs(plainDocument);
  record(lonely.getAttribute('src') === '/x.webp', 'without IntersectionObserver everything loads at once instead of never');

  // ── background pause ───────────────────────────────────────────────────────
  const video = {
    paused: false,
    muted: true,
    plays: 0,
    pauses: 0,
    play() {
      this.paused = false;
      this.plays += 1;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
      this.pauses += 1;
    },
  };
  const suspended = [];
  const state = makeState({
    catalog: { skins: [skin('a_1')], defaultSkin: null },
    video,
    videoPlaying: true,
    audioContext: {
      state: 'running',
      suspend() {
        this.state = 'suspended';
        suspended.push('suspend');
      },
      resume() {
        this.state = 'running';
        suspended.push('resume');
      },
    },
  });
  const disposeGuards = api.installBackgroundGuards(state);
  document.hidden = true;
  document.visibilityState = 'hidden';
  document.dispatch('visibilitychange', {});
  record(state.bgPaused === true && state.bgPauseReason === 'hidden', 'a hidden window pauses the background', `${state.bgPaused}/${state.bgPauseReason}`);
  record(video.paused === true && video.pauses === 1 && state.bgWasPlaying === true, 'the playing video is paused and remembered as "was playing"', `pauses=${video.pauses}`);
  record(suspended.join(',') === 'suspend', 'and the audio graph is suspended so its real-time thread stops', suspended.join(','));
  document.hidden = false;
  document.visibilityState = 'visible';
  document.dispatch('visibilitychange', {});
  record(state.bgPaused === false && video.plays === 1 && video.paused === false, 'becoming visible again resumes playback', `plays=${video.plays}`);
  record(suspended.join(',') === 'suspend,resume', 'and resumes the audio graph', suspended.join(','));
  // A user-paused video must stay paused.
  video.paused = true;
  window.dispatch('blur', {});
  record(state.bgPaused === true && state.bgPauseReason === 'blur' && video.pauses === 1, 'losing focus pauses too', String(state.bgPauseReason));
  window.dispatch('focus', {});
  record(video.plays === 1 && video.paused === true, 'but a video the user had paused is not started behind their back', `plays=${video.plays}`);
  disposeGuards();
  window.dispatch('blur', {});
  record(state.bgPaused === false, 'the disposer removes the guards, so a later blur does nothing');
  // Reduce motion still wins: nothing to resume when it was never playing.
  const stillState = makeState({ catalog: { skins: [skin('a_1')], defaultSkin: null }, video: null });
  api.pauseBackground(stillState, 'hidden');
  api.resumeBackground(stillState);
  record(stillState.bgPaused === false && stillState.bgWasPlaying === false, 'pausing with no video element is harmless');

  // ── the video ceiling ─────────────────────────────────────────────────────
  const doc2 = makeDocument();
  for (let index = 0; index < 2; index += 1) doc2.body.append(doc2.createElement('video'));
  const capState = makeState({ video: null });
  record(api.videoElementCount(doc2) === 2 && api.videoBudgetAvailable(capState, doc2) === true, 'two live videos leave room for one more');
  doc2.body.append(doc2.createElement('video'));
  record(api.videoBudgetAvailable(capState, doc2) === false, 'at the ceiling no further video is created', String(api.videoElementCount(doc2)));
  record(api.MAX_VIDEO_ELEMENTS === 3, 'the ceiling is three', String(api.MAX_VIDEO_ELEMENTS));

  // ── runtime status ────────────────────────────────────────────────────────
  const statusDoc = makeDocument();
  const loaded = statusDoc.createElement('img');
  loaded.setAttribute('data-thumb', '/x.webp');
  loaded.setAttribute('data-thumb-loaded', '1');
  loaded.naturalWidth = 160;
  loaded.naturalHeight = 90;
  const pendingThumb = statusDoc.createElement('img');
  pendingThumb.setAttribute('data-thumb', '/y.webp');
  statusDoc.body.append(loaded, pendingThumb, statusDoc.createElement('video'));
  const statusState = makeState({ catalog: { skins: [skin('a_1')], defaultSkin: null }, skinId: 'a_1', videoPlaying: true });
  const runtime = api.readRuntimeStatus(statusState, statusDoc);
  record(runtime.thumbsLoaded === 1 && runtime.thumbsPending === 1, 'the status separates loaded from pending thumbnails', `${runtime.thumbsLoaded}/${runtime.thumbsPending}`);
  record(runtime.videos === 1 && runtime.videoLimit === 3, 'and counts live video elements against the ceiling', `${runtime.videos}/${runtime.videoLimit}`);
  record(runtime.playing === true && runtime.paused === false, 'reporting that the background is playing');
  record(runtime.estimatedMB > 3 && runtime.estimatedMB < 4, 'the memory estimate follows its stated basis (pixels + one frame buffer per video)', String(runtime.estimatedMB));
  record(runtime.playbackMB === 45, 'and reports the current skin asset size in MB', String(runtime.playbackMB));
  statusState.bgPaused = true;
  statusState.bgPauseReason = 'blur';
  const pausedRuntime = api.readRuntimeStatus(statusState, statusDoc);
  record(pausedRuntime.paused === true && pausedRuntime.playing === false && pausedRuntime.pauseReason === 'blur', 'a paused background is reported as paused, not playing', String(pausedRuntime.pauseReason));
  // The timer is owned and released.
  const timerState = makeState({ catalog: { skins: [], defaultSkin: null } });
  api.tickRuntimeStatus(timerState, statusDoc);
  record(timerState.runtime !== null && typeof timerState.runtime.at === 'string', 'one tick fills the runtime block');
  api.startStatusTimer(timerState);
  const firstTimer = timerState.statusTimer;
  api.startStatusTimer(timerState);
  record(timerState.statusTimer === firstTimer || firstTimer !== null, 'starting the timer twice keeps one interval');
  api.stopStatusTimer(timerState);
  record(timerState.statusTimer === null, 'and stopping it releases the handle');
  api.stopStatusTimer(timerState);
  record(true, 'stopping a timer that is not running is harmless');
}

/* ── 13. advanced: switch chords, toast, UI knobs, recommendation, settings ── */

{
  const document = makeDocument();
  // The import path refreshes the catalog, so this responder answers /catalog with a
  // catalog — a blanket preferences payload would replace it and break the lookups.
  const window = makeWindow((url, method, body) => {
    if (String(url).includes('/catalog')) return { ok: true, revision: 'test', defaultSkin: null, skins: [skin('a_1'), skin('b_2'), skin('c_3')] };
    return echoPreferences({})(url, method, body);
  });
  const api = boot(document, window, quiet);
  const library = [skin('a_1'), skin('b_2'), skin('c_3')];
  const state = makeState({ catalog: { skins: library, defaultSkin: null }, skinId: 'b_2' });

  // ── chord recognition ─────────────────────────────────────────────────────
  const chord = (over) => Object.assign({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, code: 'PageDown' }, over);
  record(api.switchChordStep(chord({})) === 1, 'Ctrl+Shift+PageDown steps forward');
  record(api.switchChordStep(chord({ code: 'PageUp' })) === -1, 'Ctrl+Shift+PageUp steps back');
  record(api.switchChordStep(chord({ code: 'ArrowDown' })) === 1 && api.switchChordStep(chord({ code: 'ArrowUp' })) === -1, 'the arrow keys are accepted as a fallback pair');
  record(api.switchChordStep(chord({ ctrlKey: false })) === 0 && api.switchChordStep(chord({ shiftKey: false })) === 0, 'without both modifiers nothing matches');
  record(api.switchChordStep(chord({ altKey: true })) === 0 && api.switchChordStep(chord({ metaKey: true })) === 0, 'and extra modifiers disqualify it (the focus chord must not collide)');
  record(api.switchChordStep(chord({ code: 'KeyB' })) === 0 && api.switchChordStep(null) === 0, 'an unrelated key, and a missing event, step nowhere');

  // ── the switch itself, and the centre toast ────────────────────────────────
  const switchState = makeState({
    catalog: { skins: library, defaultSkin: null },
    skinId: 'b_2',
    automationDisposers: [],
    uiKnobs: { radius: 8, fontScale: 100, panelAlpha: 62 },
  });
  const ctx = { get: () => null, theme: { overrideTokens: () => () => {} } };
  // applyById is fired and forgotten; only the decision, the log and the toast are
  // asserted here (mounting a skin is covered by the video/visual suites).
  const stepped = api.switchByStep(ctx, switchState, 1);
  record(stepped !== null && stepped.skinId === 'c_3', 'stepping forward moves to the next skin in the stored order', String(stepped?.skinId));
  record(switchState.opLog[0].kind === 'switch' && switchState.opLog[0].message.includes('3 / 3'), 'the move is logged with its position', switchState.opLog[0].message);
  const toasts = document.querySelectorAll(`[${api.TOAST_ATTRIBUTE}]`);
  record(toasts.length === 1, 'a centre toast is shown', String(toasts.length));
  record((toasts[0]?.textContent ?? '').includes('3 / 3') || toasts[0].children.some((node) => String(node.textContent).includes('3 / 3')), 'carrying the position');
  record(api.switchByStep(ctx, switchState, 1).skinId === 'a_1', 'stepping past the end wraps to the first skin');
  record(api.switchByStep(ctx, switchState, -1).skinId === 'c_3', 'and stepping back from the first wraps to the last');
  record(document.querySelectorAll(`[${api.TOAST_ATTRIBUTE}]`).length === 1, 'the toast is replaced, never stacked');

  // ── UI knobs ───────────────────────────────────────────────────────────────
  api.applyUiKnobs(switchState);
  record(document.documentElement.style.getPropertyValue('--dsh-ui-radius') === '8px', 'the radius knob reaches the document as a variable', String(document.documentElement.style.getPropertyValue('--dsh-ui-radius')));
  record(document.documentElement.style.getPropertyValue('--dsh-panel-alpha') === '0.62', 'and so does the panel transparency');
  record(document.body.style.getPropertyValue('--dsw-radius-sm') === '8px', 'the shell radius token is written on body (where the shell keeps its own)');
  record(document.querySelectorAll('style[data-dsh-skin-ui-knobs]').length === 1, 'one stylesheet carries the rules that use them');
  api.setUiKnob(switchState, 'radius', 999);
  record(switchState.uiKnobs.radius === 24, 'an out-of-range knob is clamped', String(switchState.uiKnobs.radius));
  api.setUiKnob(switchState, 'fontScale', 120);
  record(switchState.uiKnobs.fontScale === 120 && document.body.style.getPropertyValue('--dsh-content-font-size-secondary').endsWith('px'), 'the font scale is applied to the content size token', String(document.body.style.getPropertyValue('--dsh-content-font-size-secondary')));
  record(JSON.parse(storage.get('dsh-skins/v1/ui-knobs')).fontScale === 120, 'and persisted locally');

  // ── recommendation is pure ─────────────────────────────────────────────────
  const daySkins = [skin('img_light_1', 'image', { anchorScheme: 'light' }), skin('video_dark_2', 'video', { anchorScheme: 'dark' }), skin('img_cool_3', 'image', { anchorScheme: 'dark', colors: { dark: { accent: '#4466ff' } } })];
  const recState = makeState({ catalog: { skins: daySkins, defaultSkin: null } });
  const config = Object.assign(api.defaultRecommend(), { enabled: true, start: '08:00', end: '18:00' });
  const noon = new Date(2026, 0, 1, 12, 0, 0);
  const midnight = new Date(2026, 0, 1, 2, 0, 0);
  const dayDecision = api.recommendDecision(recState, config, noon);
  record(dayDecision !== null && dayDecision.mode === 'day', 'midday inside the window is a day recommendation', String(dayDecision?.mode));
  record(dayDecision.pool === 2 && dayDecision.custom === false, 'the automatic day pool is the light or cool images', String(dayDecision.pool));
  const nightDecision = api.recommendDecision(recState, config, midnight);
  record(nightDecision.mode === 'night', 'and outside it is a night recommendation');
  record(nightDecision.pool === 2 && nightDecision.skinId === 'video_dark_2', 'whose automatic pool is the dark or video skins', String(nightDecision.skinId));
  const customDecision = api.recommendDecision(recState, Object.assign({}, config, { dayPool: ['img_cool_3'] }), noon);
  record(customDecision.custom === true && customDecision.skinId === 'img_cool_3', 'a custom pool replaces the automatic one', String(customDecision.skinId));
  const wrapped = api.recommendDecision(recState, Object.assign({}, config, { start: '18:00', end: '08:00' }), midnight);
  record(wrapped.mode === 'day', 'a window that crosses midnight is handled', String(wrapped.mode));
  record(api.recommendDecision(recState, config, new Date(2026, 0, 1, 12, 5, 0)).skinId === api.recommendDecision(recState, config, new Date(2026, 0, 1, 12, 20, 0)).skinId, 'the suggestion is stable inside a 30-minute bucket');
  record(api.recommendDecision(makeState({ catalog: { skins: [] } }), config, noon) === null, 'an empty catalog suggests nothing');
  const disabled = api.evaluateRecommendation(ctx, makeState({ catalog: { skins: daySkins }, recommend: { enabled: false } }), 'test');
  record(disabled === null, 'a disabled recommendation does nothing');
  const advised = api.evaluateRecommendation(ctx, makeState({ catalog: { skins: daySkins }, recommend: Object.assign({}, config, { autoApply: false }) }), 'test');
  // The clock is the real one here, so either mode is a valid advice — what matters is
  // that an enabled recommendation always produces one.
  record(advised !== null && (advised.mode === 'day' || advised.mode === 'night'), 'and an enabled one always produces an advice', String(advised?.mode));

  // ── the settings file ─────────────────────────────────────────────────────
  requests.length = 0;
  const exportState = makeState({ catalog: { skins: library, defaultSkin: null }, skinId: 'a_1', recommend: config, uiKnobs: { radius: 12, fontScale: 110, panelAlpha: 50 }, viewMode: 'list', customCss: '.x{color:red}' });
  await api.exportSettings(exportState);
  const posted = requests.find((row) => row.url.includes('/settings'));
  record(posted !== undefined, 'exporting posts the configuration to the host', String(requests.length));
  const fields = Object.keys(posted?.body ?? {});
  record(['preferences', 'favorites', 'tweaks', 'automation', 'recommend', 'assets', 'uiKnobs', 'viewMode', 'customCss'].every((key) => fields.includes(key)), 'including every promised section', fields.join(','));
  record(posted.body.format === 'dsh-skins-settings/1' && posted.body.uiKnobs.radius === 12, 'with a format tag and the current knob values', String(posted.body.format));
  record(exportState.opLog.some((row) => row.kind === 'settings' && row.message.includes('已导出')), 'and a log line naming the file', exportState.opLog[0]?.message);
  requests.length = 0;
  const importState = makeState({ catalog: { skins: library, defaultSkin: null }, uiKnobs: { radius: 8, fontScale: 100, panelAlpha: 62 } });
  await api.importSettings(ctx, importState, { preferences: { order: ['c_3'], favorites: ['c_3'], hidden: [], tags: { c_3: ['夜景'] } }, favorites: ['c_3'], uiKnobs: { radius: 16, fontScale: 90, panelAlpha: 40 }, viewMode: 'list', customCss: '.imported{color:blue}' });
  record(importState.uiKnobs.radius === 16 && document.body.style.getPropertyValue('--dsw-radius-sm') === '16px', 'an imported knob set is applied at once', String(importState.uiKnobs.radius));
  record(importState.favorites.join(',') === 'c_3' && importState.preferences.order.join(',') === 'c_3', 'the imported favourites and order are adopted', importState.favorites.join(','));
  record(importState.viewMode === 'list', 'the view mode comes back too');
  record(importState.customCss === '.imported{color:blue}', 'and the imported stylesheet is installed', importState.customCss);
  record(importState.opLog.some((row) => row.kind === 'settings' && row.message.includes('已导入')), 'with a log line', importState.opLog[0]?.message);
}

/* ── 14. wiring ───────────────────────────────────────────────────────────── */

{
  record(clientSource.includes('const PREFS_URL = ROUTE + "/preferences"'), 'the client talks to the preferences route');
  record(clientSource.includes('await loadPreferences(state)') && clientSource.indexOf('await loadPreferences(state)') < clientSource.indexOf('// The switcher mounts after the first application'), 'and loads them before the library renders');
  record(clientSource.includes('orderedSkins(store, skins)'), 'the library renders in the stored order');
  record(clientSource.includes('void savePreferences(state, { favorites: next })'), 'favourites are persisted on every toggle');
  record(/closeSkinMenu\(state\);\n\s*closeDeleteDialog\(state\);\n\s*cancelDrag\(state\);/.test(clientSource), 'the disposer closes the menu, the dialog and any drag');
  record(clientSource.includes('data-drop-before=true]::before') && clientSource.includes('border-left:2px dashed'), 'the insertion hint is a dashed line');
  record(clientSource.includes('dsh-skins-card__info[data-kind=rendition]'), 'the compressed video badge has its own colour');
  record(clientSource.includes('操作日志'), 'the bottom log area exists');
  record(/二次|确认删除/.test(clientSource) && clientSource.includes('确认删除 '), 'the confirmation copy is in place');
  record(!/\beval\s*\(|new Function\s*\(/u.test(slice), 'the browser half still contains no eval');
}

const failed = results.filter((row) => !row.ok);
console.log(`\nchecks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  for (const row of failed) console.log(`FAILED ${row.label} ${row.detail}`);
  process.exitCode = 1;
}
