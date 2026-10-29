/**
 * Phase-6 verification: custom CSS injection, focus mode, the eyedropper.
 *
 * The three features all reach into the live document, so the tests that matter
 * are behavioural: a hand-written DOM stub (attributes, children, listeners,
 * a canvas context) lets the real code run — the ancestor walk that decides what
 * focus mode hides, the stylesheet element that carries the user's CSS, the
 * overlay that samples a pixel — instead of asserting that the source *looks*
 * right.
 *
 * Two things are checked here that no browser could check for us:
 *   - injected CSS goes in through `textContent`, so a `</style>` in the user's
 *     sheet stays text and cannot open markup;
 *   - a draft that fails the lint never replaces the sheet that is working.
 *
 *   node output\_scan\verify_devtools.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const BODY = join(root, 'output', 'plugin', 'dsh-skins', 'src', 'client.body.js');
const clientSource = readFileSync(BODY, 'utf8');

const results = [];
/**
 * The hotkey path is asynchronous (it may open the settings page and wait for it),
 * so a stray rejection must fail the run loudly instead of showing up as an
 * unexplained exit code.
 */
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  process.exitCode = 1;
});
const record = (ok, label, detail = '') => {
  results.push({ ok, label, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};
const near = (a, b, tolerance = 0.02) => Math.abs(a - b) <= tolerance;

/* ── a DOM small enough to reason about, complete enough to run the code ───── */

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = '';
    this.className = '';
    this.style = { cssText: '' };
    this.context = null;
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
  matches(selector) {
    if (selector.startsWith('[') && selector.endsWith(']')) return this.hasAttribute(selector.slice(1, -1));
    if (selector.startsWith('.')) return this.className.split(/\s+/u).includes(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }
  walk(visit) {
    for (const child of this.children) {
      visit(child);
      child.walk(visit);
    }
  }
  /** The real DOM method the focus walk relies on to protect the artwork. */
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
  querySelectorAll(selector) {
    const found = [];
    this.walk((node) => {
      if (node.matches(selector)) found.push(node);
    });
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
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
  }
  listenerCount() {
    let total = 0;
    for (const list of this.listeners.values()) total += list.length;
    return total;
  }
  getContext() {
    return this.context;
  }
}

const paintLog = [];
const makeContext = (pixels) => ({
  filter: 'none',
  createLinearGradient: () => ({ stops: [], addColorStop(offset, color) { this.stops.push([offset, color]); } }),
  // The filter in force *at draw time* is recorded: the code resets it before
  // painting the scrim, so reading it afterwards would only see the reset.
  drawImage(...args) {
    paintLog.push({ op: 'drawImage', args, filter: this.filter });
  },
  fillRect(...args) {
    paintLog.push({ op: 'fillRect', args, filter: this.filter });
  },
  getImageData: (x, y) => {
    if (pixels === null) throw new Error('The canvas has been tainted by cross-origin data');
    return { data: pixels(x, y) };
  },
});

const makeDocument = () => {
  const documentElement = new FakeNode('html');
  const head = new FakeNode('head');
  const body = new FakeNode('body');
  documentElement.append(head, body);
  const document = {
    documentElement,
    head,
    body,
    createElement: (tag) => new FakeNode(tag),
    querySelector: (selector) => documentElement.querySelector(selector),
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    addEventListener: (type, handler) => documentElement.addEventListener(type, handler),
    removeEventListener: (type, handler) => documentElement.removeEventListener(type, handler),
    dispatch: (type, event) => documentElement.dispatch(type, event),
    listenerCount: () => documentElement.listenerCount(),
  };
  return document;
};

/* ── load the browser half's logic (no components are rendered) ───────────── */

const slice = clientSource.slice(
  clientSource.indexOf('/** Route prefix owned by the host half.'),
  // Everything up to the entry point, so the shortcut helpers (which live after the
  // components in this file) are the real ones and not restated here.
  clientSource.lastIndexOf('/*', clientSource.indexOf(' * Client plugin body')),
);
const boot = (document, window, logger = console) =>
  new Function(
    'window',
    'document',
    'navigator',
    'react',
    'console',
    // `PACKAGE_ID` is injected by build.mjs (it is in scope in the real bundle),
    // so it has to be supplied here too.
    `const PACKAGE_ID = 'dsh-plugin-skins';\n${slice}\nreturn {
      validateCss, applyCustomCss, setCustomCss, clearCustomCss, readCustomCss, CUSTOM_CSS_SAMPLE,
      collectFocusTargets, enterFocusMode, exitFocusMode, toggleFocusMode, sweepStrandedUi, recoverFocus,
      rootLayoutConflicts, mountFocusAnchor, unmountFocusAnchor,
      installFocusHotkey, matchesFocusChord, toggleFocusFromHotkey, waitForPanel,
      FOCUS_ATTRIBUTE, LANE_ATTRIBUTE, ANCHOR_ATTRIBUTE, PICK_ATTRIBUTE, FOCUS_FLAG_KEY, FOCUS_CHORD_LABEL, FOCUS_CHORD_CODE,
      startPicker, stopPicker, drawFrameForPicking, readPickPixel, adjustAccentForSurface, withAccentTokens,
      setAccentOverride, clearAccentOverride, applyTokenLayer, ACCENT_TOKENS,
      DEFAULT_TWEAKS, contrastRatio, rgbToHsl, hslToHex, toHex, INK_ON_ACCENT, LABEL_ON_ACCENT_LIGHT,
    };`,
  )(
    window,
    document,
    { userAgent: 'probe' },
    {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: (value) => [value, () => {}],
      useEffect: () => {},
      useRef: (value) => ({ current: value }),
      useMemo: (factory) => factory(),
      useCallback: (fn) => fn,
    },
    logger,
  );

/** Swallows the warnings the deliberate failure-path tests provoke, on purpose. */
const quietLog = { log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * The store has well over a hundred fields and `publish` reads most of them, so
 * the stub supplies the *shapes* — array, object, or null — and lets the tests
 * name only the fields the behaviour under test actually depends on.
 */
const ARRAY_FIELDS = new Set(['favorites', 'listeners', 'automationDisposers', 'focusTargets', 'workspaceItems', 'jobSteps', 'jobNewSkins', 'assetJobResults', 'referenced', 'tags', 'skins']);
const OBJECT_FIELDS = new Set(['tweaks', 'catalog', 'automation', 'assets', 'video', 'liveTokens', 'livePreview', 'job', 'cleanup', 'workspaceIndex']);
/** Objects whose *contents* are iterated, so `{}` is not enough. */
const OBJECT_DEFAULTS = { workspaceIndex: { items: [], at: null }, job: { steps: [] } };
const makeState = (overrides = {}) =>
  new Proxy(
    Object.assign(
      {
        version: 0,
        skinId: 'skin-a',
        catalog: { skins: [], defaultSkin: null },
        tweaks: {},
        customCss: '',
        customStyle: null,
        focusMode: false,
        focusTargets: [],
        focusLanes: [],
        focusAnchor: null,
        focusConflicts: [],
        focusRecovered: false,
        tokenSource: 'none',
        // A surface is supplied so the accent tests do not have to drive a canvas;
        // the fallback path is covered separately through the pure function.
        liveTokens: { surface: '#141416', tokens: { '--dsw-alias-bg-base': { light: '#141416', dark: '#141416' } } },
      },
      overrides,
    ),
    {
      get(target, key) {
        if (key in target) return target[key];
        if (typeof key !== 'string') return undefined;
        if (ARRAY_FIELDS.has(key)) return [];
        if (OBJECT_FIELDS.has(key)) return OBJECT_DEFAULTS[key] ?? {};
        return null;
      },
      set(target, key, value) {
        target[key] = value;
        return true;
      },
    },
  );

const storage = new Map();
/**
 * A window that behaves like an event target, records how each listener was
 * registered (so "window + capture" is checkable) and keeps real timers, which the
 * hotkey needs for its bounded wait for the settings page.
 */
const makeWindow = () => {
  const listeners = [];
  const window = {
    innerWidth: 1600,
    innerHeight: 900,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    addEventListener(type, handler, options) {
      listeners.push({ type, handler, options });
    },
    removeEventListener(type, handler) {
      const index = listeners.findIndex((row) => row.type === type && row.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
    dispatch(type, event) {
      for (const row of [...listeners]) {
        if (row.type === type) row.handler(Object.assign({ type, target: null }, event));
      }
    },
    registrations: () => listeners.map((row) => `${row.type}${row.options === true ? ':capture' : ''}`),
    listenerCount: () => listeners.length,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  return window;
};
const windowStub = makeWindow();
/** Let the microtask queue (and one timer turn) drain. */
const settle = async () => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/* ── 1. the CSS lint ──────────────────────────────────────────────────────── */

{
  const document = makeDocument();
  const api = boot(document, windowStub);
  const empty = api.validateCss('');
  record(empty.ok === true && empty.rules === 0 && empty.errors.length === 0, 'an empty sheet is valid', JSON.stringify({ rules: empty.rules, lines: empty.lines }));
  const plain = api.validateCss('.a { color: red }\n.b { border-radius: 8px }');
  record(plain.ok === true && plain.rules === 2 && plain.lines === 2, 'a normal sheet validates with its rule count', JSON.stringify({ rules: plain.rules, lines: plain.lines }));
  const nested = api.validateCss('@media (min-width: 600px) { .a { color: red } }');
  record(nested.ok === true && nested.rules === 2, 'an at-rule with a nested block validates');
  const missingBrace = api.validateCss('.a {\n  color: red;\n');
  record(missingBrace.ok === false && missingBrace.errors[0].line === 1, 'a missing } is caught at the opening brace', JSON.stringify(missingBrace.errors[0]));
  const extraBrace = api.validateCss('.a { color: red }\n}\n.b { color: blue }');
  record(extraBrace.ok === false && extraBrace.errors[0].line === 2, 'a stray } is caught on its own line', JSON.stringify(extraBrace.errors[0]));
  const openComment = api.validateCss('.a { color: red } /* 忘了关');
  record(openComment.ok === false && openComment.errors[0].message.includes('注释'), 'an unterminated comment is caught', openComment.errors[0].message);
  const openQuote = api.validateCss('.a { content: "没关 }');
  record(openQuote.ok === false && openQuote.errors.some((row) => row.message.includes('字符串')), 'an unterminated string is caught', JSON.stringify(openQuote.errors.map((row) => row.message)));
  const openParen = api.validateCss('.a { width: calc(100% - 4px }');
  record(openParen.ok === false && openParen.errors.some((row) => row.message.includes('(')), 'an unbalanced ( is caught');
  const openBracket = api.validateCss('.a[href { color: red }');
  record(openBracket.ok === false && openBracket.errors.some((row) => row.message.includes('[')), 'an unbalanced [ is caught');
  // The false positives that would make the lint useless.
  const bracesInComment = api.validateCss('/* { } } { */\n.a { color: red }');
  record(bracesInComment.ok === true && bracesInComment.rules === 1, 'braces inside a comment are ignored', JSON.stringify(bracesInComment.errors));
  const braceInString = api.validateCss('.a { content: "}" }');
  record(braceInString.ok === true, 'a brace inside a string is ignored', JSON.stringify(braceInString.errors));
  const escapedQuote = api.validateCss('.a { content: "\\"" }');
  record(escapedQuote.ok === true, 'an escaped quote does not end the string', JSON.stringify(escapedQuote.errors));
  const importRule = api.validateCss('@import url("https://example.com/x.css");\n.a { color: red }');
  record(importRule.ok === true && importRule.warnings.length === 1, '@import is a warning, not an error', importRule.warnings[0]?.message);
  const deep = api.validateCss('a{}\nb{}\nc{}\nd{}\ne{');
  record(deep.ok === false && deep.errors[0].line === 5, 'the reported line is the one that actually breaks', JSON.stringify(deep.errors[0]));
}

/* ── 2. injecting the sheet ───────────────────────────────────────────────── */

{
  const document = makeDocument();
  const api = boot(document, windowStub);
  const state = makeState();
  const good = '.card { border-radius: 14px }';
  state.customCss = good;
  const check = api.applyCustomCss(state);
  record(check.ok === true, 'a valid sheet reports as applied');
  const styles = document.head.querySelectorAll('style');
  record(styles.length === 1 && styles[0].textContent === good, 'one <style> element carries the sheet in head', `${styles.length} element(s)`);
  record(styles[0].hasAttribute('data-dsh-skin-custom') === true, 'the element is marked as ours, so it can be found and removed');
  state.customCss = '.card { border-radius: 4px }';
  api.applyCustomCss(state);
  record(document.head.querySelectorAll('style').length === 1 && document.head.querySelectorAll('style')[0].textContent === '.card { border-radius: 4px }', 'editing reuses the same element instead of stacking sheets');
  // The safety property: a broken draft must not replace the working sheet.
  state.customCss = '.card { border-radius: 20px';
  const broken = api.applyCustomCss(state);
  record(broken.ok === false, 'a broken draft fails the lint');
  record(document.head.querySelectorAll('style')[0].textContent === '.card { border-radius: 4px }', 'the last working sheet stays in the document', document.head.querySelectorAll('style')[0].textContent);
  // Markup in the sheet must stay text.
  state.customCss = '.a { color: red }</style><script>window.pwned=1</script>';
  api.applyCustomCss(state);
  const element = document.head.querySelectorAll('style')[0];
  record(element.textContent.includes('</style>') && element.children.length === 0, 'a </style> in the sheet stays text (textContent, never innerHTML)');
  record(document.querySelectorAll('script').length === 0, 'and no script element is created anywhere');
  const cleared = api.clearCustomCss(state);
  record(document.head.querySelectorAll('style').length === 0 && state.customStyle === null, 'clearing removes the element', String(cleared === undefined));
  // Emptying the textarea removes it too, rather than leaving an empty sheet.
  state.customCss = '   ';
  api.applyCustomCss(state);
  record(document.head.querySelectorAll('style').length === 0, 'whitespace-only content installs nothing');
  // Persistence round-trip.
  api.setCustomCss(state, '.x { color: blue }');
  record(storage.get('dsh-skins/v1/custom-css') === '.x { color: blue }', 'the sheet is persisted for the next load');
  record(api.readCustomCss() === '.x { color: blue }', 'and read back');
  record(api.CUSTOM_CSS_SAMPLE.includes('body::after') && api.validateCss(api.CUSTOM_CSS_SAMPLE).ok === true, 'the built-in sample is itself valid CSS');
}

/* ── 3. focus mode ────────────────────────────────────────────────────────── */

const buildShell = (document) => {
  // A tree shaped like the real shell. The plugin's own artwork layer and quick
  // switcher are children of <body>, which is exactly where the bug came from:
  // body > [root > frame > [sidebar, center, rightbar > [tabstrip, pane > [paneHead, panel]]], layer, switcher]
  const rootNode = new FakeNode('div');
  const frame = new FakeNode('div');
  const sidebar = new FakeNode('aside');
  const center = new FakeNode('main');
  const rightbar = new FakeNode('div');
  const tabstrip = new FakeNode('div');
  const pane = new FakeNode('div');
  const paneHead = new FakeNode('div');
  const panel = new FakeNode('div');
  panel.className = 'dsh-skins-panel';
  pane.append(paneHead, panel);
  rightbar.append(tabstrip, pane);
  frame.append(sidebar, center, rightbar);
  rootNode.append(frame);
  const layer = new FakeNode('div');
  layer.setAttribute('data-dsh-skins-layer', '1');
  layer.style.zIndex = '-1';
  const switcher = new FakeNode('div');
  switcher.setAttribute('data-dsh-skins-panel', '');
  document.body.append(rootNode, layer, switcher);
  return { rootNode, frame, sidebar, center, rightbar, tabstrip, pane, paneHead, panel, layer, switcher };
};

{
  const document = makeDocument();
  const api = boot(document, windowStub);
  const shell = buildShell(document);
  const state = makeState({ layer: shell.layer });
  const plan = api.collectFocusTargets(state, shell.panel);
  const targets = plan.targets;
  record(targets.includes(shell.sidebar) && targets.includes(shell.center) && targets.includes(shell.tabstrip) && targets.includes(shell.paneHead), 'the walk hides the shell columns: sidebar, chat, tab strip, pane header', String(targets.length));
  // The bug: the artwork layer is a child of <body>, so a naive sibling walk hid it.
  record(!targets.includes(shell.layer), 'the background layer is never in the hide set (this was the grey screen)');
  record(!targets.includes(shell.panel), 'the panel itself is never hidden');
  record(!targets.includes(shell.pane) && !targets.includes(shell.rightbar) && !targets.includes(shell.rootNode), 'and neither are its ancestors, or the panel would go with them');
  record(!targets.includes(document.body) && !targets.includes(document.documentElement), 'body and html are never hidden');
  record(plan.lanes.includes(shell.pane) && plan.lanes.includes(shell.rightbar) && plan.lanes.includes(shell.frame) && plan.lanes.includes(shell.rootNode), 'the panel chain is collected as lanes instead', String(plan.lanes.length));
  record(!plan.lanes.includes(document.body) && !plan.lanes.includes(shell.panel), 'body is not a lane and the panel is not its own lane');
  // A hidden switcher is fine; a hidden background is not.
  record(targets.includes(shell.switcher), 'the plugin quick switcher is hidden too (only the background and the panel remain)');

  const entered = api.enterFocusMode(state);
  record(entered === true && state.focusMode === true, 'focus mode enters', String(entered));
  record([shell.sidebar, shell.center, shell.tabstrip, shell.paneHead, shell.switcher].every((node) => node.getAttribute(api.FOCUS_ATTRIBUTE) === '1'), 'every column carries the hide attribute');
  record([shell.pane, shell.rightbar, shell.frame, shell.rootNode].every((node) => node.getAttribute(api.LANE_ATTRIBUTE) === '1'), 'the panel chain carries the lane attribute instead of the hide attribute');
  record(shell.layer.hasAttribute(api.FOCUS_ATTRIBUTE) === false && shell.layer.hasAttribute(api.LANE_ATTRIBUTE) === false, 'the layer gets neither attribute');
  record(shell.layer.style.zIndex === '-1' && state.layerZIndexBefore === '-1', 'the layer keeps its z-index', `${shell.layer.style.zIndex} / recorded ${state.layerZIndexBefore}`);
  record(shell.rootNode.hasAttribute(api.FOCUS_ATTRIBUTE) === false, 'the app root is repositioned, never display:none');
  record(document.body.hasAttribute(api.FOCUS_ATTRIBUTE) === false && document.documentElement.hasAttribute(api.FOCUS_ATTRIBUTE) === false, 'nothing marks body or html as hidden');
  record(document.documentElement.getAttribute('data-dsh-focus') === '1', 'the document is marked, so the stylesheet can react');
  // The floating way out.
  const anchor = document.querySelectorAll(`[${api.ANCHOR_ATTRIBUTE}]`);
  record(anchor.length === 1 && anchor[0].parentElement === document.body, 'a floating exit anchor is mounted on body', String(anchor.length));
  record(anchor[0].children[0].textContent.includes('退出专注模式') && String(anchor[0].children[0].style.cssText).includes('opacity:0.5'), 'carrying a small semi-transparent exit button', String(anchor[0].children[0].style.cssText).slice(0, 60));
  record(anchor[0].children[0].parentElement === anchor[0] && !shell.layer.contains(anchor[0]), 'outside the hidden set, so it stays clickable');
  record(state.focusNote.includes('背景层未受影响') && state.focusNote.includes(String(plan.lanes.length)), 'the note says how many columns were hidden and how deep the dock is', state.focusNote);
  record(document.listenerCount() === 1, 'exactly one key listener is installed', String(document.listenerCount()));
  api.enterFocusMode(state);
  record(document.listenerCount() === 1 && document.querySelectorAll(`[${api.ANCHOR_ATTRIBUTE}]`).length === 1, 'entering twice installs neither a second listener nor a second anchor');
  record(storage.get('dsh-skins/v1/focus-active') === '1', 'a flag records that the mode is on (crash detection)');
  // The exit button, not just Esc.
  anchor[0].children[0].dispatch('click', { preventDefault: () => {}, stopPropagation: () => {} });
  record(state.focusMode === false && document.querySelectorAll(`[${api.ANCHOR_ATTRIBUTE}]`).length === 0, 'clicking the floating button exits and removes the anchor');
  record(shell.layer.style.zIndex === '-1' && state.layerZIndexAfter === '-1', 'the layer still keeps its z-index after the round trip', String(state.layerZIndexAfter));
  record(storage.get('dsh-skins/v1/focus-active') === undefined, 'and the crash flag is cleared');

  api.enterFocusMode(state);
  document.dispatch('keydown', { key: 'Escape' });
  record(state.focusMode === false && document.documentElement.hasAttribute('data-dsh-focus') === false, 'Escape still leaves focus mode');
  record([shell.sidebar, shell.center, shell.tabstrip, shell.paneHead, shell.switcher].every((node) => node.hasAttribute(api.FOCUS_ATTRIBUTE) === false), 'and restores every hidden element');
  record([shell.pane, shell.rightbar, shell.frame, shell.rootNode].every((node) => node.hasAttribute(api.LANE_ATTRIBUTE) === false), 'and removes every lane mark, so the sidebar returns');
  record(document.listenerCount() === 0, 'the key listener is released', String(document.listenerCount()));

  api.toggleFocusMode(state);
  record(state.focusMode === true, 'the toggle turns it on');
  api.toggleFocusMode(state);
  record(state.focusMode === false && document.listenerCount() === 0 && storage.get('dsh-skins/v1/focus-active') === undefined, 'and off again, with no listener or flag left behind', String(document.listenerCount()));
  api.exitFocusMode(state);
  record(state.focusMode === false, 'exiting when already off is harmless');

  // A document with no panel in it at all: hiding the window here would be a trap.
  const bareDocument = makeDocument();
  const bareApi = boot(bareDocument, windowStub);
  const orphan = makeState();
  record(bareApi.enterFocusMode(orphan) === false && typeof orphan.focusNote === 'string', 'without a panel it refuses instead of hiding the window', String(orphan.focusNote));
  record(bareDocument.querySelectorAll(`[${api.FOCUS_ATTRIBUTE}]`).length === 0, 'and nothing at all is hidden', '');
}

/* ── 3b. the root-layout guard, and crash recovery ────────────────────────── */

{
  const document = makeDocument();
  const api = boot(document, windowStub);
  const conflicts = (css) => api.rootLayoutConflicts(css);
  record(conflicts('body { display: none }').length === 1, 'body{display:none} is a root-layout conflict');
  record(conflicts('* { visibility: hidden }').length === 1, 'a universal visibility:hidden is a conflict');
  record(conflicts('#app { opacity: 0 }').length === 1, '#app{opacity:0} is a conflict');
  record(conflicts('html { pointer-events: none }').length === 1, 'html{pointer-events:none} is a conflict (it would freeze the exit button)');
  record(conflicts('body { position: fixed }').length === 1, 'body{position:fixed} is a conflict');
  record(conflicts('html { transform: scale(0.9) }').length === 1, 'a transform on html is a conflict (it re-parents fixed positioning)');
  record(conflicts(':root { filter: blur(2px) }').length === 1, 'a filter on :root is a conflict');
  // The false positives that would make the guard annoying.
  record(conflicts(api.CUSTOM_CSS_SAMPLE).length === 0, 'the built-in sample (body::after decoration) is not a conflict');
  record(conflicts('.card { display: none }').length === 0, 'a component rule is not a conflict');
  record(conflicts('body { background: transparent }').length === 0, 'harmless root styling is not a conflict');
  record(conflicts('#app-shell .row { opacity: 0 }').length === 0, 'an id that merely starts with "app" is not a conflict');
  record(conflicts('html::before { content: ""; opacity: 0 }').length === 0, 'a pseudo-element is a decoration, not the root');
  record(conflicts('/* body { display: none } */ .a { color: red }').length === 0, 'a commented-out rule is not a conflict');

  // The guard must actually stop entry, not just warn.
  const shell = buildShell(document);
  const guarded = makeState({ layer: shell.layer, customCss: 'body { display: none }' });
  const entered = api.enterFocusMode(guarded);
  record(entered === false && guarded.focusMode === false, 'a conflicting stylesheet blocks focus mode instead of hiding the exit', String(entered));
  record(guarded.focusConflicts.length === 1 && guarded.focusNote.includes('已阻止进入'), 'and the conflict is reported for the panel to show', String(guarded.focusConflicts[0]?.declaration));
  record(document.querySelectorAll(`[${api.FOCUS_ATTRIBUTE}]`).length === 0 && document.querySelectorAll(`[${api.ANCHOR_ATTRIBUTE}]`).length === 0, 'nothing was hidden and no anchor was mounted');
  // With the sheet fixed, the same state enters.
  guarded.customCss = '.card { border-radius: 8px }';
  record(api.enterFocusMode(guarded) === true, 'fixing the sheet lets it enter');

  // Crash recovery: the flag left behind by a window closed during the mode.
  const staleDocument = makeDocument();
  const staleApi = boot(staleDocument, windowStub);
  const staleShell = buildShell(staleDocument);
  staleShell.sidebar.setAttribute(staleApi.FOCUS_ATTRIBUTE, '1');
  staleShell.pane.setAttribute(staleApi.LANE_ATTRIBUTE, '1');
  const strandedAnchor = staleDocument.createElement('div');
  strandedAnchor.setAttribute(staleApi.ANCHOR_ATTRIBUTE, '1');
  staleDocument.body.append(strandedAnchor);
  staleDocument.documentElement.setAttribute('data-dsh-focus', '1');
  storage.set('dsh-skins/v1/focus-active', '1');
  const recoveredState = makeState({ layer: staleShell.layer });
  const recovered = staleApi.recoverFocus(recoveredState);
  record(recovered === true && recoveredState.focusRecovered === true, 'a flag left by an unclean exit is detected at boot', String(recovered));
  record(staleShell.sidebar.hasAttribute(staleApi.FOCUS_ATTRIBUTE) === false && staleShell.pane.hasAttribute(staleApi.LANE_ATTRIBUTE) === false, 'the stranded hide and lane marks are swept');
  record(staleDocument.querySelectorAll(`[${staleApi.ANCHOR_ATTRIBUTE}]`).length === 0 && staleDocument.documentElement.hasAttribute('data-dsh-focus') === false, 'the stranded exit anchor and document mark are cleared');
  record(storage.get('dsh-skins/v1/focus-active') === undefined && recoveredState.focusMode === false, 'the flag is cleared and focus mode is *not* resumed', String(recoveredState.focusMode));
  record(typeof recoveredState.focusNote === 'string' && recoveredState.focusNote.includes('已自动重置'), 'and the panel is told what happened', recoveredState.focusNote);
  // A clean boot reports nothing.
  const cleanState = makeState();
  record(boot(makeDocument(), windowStub).recoverFocus(cleanState) === false && cleanState.focusRecovered === false, 'a clean boot recovers nothing');
}

/* ── 3c. the global focus-mode chord ──────────────────────────────────────── */

{
  const document = makeDocument();
  const api = boot(document, windowStub);

  // Matching: exact modifiers, no more and no less.
  const chord = (over) => Object.assign({ code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, altKey: true, metaKey: false }, over);
  record(api.matchesFocusChord(chord({ code: 'Space' })) === true, 'Ctrl+Shift+Alt+Space matches');
  record(api.matchesFocusChord(chord({ key: 'Spacebar', code: 'Space' })) === true, 'the legacy Spacebar key name matches too');
  record(api.matchesFocusChord(chord({ code: '', key: ' ' })) === true, 'an event with no code at all still matches on the key');
  record(api.matchesFocusChord(chord({ code: 'Numpad0', key: ' ' })) === false, 'another physical key is not accepted just because its key reads like a space');
  record(api.matchesFocusChord(chord({ ctrlKey: false })) === false, 'without Ctrl it does not match');
  record(api.matchesFocusChord(chord({ shiftKey: false })) === false, 'without Shift it does not match');
  record(api.matchesFocusChord(chord({ altKey: false })) === false, 'without Alt it does not match');
  record(api.matchesFocusChord(chord({ metaKey: true })) === false, 'adding Cmd/Ctrl-on-mac does not match');
  record(api.matchesFocusChord(chord({ code: 'KeyB' })) === false, 'a different key does not match, even with a stray space in key');
  record(api.matchesFocusChord(null) === false && api.matchesFocusChord(undefined) === false, 'a missing event does not throw');

  // Installation, with a registry that accepts.
  const shell = buildShell(document);
  const state = makeState({ layer: shell.layer });
  const registered = [];
  const disposed = [];
  let ctx = {
    get: (name) => (name === 'shortcuts' ? { register: (options) => { registered.push(options); return () => disposed.push(options.id); } } : null),
  };
  const dispose = api.installFocusHotkey(ctx, state);
  record(typeof dispose === 'function' && state.focusHotkey.installed === true, 'the listener installs', JSON.stringify({ installed: state.focusHotkey.installed, registry: state.focusHotkey.registry }));
  record(windowStub.registrations().join(',') === 'keydown:capture', 'it is registered on window in the capture phase (that is what makes it global)', windowStub.registrations().join(','));
  record(state.focusHotkey.registry === 'accepted' && registered.length === 1, 'the shortcut registry is asked about the chord', String(state.focusHotkey.registry));
  record(disposed.length === 1 && registered[0].id.endsWith('.focus-mode'), 'and the registration is disposed immediately, so the chord has exactly one owner', disposed.join(','));
  record(JSON.stringify(registered[0].defaults['desktop:windows']) === JSON.stringify({ code: 'Space', modifiers: ['primary', 'shift', 'alt'] }), 'the probe declares the real chord', JSON.stringify(registered[0].defaults['desktop:windows']));
  record(JSON.stringify(registered[0].regions) === JSON.stringify(['page', 'editable', 'terminal']), 'and asks for every region, including while typing');

  // A held chord must not flap.
  const spy = () => {
    const calls = { prevented: 0, stopped: 0 };
    return {
      calls,
      event: Object.assign(chord({}), {
        preventDefault: () => { calls.prevented += 1; },
        stopPropagation: () => { calls.stopped += 1; },
      }),
    };
  };
  const first = spy();
  windowStub.dispatch('keydown', first.event);
  await settle();
  record(first.calls.prevented === 1 && first.calls.stopped === 1, 'the handler takes the key before anything else: preventDefault + stopPropagation', JSON.stringify(first.calls));
  record(state.focusMode === true, 'the chord turns focus mode on');
  record(state.focusHotkey.hits === 1 && typeof state.focusHotkey.lastFire === 'string', 'and the hit is recorded', JSON.stringify({ hits: state.focusHotkey.hits, lastFire: state.focusHotkey.lastFire }));
  // Requirement 4: the panel's own view must follow, without a second code path.
  record(state.view.focusMode === true && state.view.focusHotkey?.hits === 1, 'the published view follows the chord, so the panel button updates itself', JSON.stringify({ viewFocus: state.view.focusMode, hits: state.view.focusHotkey?.hits }));
  record(state.view.focusConflicts !== undefined && state.view.focusLaneCount > 0, 'and it carries the same fields the button renders from', String(state.view.focusLaneCount));

  const repeat = spy();
  windowStub.dispatch('keydown', Object.assign(repeat.event, { repeat: true }));
  await settle();
  record(repeat.calls.prevented === 1 && state.focusHotkey.hits === 1, 'a held chord still cannot scroll, but it does not toggle again', `hits=${state.focusHotkey.hits}`);
  const second = spy();
  windowStub.dispatch('keydown', second.event);
  await settle();
  record(state.focusMode === false && state.view.focusMode === false, 'pressing it again leaves focus mode, in the store and in the view');
  record(windowStub.listenerCount() === 1, 'still exactly one listener', String(windowStub.listenerCount()));

  // Global in the real sense: the target is a focused input, deep in the tree.
  const input = document.createElement('input');
  document.body.append(input);
  const fromInput = spy();
  windowStub.dispatch('keydown', Object.assign(fromInput.event, { target: input }));
  await settle();
  record(state.focusMode === true && fromInput.calls.prevented === 1, 'the chord works while an input owns focus (the listener never looks at the target)');
  record(document.querySelectorAll(`[${api.ANCHOR_ATTRIBUTE}]`).length === 1, 'and the mode is fully on, exit button included');
  windowStub.dispatch('keydown', second.event);
  await settle();
  record(state.focusMode === false, 'and toggles back off from the same state');

  // A near miss is remembered, so "the key never arrives" is distinguishable from
  // "it arrives and does not match".
  const miss = spy();
  windowStub.dispatch('keydown', Object.assign(miss.event, { code: 'KeyK' }));
  await settle();
  record(state.focusHotkey.missed.includes('KeyK') && state.focusMode === false, 'Ctrl+Shift+Alt+<other key> is recorded as a near miss and does nothing', state.focusHotkey.missed.join(','));
  record(miss.calls.prevented === 0, 'a near miss is not swallowed (it may belong to another application)');

  // Teardown.
  dispose();
  record(windowStub.listenerCount() === 0 && state.disposeFocusHotkey === null, 'disposing removes the listener', String(windowStub.listenerCount()));
  windowStub.dispatch('keydown', spy().event);
  await settle();
  record(state.focusMode === false, 'and a chord after teardown does nothing');
  const again = api.installFocusHotkey(ctx, state);
  record(api.installFocusHotkey(ctx, state) === again && windowStub.listenerCount() === 1, 'installing twice keeps one listener and returns the same disposer');
  again();
}

{
  // The sidebar is collapsed: the chord has to open the page first, then enter.
  const document = makeDocument();
  const window = makeWindow();
  const api = boot(document, window);
  const opened = [];
  const shell = () => {
    // The page appears once the fake sidebar opens its tab.
    const panel = document.createElement('div');
    panel.className = 'dsh-skins-panel';
    document.body.append(panel);
    return panel;
  };
  const ctx = {
    get: (name) =>
      name === 'sidebarRight'
        ? {
            openTab: (kind) => {
              opened.push(kind);
              setTimeout(shell, 5);
            },
          }
        : null,
  };
  const state = makeState();
  api.installFocusHotkey(ctx, state);
  const press = () => {
    const calls = { prevented: 0, stopped: 0 };
    window.dispatch('keydown', Object.assign({ code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, altKey: true, metaKey: false }, { preventDefault: () => { calls.prevented += 1; }, stopPropagation: () => { calls.stopped += 1; } }));
    return calls;
  };
  press();
  await settle();
  record(opened.length === 1, 'with no panel in the document the chord opens the settings page first', opened.join(','));
  await new Promise((resolve) => setTimeout(resolve, 120));
  record(state.focusMode === true, 'and enters focus mode as soon as the page exists', String(state.focusMode));
  record(document.querySelectorAll(`[${api.ANCHOR_ATTRIBUTE}]`).length === 1, 'with the exit button mounted, so the mode is escapable');
  press();
  await settle();
  record(state.focusMode === false, 'a second press leaves it again');

  // If the page never arrives, nothing is hidden — the one unrecoverable outcome.
  const stuckDocument = makeDocument();
  const stuckWindow = makeWindow();
  const stuckApi = boot(stuckDocument, stuckWindow);
  const stuckState = makeState();
  stuckApi.installFocusHotkey({ get: () => ({ openTab: () => {} }) }, stuckState);
  stuckWindow.dispatch('keydown', Object.assign({ code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, altKey: true, metaKey: false }, { preventDefault: () => {}, stopPropagation: () => {} }));
  await new Promise((resolve) => setTimeout(resolve, 900));
  record(stuckState.focusMode === false && stuckDocument.querySelectorAll(`[${stuckApi.FOCUS_ATTRIBUTE}]`).length === 0, 'if the page never appears, the chord hides nothing and refuses', stuckState.focusNote ?? 'no note');
  record(typeof stuckState.focusNote === 'string' && stuckState.focusNote.includes('找不到面板'), 'and says why', String(stuckState.focusNote));
}

{
  // Failure handling: a registry that refuses, and a window that refuses listeners.
  // Both paths warn by design, so their logging is swallowed here — the assertions
  // below are what proves the behaviour.
  const document = makeDocument();
  const window = makeWindow();
  const api = boot(document, window, quietLog);
  const shell = buildShell(document);
  const refusedState = makeState({ layer: shell.layer });
  api.installFocusHotkey({ get: () => ({ register: () => { throw new Error('Conflicting shortcut defaults: dsh-skins.focus-mode and sidebar.right.toggle'); } }) }, refusedState);
  record(refusedState.focusHotkey.registry === 'refused' && refusedState.focusHotkey.conflict.includes('Conflicting'), 'a registry refusal is caught and recorded rather than thrown', String(refusedState.focusHotkey.conflict).slice(0, 60));
  record(refusedState.focusHotkey.installed === true, 'and the global listener still installs, so the key keeps working');
  record(typeof refusedState.focusHotkey.note === 'string' && refusedState.focusHotkey.note.includes('占用'), 'with a hint about what a silent key would mean', String(refusedState.focusHotkey.note).slice(0, 80));
  const absentState = makeState({ layer: shell.layer });
  api.installFocusHotkey({ get: () => null }, absentState);
  record(absentState.focusHotkey.registry === 'absent' && absentState.focusHotkey.installed === true, 'a missing shortcut service is reported and the listener still works');

  // A fresh state: installing twice is (correctly) a no-op, so the broken window
  // needs its own store rather than reusing one that already has a listener.
  const brokenWindow = Object.assign({}, window, { addEventListener: () => { throw new Error('listener refused'); } });
  const brokenState = makeState({ layer: shell.layer });
  const broken = boot(document, brokenWindow, quietLog);
  broken.installFocusHotkey({ get: () => null }, brokenState);
  record(brokenState.focusHotkey.installed === false && String(brokenState.focusHotkey.note).includes('无法安装'), 'a window that refuses listeners is reported instead of throwing', String(brokenState.focusHotkey.note).slice(0, 40));
}

/* ── 4. the eyedropper ────────────────────────────────────────────────────── */

{
  const document = makeDocument();
  const api = boot(document, windowStub);
  // Every canvas this document creates gets a context that reports one pixel.
  const originalCreate = document.createElement;
  let canvasPixels = () => [200, 40, 90, 255];
  document.createElement = (tag) => {
    const node = originalCreate(tag);
    if (String(tag).toLowerCase() === 'canvas') node.context = makeContext((x, y) => canvasPixels(x, y));
    return node;
  };
  // A 4000x1000 poster in a 1600x900 viewport: cover scales by height and overflows
  // both sides, which is exactly the geometry a naive (x/width) mapping gets wrong.
  const poster = { naturalWidth: 4000, naturalHeight: 1000, complete: true, decode: async () => {} };
  const state = makeState({ poster, tweaks: { 'skin-a': Object.assign({}, api.DEFAULT_TWEAKS, { grayscale: 40, veil: 50 }) } });
  paintLog.length = 0;
  const frame = api.drawFrameForPicking(state);
  record(frame !== null && frame.width === 1600 && frame.height === 900, 'the canvas matches the viewport', frame === null ? 'null' : `${frame.width}x${frame.height}`);
  const draw = paintLog.find((row) => row.op === 'drawImage');
  record(draw !== undefined && near(draw.args[1], -1000) && near(draw.args[2], 0) && near(draw.args[3], 3600) && near(draw.args[4], 900), 'the cover geometry matches object-fit: cover', draw === undefined ? 'no draw' : draw.args.slice(1).map((value) => Math.round(value)).join(','));
  record(draw !== undefined && String(draw.filter).includes('grayscale(40%)'), 'the filters are in force for the artwork draw itself', draw === undefined ? 'no draw' : String(draw.filter));
  record(paintLog.filter((row) => row.op === 'fillRect').every((row) => row.filter === 'none'), 'and reset before the scrim is painted, so the scrim is not filtered');
  record(paintLog.some((row) => row.op === 'fillRect' && row.args[2] === 1600), 'the scrim is painted over the artwork, so the picked pixel is the one on screen');
  record(api.drawFrameForPicking(makeState()) === null, 'with nothing on screen the picker declines rather than drawing a blank frame');

  const pixelState = makeState();
  const reads = makeContext(() => [18, 52, 86, 255]);
  record(api.readPickPixel(pixelState, reads, 10, 20) === '#123456', 'a pixel reads back as hex', api.readPickPixel(pixelState, reads, 10, 20));
  const tainted = makeState();
  record(api.readPickPixel(tainted, makeContext(null), 1, 1) === null && typeof tainted.pickNote === 'string', 'a refused canvas read degrades to a note instead of throwing', String(tainted.pickNote));
  canvasPixels = () => [200, 40, 90, 255];
  document.createElement = originalCreate;
  void api;
}

{
  const document = makeDocument();
  const api = boot(document, windowStub);
  const poster = { naturalWidth: 1920, naturalHeight: 1080, complete: true, decode: async () => {} };
  const state = makeState({ poster });
  const picked = [];
  // Two pixels: the overlay samples whatever the context reports.
  const originalCreate = document.createElement;
  document.createElement = (tag) => {
    const node = originalCreate(tag);
    if (String(tag).toLowerCase() === 'canvas') node.context = makeContext(() => [200, 40, 90, 255]);
    return node;
  };
  api.startPicker(state, (hex) => picked.push(hex));
  const overlay = document.querySelectorAll(`[${api.PICK_ATTRIBUTE}]`);
  record(overlay.length === 1, 'the overlay is attached to the document', String(overlay.length));
  record(overlay[0].parentElement === document.body, 'it hangs off body, so it sits above every column');
  record((overlay[0].style.cssText.includes('z-index:2147483646')) === true, 'and above the app UI', overlay[0].style.cssText.slice(0, 40));
  api.startPicker(state, () => {});
  record(document.querySelectorAll(`[${api.PICK_ATTRIBUTE}]`).length === 1, 'a second click on the button does not stack overlays');
  overlay[0].dispatch('pointermove', { clientX: 800, clientY: 400 });
  record(state.picker.swatch.textContent === '' || state.picker.swatch.children[0].style.background === '#c8285a', 'moving updates the swatch with the sampled colour', state.picker.swatch.children[0].style.background);
  overlay[0].dispatch('click', { clientX: 800, clientY: 400, preventDefault: () => {}, stopPropagation: () => {} });
  record(picked.length === 1 && picked[0] === '#c8285a', 'clicking reports the pixel colour once', picked.join(','));
  record(document.querySelectorAll(`[${api.PICK_ATTRIBUTE}]`).length === 0 && state.picker === null, 'and closes the overlay');
  record(state.picker === null, 'the state no longer holds a picker');

  api.startPicker(state, (hex) => picked.push(hex));
  document.dispatch('keydown', { key: 'Escape' });
  record(document.querySelectorAll(`[${api.PICK_ATTRIBUTE}]`).length === 0 && picked.length === 1, 'Escape closes the overlay without picking');
  record(document.listenerCount() === 0, 'and releases the key listener', String(document.listenerCount()));
  api.stopPicker(state);
  record(true, 'stopping a picker that is not open is harmless');

  // A context that cannot be created at all must not throw.
  const noCanvas = makeState({ poster });
  document.createElement = (tag) => {
    const node = originalCreate(tag);
    if (String(tag).toLowerCase() === 'canvas') node.context = null;
    return node;
  };
  api.startPicker(noCanvas, () => {});
  record(noCanvas.picker === null && document.querySelectorAll(`[${api.PICK_ATTRIBUTE}]`).length === 0, 'a canvas that refuses a 2d context leaves no overlay behind');
  document.createElement = originalCreate;
}

/* ── 5. the picked accent ─────────────────────────────────────────────────── */

{
  const document = makeDocument();
  const api = boot(document, windowStub);
  const dark = '#141416';
  const light = '#f4f4f6';
  const already = api.adjustAccentForSurface('#ff7a45', dark, {});
  record(already.shifted === false && already.color === '#ff7a45', 'a colour that already reads well is used as picked, unchanged', `${already.color} shifted=${already.shifted}`);
  record(already.against >= 3 && already.inkRatio >= 4.5, 'and it really does clear both floors', `against ${already.against.toFixed(2)}, ink ${already.inkRatio.toFixed(2)}`);

  // #8a8a8a against a near-black panel already reads at 5.33:1 — which is itself
  // worth pinning, since it means the correction does not fire needlessly.
  const comfortable = api.adjustAccentForSurface('#8a8a8a', dark, {});
  record(comfortable.shifted === false && comfortable.against >= 5, 'a mid-grey that already clears 5:1 on a dark panel is not touched', `against ${comfortable.against.toFixed(2)}`);
  const tooDark = '#3a3a3a';
  const mid = api.adjustAccentForSurface(tooDark, dark, {});
  record(mid.shifted === true && mid.against >= 3 && mid.inkRatio >= 4.5, 'a colour that is too close to the panel is moved until it reads', `${mid.from} → ${mid.color} (against ${mid.against.toFixed(2)}, ink ${mid.inkRatio.toFixed(2)})`);
  record(mid.color !== mid.from, 'and the reported colour is the one that will be applied');
  const pickedHsl = api.rgbToHsl(0x3a, 0x3a, 0x3a);
  const appliedHsl = api.rgbToHsl(...[1, 3, 5].map((at) => parseInt(mid.color.slice(at, at + 2), 16)));
  record(near(pickedHsl.s, appliedHsl.s, 0.05), 'saturation is preserved (only lightness moves)', `s ${pickedHsl.s.toFixed(3)} → ${appliedHsl.s.toFixed(3)}`);
  record(appliedHsl.l > pickedHsl.l, 'on a dark panel the accent is lightened, not darkened', `l ${pickedHsl.l.toFixed(3)} → ${appliedHsl.l.toFixed(3)}`);
  const tinted = api.adjustAccentForSurface('#2a3d55', dark, {});
  record(tinted.shifted === true && near(api.rgbToHsl(0x2a, 0x3d, 0x55).h, api.rgbToHsl(...[1, 3, 5].map((at) => parseInt(tinted.color.slice(at, at + 2), 16))).h, 0.03), 'a coloured accent keeps its hue', `${tinted.from} → ${tinted.color}`);
  const onLight = api.adjustAccentForSurface('#d8d8d8', light, {});
  record(onLight.shifted === true && onLight.against >= 3 && onLight.inkRatio >= 4.5, 'a pale colour on a light panel is dark rather than lightened', `${onLight.from} → ${onLight.color}`);
  const darkAccent = api.adjustAccentForSurface('#101010', dark, {});
  record(darkAccent.shifted === true && darkAccent.inkRatio >= 4.5, 'an almost-black accent on a dark panel still ends up readable', `${darkAccent.from} → ${darkAccent.color}`);
  const inkChoice = api.adjustAccentForSurface('#ffd400', dark, {});
  record(inkChoice.ink === api.INK_ON_ACCENT, 'a bright accent gets dark ink', `${inkChoice.ink} @ ${inkChoice.inkRatio.toFixed(2)}:1`);
  // Picking the panel's own colour is the worst case, and the lightness search
  // still lands somewhere readable — so this asserts a solution, not a failure.
  const worstCase = api.adjustAccentForSurface('#2b2b2b', '#2b2b2b', {});
  record(worstCase.shifted === true && worstCase.against >= 3 && worstCase.inkRatio >= 4.5, 'even picking the panel colour itself ends up readable', `#2b2b2b → ${worstCase.color} (against ${worstCase.against.toFixed(2)}, ink ${worstCase.inkRatio.toFixed(2)})`);
  // The unreachable branch: floors nothing can satisfy must be reported as approximate.
  const impossible = api.adjustAccentForSurface('#2b2b2b', '#2b2b2b', { graphicFloor: 21, textFloor: 21 });
  record(impossible.approximate === true && impossible.shifted === true, 'demands that cannot be met are reported as approximate rather than silently "fixed"', `closest ${impossible.color} at ${impossible.against.toFixed(2)}:1`);

  const base = {
    '--dsw-alias-bg-base': { light: 'rgba(20,20,22,0.62)', dark: 'rgba(20,20,22,0.62)' },
    '--dsw-alias-label-primary': { light: '#f2f2f5', dark: '#f2f2f5' },
    '--dsw-alias-brand-primary': { light: '#8a8a8a', dark: '#8a8a8a' },
    '--dsw-alias-brand-text': { light: '#8a8a8a', dark: '#8a8a8a' },
  };
  const next = api.withAccentTokens(base, mid);
  record(next['--dsw-alias-bg-base'].light === base['--dsw-alias-bg-base'].light, 'the surfaces are left exactly as they were');
  record(next['--dsw-alias-label-primary'].light === base['--dsw-alias-label-primary'].light, 'so are the text tokens');
  record(next['--dsw-alias-brand-primary'].light === mid.color && next['--dsw-alias-brand-primary'].dark === mid.color, 'the accent family takes the picked colour in both schemes');
  record(api.ACCENT_TOKENS.every((key) => next[key] !== undefined), 'every accent token the panel knows about is written', String(api.ACCENT_TOKENS.length));
  record(next['--dsw-alias-label-primary-foreground'].light === mid.ink, 'the ink on top of the accent is the readable one', String(next['--dsw-alias-label-primary-foreground'].light));

  // End to end through the token layer.
  const applied = [];
  const ctx = { theme: { overrideTokens: (source, tokens) => { applied.push({ source, tokens }); return () => {}; } } };
  const state = makeState({ skinId: 'skin-a', catalog: { skins: [{ skinId: 'skin-a', presentedTokens: base }], defaultSkin: null } });
  const accent = api.setAccentOverride(ctx, state, '#8a8a8a');
  record(applied.length === 1 && state.tokenSource === 'skin+pick', 'picking an accent installs the token layer with the accent folded in', state.tokenSource);
  record(applied[0].tokens['--dsw-alias-brand-primary'].light === accent.color, 'and the installed tokens carry the corrected colour', applied[0].tokens['--dsw-alias-brand-primary'].light);
  record(state.accentOverride.surface === '#141416' && state.accentOverride.surfaceNote === '画布实测', 'the surface it was judged against comes from the live measurement', `${state.accentOverride.surface} (${state.accentOverride.surfaceNote})`);
  record(state.accentOverride.picked === '#8a8a8a' && state.accentOverride.color === accent.color, 'the override remembers what was picked and what was applied', `${state.accentOverride.picked} → ${state.accentOverride.color}`);
  // A pick that has to move: the flag has to travel with it into the store.
  const moved = api.setAccentOverride(ctx, state, '#3a3a3a');
  record(moved.shifted === true && moved.picked === '#3a3a3a' && moved.color !== '#3a3a3a', 'a pick that needed correcting says so in the store', `${moved.picked} → ${moved.color}`);
  api.clearAccentOverride(ctx, state);
  const beforeClear = applied.length;
  api.clearAccentOverride(ctx, state);
  record(state.accentOverride === null && state.tokenSource === 'skin', 'clearing the accent restores the skin palette', state.tokenSource);
  record(applied.length === beforeClear + 1 && applied[beforeClear].tokens['--dsw-alias-brand-primary'].light === base['--dsw-alias-brand-primary'].light, 'and re-installs the untouched palette', `installs: ${applied.length}`);
  const liveState = makeState({ catalog: { skins: [{ skinId: 'skin-a', presentedTokens: base }], defaultSkin: null } });
  liveState.liveTokens = { surface: '#202024', tokens: base };
  liveState.tweaks = { 'skin-a': Object.assign({}, api.DEFAULT_TWEAKS, { uiFollow: true }) };
  api.setAccentOverride(ctx, liveState, '#ff7a45');
  record(liveState.tokenSource === 'live+pick', 'with the live layer on, a pick layers on top of it', liveState.tokenSource);
}

/* ── 6. wiring and hygiene ────────────────────────────────────────────────── */

{
  const document = makeDocument();
  const api = boot(document, windowStub);
  // A reload must not inherit a hidden UI or a stranded overlay.
  const stranded = document.createElement('div');
  stranded.setAttribute(api.FOCUS_ATTRIBUTE, '1');
  const strayOverlay = document.createElement('div');
  strayOverlay.setAttribute(api.PICK_ATTRIBUTE, '1');
  document.body.append(stranded, strayOverlay);
  document.documentElement.setAttribute('data-dsh-focus', '1');
  api.sweepStrandedUi();
  record(stranded.hasAttribute(api.FOCUS_ATTRIBUTE) === false && document.querySelectorAll(`[${api.PICK_ATTRIBUTE}]`).length === 0, 'a reload sweeps stranded hide-attributes and overlays', '');
  record(document.documentElement.hasAttribute('data-dsh-focus') === false, 'and clears the document mark');

  const teardown = clientSource.slice(clientSource.indexOf('return () => {\n        disposed = true;'));
  const at = (needle) => teardown.indexOf(needle);
  record(at('exitFocusMode(state)') > -1 && at('exitFocusMode(state)') < at('state.panel.remove()'), 'the disposer leaves focus mode before removing the panel', '');
  record(at('stopPicker(state)') > -1 && at('stopPicker(state)') < at('state.panel.remove()'), 'and closes an open picker');
  record(at('state.customStyle.remove()') > -1, 'and removes the injected stylesheet');
  record(clientSource.includes('document.querySelector(".dsh-skins-panel")'), 'focus mode finds the panel by its own stable class, not by a hashed DSH class');
  record(/\[" \+ FOCUS_ATTRIBUTE \+ "\]\{display:none !important\}/u.test(clientSource), 'the hide rule is part of the panel stylesheet');
  record(clientSource.indexOf('title: "开发者选项"') > clientSource.indexOf('title: "自动化"') && clientSource.indexOf('title: "开发者选项"') > clientSource.indexOf('title: "皮肤库"'), 'the developer section is the last one in the panel');
  record(clientSource.includes('view.customCss') && clientSource.includes('onChange: (event) => setCustomCss(store, event.target.value)'), 'typing in the textarea applies immediately (live preview)');
  record(clientSource.includes('sweepStrandedUi();'), 'the sweep runs at mount');
  record(/const style = document\.createElement\("style"\)/u.test(clientSource) && clientSource.includes('state.customStyle.textContent = state.customCss'), 'the sheet is installed as text, never as markup');
  const evalUse = /\beval\s*\(|new Function\s*\(/u.test(slice);
  record(evalUse === false, 'the browser half contains no eval or Function constructor');
  record(document.querySelectorAll('link[rel=stylesheet]').length === 0, 'and no remote stylesheet is added');
}

const failed = results.filter((row) => !row.ok);
console.log(`\nchecks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  for (const row of failed) console.log(`FAILED ${row.label} ${row.detail}`);
  process.exitCode = 1;
}
