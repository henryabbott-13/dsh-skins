window.__ModuleLoader__.load({
	id: "@henryabbott-13/dsh-plugin-skins",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const PACKAGE_ID = "@henryabbott-13/dsh-plugin-skins";
		/*
		 * Browser half of the dsh skins plugin.
		 *
		 * Two jobs, in this order:
		 *
		 *   1. The background itself. Fetch the catalog from `${ROUTE}/catalog` (served
		 *      by the host half), read the saved selection, then stack the skin's token
		 *      layer through `ctx.theme.overrideTokens` and inject its own stylesheet,
		 *      and paint the artwork layer behind the shell.
		 *   2. The "背景设置" (Background settings) panel, as a real page in the right
		 *      sidebar — the same seat the shipped Files / Terminal / Browser start-page
		 *      cards use. It lists every generated skin with a live thumbnail, applies
		 *      one on click, exposes the three readability knobs (blur, opacity, veil),
		 *      and uploads new source media for the host half to turn into new skins.
		 *
		 * Why the token layer matters: dsh's shell paints its own surfaces from
		 * `--dsw-alias-bg-base` (`.BynINW_frame`, `.BynINW_centerCol`), so an opaque
		 * value would hide the artwork entirely. The host half publishes translucent
		 * values for exactly those tokens, and solid values for text and borders.
		 *
		 * Why the panel is a tab type and not a floating box: the sidebar's own
		 * extension seat is the supported way in. `ctx.sidebarRightTabs.register()`
		 * makes the start-page card, `ctx.slots.register()` on `sidebar.right.pane.tab`
		 * makes the page. The column then owns width, docking, focus and keyboard, and
		 * this plugin owns only its own markup — which is also why a shipped-side
		 * change cannot leave a floating box stranded over the UI.
		 *
		 * This file is NOT a module: `build.mjs` wraps it in a
		 * `window.__ModuleLoader__.load({ factory })` registration, where `react`,
		 * `require` and `PACKAGE_ID` are already in scope.
		 */

		/** Route prefix owned by the host half. */
		const ROUTE = "/dsh-skins";
		const CATALOG_URL = ROUTE + "/catalog";
		const REPORT_URL = ROUTE + "/report";
		const UPLOAD_URL = ROUTE + "/upload";
		const GENERATE_URL = ROUTE + "/generate";
		const JOB_URL = ROUTE + "/job";
		const FFMPEG_URL = ROUTE + "/ffmpeg";
		const COMPRESS_URL = ROUTE + "/compress";
		const ASSET_JOB_URL = ROUTE + "/asset-job";
		const EXPORT_URL = ROUTE + "/export";
		const IMPORT_URL = ROUTE + "/import";
		const CLEANUP_URL = ROUTE + "/cleanup";
		const PREFS_URL = ROUTE + "/preferences";
		/** The localStorage mirror of the preferences file (see loadPreferences). */
		const PREFS_CACHE_KEY = "dsh-skins/v1/prefs-cache";

		/**
		 * The host/client *route contract* version. Bumped only when the routes or the
		 * catalog shape change, because the panel uses it to detect a host module still
		 * cached from before an edit (the desktop profile does not hot-replace a host
		 * half). A UI-only change does not touch it — otherwise a freshly restarted app
		 * would report a mismatch forever.
		 */
		const REVISION = "2026-09-30.panel-9-advanced";

		/** The panel UI's own version, for the client report only. */
		const UI_VERSION = "panel-9";

		/** Selection + polarity persist here; both are per-origin, so the desktop app keeps its own. */
		const PREFS_KEY = "dsh-skins/v1";
		/** Per-skin look knobs. */
		const TWEAKS_KEY = "dsh-skins/v1/tweaks";
		/** Striped if a report delivery fails, so diagnostics are never lost with the tab. */
		const REPORT_BACKUP_KEY = "dsh-skins/v1/report";
		/** The bottom-right quick switcher can be hidden; that choice persists. */
		const HIDDEN_KEY = "dsh-skins/v1/hidden";
		/** Favourite skin ids. */
		const FAVORITES_KEY = "dsh-skins/v1/favorites";
		/** The automation rules (system / time / project / rotation). */
		const AUTOMATION_KEY = "dsh-skins/v1/automation";
		/**
		 * The workspace → session index, harvested from the slot snapshot the panel sees.
		 *
		 * It is persisted because the automation has to resolve "which workspace is this
		 * session in" while the panel is closed, and the client exposes no workspace
		 * observable outside a React slot. The harvest is authoritative whenever it runs
		 * (it comes from the same snapshot the left column renders), so opening the panel
		 * once is what keeps it fresh.
		 */
		const WORKSPACE_INDEX_KEY = "dsh-skins/v1/workspaces";
		/**
		 * How often the time and project rules are re-checked. Coarse on purpose: the
		 * rules move on minute boundaries, and a finer tick would only burn wakeups.
		 * Sleep, resume and focus re-check immediately, so a suspended machine does not
		 * wait for the tick.
		 */
		const AUTOMATION_TICK_MS = 30000;
		/** Where the asset settings live; they travel to the host with every request. */
		const ASSETS_KEY = "dsh-skins/v1/assets";
		/**
		 * The asset defaults mirror the host's, so a panel that has never been touched
		 * and a host that receives no settings agree on what "automatic" means.
		 */
		const ASSET_DEFAULTS = { autoCompress: true, thresholdMB: 50, targetHeight: 1080, bitrateMbps: 5, includeSource: false };
		/** The target heights the host accepts. */
		const ASSET_HEIGHTS = [720, 1080, 1440];
		/** Marks the artwork layer so the switcher can find it again after a reload. */
		const LAYER_ATTRIBUTE = "data-dsh-skin-layer";
		/** Marks the injected stylesheet for teardown. */
		const STYLE_ATTRIBUTE = "data-plugin-css";

		/** Tab kind this plugin contributes to the right sidebar. */
		const TAB_KIND = "skins";
		/**
		 * Start-page card order. The shipped cards are files 10, terminal 20,
		 * browser 30, so anything above 30 lands below them — which is the seat that
		 * was asked for.
		 */
		const GUIDE_ORDER = 40;
		const PANEL_TITLE = "背景设置";

		/** Command ids registered with the application shortcut service. */
		const COMMAND_TOGGLE = "dsh-skins.toggle-panel";
		const COMMAND_RANDOM = "dsh-skins.random-skin";

		/**
		 * The knobs, in the units the sliders use: pixels for blur, percent for the
		 * rest, booleans for the two switches. Keeping ONE unit for storage is what
		 * stops a default from being clamped to a slider minimum — a fraction-valued
		 * default ("opacity: 1") read against a percent range silently became 20%,
		 * which washes the artwork out.
		 *
		 * `parallax` and `uiFollow` are per skin like the rest, so a busy frame can keep
		 * its parallax while a calm one does not.
		 */
		const DEFAULT_TWEAKS = {
		  blur: 0,
		  opacity: 100,
		  veil: 100,
		  grayscale: 0,
		  saturate: 100,
		  contrast: 100,
		  posterize: 0,
		  parallax: false,
		  uiFollow: false,
		  // Video-only knobs. Muted defaults to true because autoplay admission is
		  // decided by the element's muted flag: an unmuted start would be refused and
		  // the background would fall back to its poster.
		  videoPlaying: true,
		  videoMuted: true,
		  videoRate: 1,
		  audioReactive: false,
		};
		const TWEAK_LIMITS = {
		  blur: { min: 0, max: 40, step: 1 },
		  opacity: { min: 20, max: 100, step: 1 },
		  veil: { min: 0, max: 200, step: 5 },
		  grayscale: { min: 0, max: 100, step: 1 },
		  saturate: { min: 0, max: 200, step: 1 },
		  contrast: { min: 50, max: 200, step: 1 },
		  posterize: { min: 0, max: 100, step: 5 },
		};

		/**
		 * Displacement and tilt ceilings for the parallax. The brief caps the movement
		 * at 10 CSS pixels, so both axes stay at or under it.
		 */
		const PARALLAX_MAX_X = 10;
		const PARALLAX_MAX_Y = 7;
		const PARALLAX_TILT_DEG = 0.55;
		/** Extra overscan so a shifted, tilted frame never shows the layer's own edge. */
		const LAYER_OVERSCAN = 1.03;

		/** The hidden SVG filter the posterize slider drives. */
		const POSTERIZE_FILTER_ID = "dsh-skin-posterize";

		/** The playback speeds the panel offers. */
		const VIDEO_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
		/**
		 * The audio drive is published as two CSS variables rather than rewritten into
		 * the `filter`/`transform` strings, so a 60fps pulse costs two custom-property
		 * writes instead of re-parsing a filter list on a video element every frame.
		 */
		const AUDIO_SCALE_VAR = "--dsh-skin-audio-scale";
		const AUDIO_BRIGHTNESS_VAR = "--dsh-skin-audio-brightness";
		/** How far the pulse may push scale and brightness; both stay deliberately slight. */
		const AUDIO_SCALE_MAX = 0.02;
		const AUDIO_BRIGHTNESS_MAX = 0.16;
		/** RMS below which a playing analyser is treated as silent (no audio track). */
		const AUDIO_SILENCE_FLOOR = 0.004;
		/** Frames of provable silence before the panel says the video has no audio. */
		const AUDIO_SILENCE_FRAMES = 90;

		const REQUIRED = ["theme"];
		const inject = ["theme"];

		/** `React.createElement`, bound once: this file carries no JSX transform. */
		const h = react.createElement;

		/* ------------------------------------------------------------------ *
		 * Small helpers
		 * ------------------------------------------------------------------ */

		/** Route → URL for one skin asset, tolerating a missing entry. */
		function assetUrl(skin, kind) {
		  const value = skin && skin.assets ? skin.assets[kind] : null;
		  return typeof value === "string" && value.length > 0 ? value : null;
		}

		/** The label a human reads for one skin. */
		function skinLabel(skin) {
		  if (skin === null || skin === undefined) return "内置主题";
		  return skin.nameZh || skin.name || skin.skinId;
		}

		function clamp(value, min, max) {
		  if (!Number.isFinite(value)) return min;
		  return value < min ? min : value > max ? max : value;
		}

		function formatBytes(bytes) {
		  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
		  const units = ["B", "KB", "MB", "GB"];
		  let value = bytes;
		  let unit = 0;
		  while (value >= 1024 && unit < units.length - 1) {
		    value /= 1024;
		    unit += 1;
		  }
		  return (unit === 0 ? String(Math.round(value)) : value.toFixed(1)) + " " + units[unit];
		}

		/** Read the saved preferences, tolerating anything unreadable. */
		function readPrefs() {
		  try {
		    const raw = window.localStorage.getItem(PREFS_KEY);
		    if (raw === null) return {};
		    const parsed = JSON.parse(raw);
		    return typeof parsed === "object" && parsed !== null ? parsed : {};
		  } catch {
		    return {};
		  }
		}

		function writePrefs(next) {
		  try {
		    window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
		  } catch {
		    /* a full or blocked localStorage is not a reason to fail the skin */
		  }
		}

		/** Whether the visitor asked for reduced motion; re-read on every change. */
		function prefersReducedMotion() {
		  try {
		    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		  } catch {
		    return false;
		  }
		}

		/* ------------------------------------------------------------------ *
		 * The look knobs (blur / opacity / veil)
		 * ------------------------------------------------------------------ */

		/** `{ "<skinId>": { blur, opacity, veil } }` — per skin, so one skin's tuning is not another's. */
		function readTweaks() {
		  try {
		    const raw = window.localStorage.getItem(TWEAKS_KEY);
		    if (raw === null) return {};
		    const parsed = JSON.parse(raw);
		    return typeof parsed === "object" && parsed !== null ? parsed : {};
		  } catch {
		    return {};
		  }
		}

		function writeTweaks(table) {
		  try {
		    window.localStorage.setItem(TWEAKS_KEY, JSON.stringify(table));
		  } catch {
		    /* ignore */
		  }
		}

		/** The knobs in force for one skin, in slider units (px / percent / boolean). */
		function tweakSliders(state, skinId) {
		  const saved = skinId === null || skinId === undefined ? null : state.tweaks[skinId];
		  const merged = Object.assign({}, DEFAULT_TWEAKS, typeof saved === "object" && saved !== null ? saved : null);
		  const numeric = (key) => clamp(Number(merged[key]), TWEAK_LIMITS[key].min, TWEAK_LIMITS[key].max);
		  return {
		    blur: numeric("blur"),
		    opacity: numeric("opacity"),
		    veil: numeric("veil"),
		    grayscale: numeric("grayscale"),
		    saturate: numeric("saturate"),
		    contrast: numeric("contrast"),
		    posterize: numeric("posterize"),
		    parallax: merged.parallax === true,
		    uiFollow: merged.uiFollow === true,
		    videoPlaying: merged.videoPlaying !== false,
		    videoMuted: merged.videoMuted !== false,
		    videoRate: nearestRate(merged.videoRate),
		    audioReactive: merged.audioReactive === true,
		  };
		}

		/** Snap a stored rate onto an offered step, so a hand-edited value cannot stick. */
		function nearestRate(value) {
		  const rate = Number(value);
		  if (!Number.isFinite(rate)) return 1;
		  return VIDEO_RATES.reduce((best, candidate) => (Math.abs(candidate - rate) < Math.abs(best - rate) ? candidate : best), 1);
		}

		/** The same knobs as the layer consumes them: blur in px, the rest as factors. */
		function tweaksFor(state, skinId) {
		  const slider = tweakSliders(state, skinId);
		  return { blur: slider.blur, opacity: slider.opacity / 100, veil: slider.veil / 100 };
		}

		/**
		 * Persist one knob for one skin and repaint, without re-applying the whole skin.
		 *
		 * The live UI-colour layer is derived from the pixels the filters produce, so a
		 * filter change has to re-derive it; `ctx` is threaded through for exactly that
		 * (and may be absent in tests, where the derivation is exercised directly).
		 */
		function setTweak(ctx, state, skinId, key, sliderValue) {
		  if (skinId === null || skinId === undefined) return;
		  const current = Object.assign({}, DEFAULT_TWEAKS, state.tweaks[skinId] ?? {});
		  current[key] = sliderValue;
		  const next = Object.assign({}, state.tweaks);
		  next[skinId] = current;
		  state.tweaks = next;
		  writeTweaks(next);
		  applyLayerTweaks(state);
		  publish(state, {});
		  const filterKey = key === "grayscale" || key === "saturate" || key === "contrast" || key === "posterize";
		  if (ctx !== null && ctx !== undefined && filterKey && tweakSliders(state, skinId).uiFollow === true) scheduleLiveTokens(ctx, state);
		  const transportKey = key === "videoPlaying" || key === "videoMuted" || key === "videoRate";
		  if (transportKey) applyVideoSettings(state);
		  if (key === "audioReactive" && ctx !== null && ctx !== undefined) void applyAudioReactive(ctx, state);
		}

		/* ------------------------------------------------------------------ *
		 * Automation: the rules, and the timers that watch them
		 * ------------------------------------------------------------------ */

		/** A fresh rule set. Every skin slot is empty, so nothing fires until it is set. */
		function defaultAutomation() {
		  return {
		    system: { enabled: false, dark: null, light: null },
		    time: { enabled: false, start: "08:00", end: "18:00", day: null, night: null },
		    project: { enabled: false, bindings: {} },
		    rotation: { enabled: false, minutes: 30, favoritesOnly: false },
		  };
		}

		/**
		 * The precedence, highest first, exactly as the panel documents it.
		 *
		 * A specific binding beats a schedule, a schedule beats an ambient preference,
		 * and rotation is not in this list at all: it is a *fallback* that only acts
		 * when no rule claims the moment.
		 */
		const AUTOMATION_ORDER = ["project", "time", "system"];

		/** `"HH:MM"` → minutes since midnight, or null when it is not a clock time. */
		function parseClock(value) {
		  if (typeof value !== "string") return null;
		  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
		  if (match === null) return null;
		  const hours = Number(match[1]);
		  const minutes = Number(match[2]);
		  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
		  if (hours > 23 || minutes > 59) return null;
		  return hours * 60 + minutes;
		}

		/**
		 * Whether `now` falls inside `[start, end)`, in minutes.
		 *
		 * `end <= start` means the range wraps midnight (`22:00–06:00`), which is the
		 * case a naive `now >= start && now < end` gets backwards. An empty range
		 * (`start === end`) matches nothing rather than everything.
		 */
		function insideRange(nowMinutes, startMinutes, endMinutes) {
		  if (startMinutes === endMinutes) return false;
		  if (startMinutes < endMinutes) return nowMinutes >= startMinutes && nowMinutes < endMinutes;
		  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
		}

		/**
		 * The identity a workspace binding is keyed by: its path, normalised.
		 *
		 * Separators are folded to `/` as well as lower-cased, because the two sources of
		 * a path disagree about them: the workspace snapshot reports a Windows path with
		 * backslashes, while a path typed or pasted into the manual field may use either.
		 * Without this a binding could silently never match.
		 */
		function workspaceKey(path) {
		  if (typeof path !== "string") return null;
		  const trimmed = path.replace(/[\\/]+$/u, "").replaceAll("\\", "/").trim();
		  return trimmed.length === 0 ? null : trimmed.toLowerCase();
		}

		/** The last path segment — what the user calls the project. */
		function workspaceLabel(path) {
		  if (typeof path !== "string") return "";
		  const parts = path.split(/[\\/]+/u).filter((part) => part.length > 0);
		  return parts.length === 0 ? path : parts[parts.length - 1];
		}

		/** Whether the operating system is asking for a dark interface right now. */
		function systemPrefersDark() {
		  try {
		    return window.matchMedia("(prefers-color-scheme: dark)").matches === true;
		  } catch {
		    return false;
		  }
		}

		/**
		 * Which skin the rules want at `now`, and why.
		 *
		 * Pure on purpose: the whole precedence table is testable without a browser, and
		 * the caller only has to decide whether the answer differs from what is already
		 * applied.
		 *
		 * @param state - carries the automation config and the resolved workspace.
		 * @param now - the moment to evaluate (injectable for tests).
		 * @returns `{ source, sourceLabel, skinId, detail }`, or null when nothing claims it.
		 */
		function automationDecision(state, now) {
		  const config = state.automation ?? defaultAutomation();
		  const clock = now ?? new Date();
		  // 1. an explicit binding for the workspace this session belongs to
		  if (config.project.enabled === true) {
		    const key = state.currentWorkspaceKey ?? null;
		    const bound = key === null ? undefined : config.project.bindings[key];
		    if (typeof bound === "string" && bound.length > 0) {
		      return { source: "project", sourceLabel: "项目绑定", skinId: bound, detail: state.currentWorkspaceLabel ?? key };
		    }
		  }
		  // 2. a schedule
		  if (config.time.enabled === true) {
		    const start = parseClock(config.time.start);
		    const end = parseClock(config.time.end);
		    if (start !== null && end !== null) {
		      const inside = insideRange(clock.getHours() * 60 + clock.getMinutes(), start, end);
		      const skinId = inside ? config.time.day : config.time.night;
		      if (typeof skinId === "string" && skinId.length > 0) {
		        return {
		          source: "time",
		          sourceLabel: "时间段",
		          skinId,
		          detail: (inside ? "时段内 " : "时段外 ") + config.time.start + "–" + config.time.end,
		        };
		      }
		    }
		  }
		  // 3. an ambient preference
		  if (config.system.enabled === true) {
		    const dark = systemPrefersDark();
		    const skinId = dark ? config.system.dark : config.system.light;
		    if (typeof skinId === "string" && skinId.length > 0) {
		      return { source: "system", sourceLabel: "跟随系统", skinId, detail: dark ? "系统深色" : "系统浅色" };
		    }
		  }
		  return null;
		}

		/** The skin a rotation tick should choose, or null when it should stay put. */
		function rotationPick(state) {
		  const config = state.automation ?? defaultAutomation();
		  if (config.rotation.enabled !== true) return null;
		  // A rule that claims this moment outranks ambient rotation.
		  if (automationDecision(state, new Date()) !== null) return null;
		  const pool =
		    config.rotation.favoritesOnly === true
		      ? state.catalog.skins.filter((skin) => state.favorites.includes(skin.skinId))
		      : state.catalog.skins;
		  const candidates = pool.filter((skin) => skin.skinId !== state.skinId);
		  if (candidates.length === 0) return null;
		  return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
		}

		/** Read the rules, filling in anything a hand-edited store left out. */
		function readAutomation() {
		  const base = defaultAutomation();
		  try {
		    const raw = window.localStorage.getItem(AUTOMATION_KEY);
		    if (raw === null) return base;
		    const parsed = JSON.parse(raw);
		    if (parsed === null || typeof parsed !== "object") return base;
		    const group = (name) => (parsed[name] !== null && typeof parsed[name] === "object" ? parsed[name] : {});
		    const system = group("system");
		    const time = group("time");
		    const project = group("project");
		    const rotation = group("rotation");
		    return {
		      system: { enabled: system.enabled === true, dark: typeof system.dark === "string" ? system.dark : null, light: typeof system.light === "string" ? system.light : null },
		      time: {
		        enabled: time.enabled === true,
		        start: parseClock(time.start) === null ? base.time.start : time.start,
		        end: parseClock(time.end) === null ? base.time.end : time.end,
		        day: typeof time.day === "string" ? time.day : null,
		        night: typeof time.night === "string" ? time.night : null,
		      },
		      project: {
		        enabled: project.enabled === true,
		        bindings: project.bindings !== null && typeof project.bindings === "object" ? Object.assign({}, project.bindings) : {},
		      },
		      rotation: {
		        enabled: rotation.enabled === true,
		        minutes: clamp(Number(rotation.minutes), 1, 1440) || base.rotation.minutes,
		        favoritesOnly: rotation.favoritesOnly === true,
		      },
		    };
		  } catch {
		    return base;
		  }
		}

		function writeAutomation(config) {
		  try {
		    window.localStorage.setItem(AUTOMATION_KEY, JSON.stringify(config));
		  } catch {
		    /* a blocked store must not break the panel */
		  }
		}

		/** Read the harvested workspace index. */
		function readWorkspaceIndex() {
		  const empty = { at: null, fingerprint: null, items: [] };
		  try {
		    const raw = window.localStorage.getItem(WORKSPACE_INDEX_KEY);
		    if (raw === null) return empty;
		    const parsed = JSON.parse(raw);
		    if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.items)) return empty;
		    return { at: typeof parsed.at === "string" ? parsed.at : null, fingerprint: typeof parsed.fingerprint === "string" ? parsed.fingerprint : null, items: parsed.items };
		  } catch {
		    return empty;
		  }
		}

		function writeWorkspaceIndex(index) {
		  try {
		    window.localStorage.setItem(WORKSPACE_INDEX_KEY, JSON.stringify(index));
		  } catch {
		    /* ignore */
		  }
		}

		/* ------------------------------------------------------------------ *
		 * Applying the rules, and the timers that watch them
		 * ------------------------------------------------------------------ */

		/**
		 * Resolve the session on screen into a workspace, using the harvested index.
		 *
		 * `sessionId` is taken literally, including `undefined`: "no session is on
		 * screen" is a real state (the hero page, or a global panel replacing the
		 * conversation), and falling back to the remembered session there would let a
		 * project binding claim a moment it does not own.
		 */
		function refreshWorkspaceFromSession(state, sessionId) {
		  state.currentSessionId = typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
		  const items = state.workspaceIndex.items;
		  const owner = state.currentSessionId === null ? undefined : items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(state.currentSessionId));
		  if (owner === undefined) {
		    state.currentWorkspaceKey = null;
		    state.currentWorkspaceLabel = null;
		    state.currentWorkspaceTitle = null;
		    return;
		  }
		  state.currentWorkspaceKey = workspaceKey(owner.path);
		  state.currentWorkspaceLabel = workspaceLabel(owner.path);
		  state.currentWorkspaceTitle = typeof owner.title === "string" && owner.title.length > 0 ? owner.title : state.currentWorkspaceLabel;
		}

		/**
		 * Record the workspace snapshot the panel can see.
		 *
		 * The panel is a session-scoped slot, so it receives the same `useWorkspaces`
		 * snapshot the left column renders. Harvesting it here is what lets the
		 * automation resolve a session while the panel is closed — no extra host route,
		 * and no guessing from the file system.
		 */
		function harvestWorkspaces(state, snapshot) {
		  if (snapshot === null || snapshot === undefined || !Array.isArray(snapshot.items)) return;
		  const items = [];
		  for (const item of snapshot.items) {
		    if (item === null || typeof item !== "object" || typeof item.path !== "string") continue;
		    items.push({
		      id: String(item.workspaceId ?? item.path),
		      path: item.path,
		      title: typeof item.title === "string" && item.title.length > 0 ? item.title : workspaceLabel(item.path),
		      sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds.map(String) : [],
		    });
		  }
		  const fingerprint = JSON.stringify(items);
		  if (fingerprint === state.workspaceIndex.fingerprint) return;
		  state.workspaceIndex = { at: new Date().toISOString(), fingerprint, items };
		  writeWorkspaceIndex(state.workspaceIndex);
		  // Re-resolve the remembered session against the fresh index.
		  refreshWorkspaceFromSession(state, state.currentSessionId);
		  publish(state, {});
		}

		/** The distinct workspaces a binding can target, newest index first. */
		function bindableWorkspaces(state) {
		  const seen = new Set();
		  const out = [];
		  for (const item of state.workspaceIndex.items) {
		    const key = workspaceKey(item.path);
		    if (key === null || seen.has(key)) continue;
		    seen.add(key);
		    out.push({ key, label: item.title || workspaceLabel(item.path), path: item.path });
		  }
		  return out.sort((a, b) => a.label.localeCompare(b.label));
		}

		/** Persist one group of rules, rebuild the timers and re-decide. */
		function setAutomation(ctx, state, patch) {
		  const next = Object.assign({}, state.automation);
		  for (const [group, value] of Object.entries(patch ?? {})) {
		    next[group] = Object.assign({}, next[group], value);
		  }
		  state.automation = next;
		  writeAutomation(next);
		  // Any change can add or remove a timer, so the schedule is rebuilt from scratch
		  // rather than patched — one code path, no way to leave a stale interval behind.
		  startAutomation(ctx, state);
		  publish(state, {});
		  void evaluateAutomation(ctx, state, "config");
		}

		/** Apply the rules if they name a different skin than the one in force. */
		async function evaluateAutomation(ctx, state, reason) {
		  const decision = automationDecision(state, new Date());
		  state.automationDecision = decision;
		  const skinLabelOf = (skinId) => {
		    const skin = state.catalog.skins.find((entry) => entry.skinId === skinId);
		    return skin === undefined ? skinId : skinLabel(skin);
		  };
		  state.automationNote =
		    decision === null
		      ? state.automation.rotation.enabled === true
		        ? "无规则命中 · 轮播接管"
		        : "无规则命中（当前为手动选择）"
		      : decision.sourceLabel + " → " + skinLabelOf(decision.skinId) + " · " + decision.detail;
		  const token = decision === null ? "none" : decision.source + ":" + decision.skinId;
		  if (decision === null || state.automationApplied === token) {
		    publish(state, {});
		    return;
		  }
		  const skin = state.catalog.skins.find((entry) => entry.skinId === decision.skinId) ?? null;
		  if (skin === null) {
		    // Deliberately not marked applied: at boot the catalog may simply not have
		    // arrived yet, and marking it would stop the rule from ever firing.
		    state.automationNote = decision.sourceLabel + " 指向的皮肤不在目录中（" + decision.skinId + "）";
		    publish(state, {});
		    return;
		  }
		  if (state.automationBusy === true) {
		    publish(state, {});
		    return;
		  }
		  state.automationApplied = token;
		  state.automationBusy = true;
		  state.automationNote = state.automationNote + "（已应用 · " + reason + "）";
		  try {
		    await switchTo(ctx, state, skin, "auto-" + decision.source);
		  } finally {
		    state.automationBusy = false;
		  }
		}

		/** One rotation tick: a random skin, unless a rule claims the moment. */
		async function rotate(ctx, state) {
		  const pick = rotationPick(state);
		  if (pick === null) return;
		  state.automationApplied = "none";
		  await switchTo(ctx, state, pick, "auto-rotation");
		}

		/**
		 * Rebuild every timer and listener the automation needs.
		 *
		 * It tears the previous set down first, so a config edit can never leave a second
		 * interval running, and the disposers it records are what the fiber unload and
		 * `setAutomation` both call. Returning it also makes the effect self-documenting:
		 * `ctx.effect(() => { startAutomation(...); return () => stopAutomation(state) })`.
		 */
		function startAutomation(ctx, state) {
		  stopAutomation(state);
		  const disposers = [];
		  const config = state.automation;

		  // The OS colour scheme is watched unconditionally: turning the rule on later
		  // then needs no re-subscribe, and one matchMedia listener is nearly free.
		  try {
		    const query = window.matchMedia("(prefers-color-scheme: dark)");
		    const onScheme = () => void evaluateAutomation(ctx, state, "system");
		    query.addEventListener("change", onScheme);
		    disposers.push(() => query.removeEventListener("change", onScheme));
		  } catch {
		    /* an engine without matchMedia simply cannot follow the system */
		  }

		  // Waking up and regaining focus are the two moments a coarse tick would
		  // otherwise get wrong: a laptop resumed at 19:00 must re-evaluate at once.
		  const onWake = () => void evaluateAutomation(ctx, state, "wake");
		  window.addEventListener("focus", onWake);
		  document.addEventListener("visibilitychange", onWake);
		  disposers.push(() => {
		    window.removeEventListener("focus", onWake);
		    document.removeEventListener("visibilitychange", onWake);
		  });

		  if (config.time.enabled === true || config.project.enabled === true) {
		    const tick = window.setInterval(() => void evaluateAutomation(ctx, state, "tick"), AUTOMATION_TICK_MS);
		    disposers.push(() => window.clearInterval(tick));
		  }

		  if (config.rotation.enabled === true) {
		    const every = clamp(Number(config.rotation.minutes), 1, 1440) * 60000;
		    const timer = window.setInterval(() => void rotate(ctx, state), every);
		    disposers.push(() => window.clearInterval(timer));
		  }

		  // The session on screen is what a project binding keys off. `sidebarRight.mounted`
		  // is the one plain-JS source for it, and it is an observable, so a workspace
		  // switch applies the bound skin immediately instead of at the next tick.
		  const sidebar = ctx.get("sidebarRight");
		  const mounted = sidebar === null || sidebar === undefined ? null : sidebar.mounted ?? null;
		  if (mounted !== null && typeof mounted.subscribe === "function") {
		    const onSession = () => {
		      let sessionId = null;
		      try {
		        sessionId = mounted.getSnapshot();
		      } catch {
		        sessionId = null;
		      }
		      refreshWorkspaceFromSession(state, sessionId);
		      void evaluateAutomation(ctx, state, "workspace");
		    };
		    const unsubscribe = mounted.subscribe(onSession);
		    disposers.push(() => unsubscribe());
		    state.mountedSource = "sidebarRight";
		    onSession();
		  } else {
		    state.mountedSource = "panel-only";
		  }

		  state.automationDisposers = disposers;
		  return () => stopAutomation(state);
		}

		/** Release every timer and listener this module owns. Safe to call repeatedly. */
		function stopAutomation(state) {
		  const disposers = state.automationDisposers ?? [];
		  state.automationDisposers = [];
		  for (const dispose of disposers.reverse()) {
		    try {
		      dispose();
		    } catch {
		      /* a throw in one teardown must not strand the rest */
		    }
		  }
		}

		/* ------------------------------------------------------------------ *
		 * Assets: encoder settings, packs, and cleanup
		 * ------------------------------------------------------------------ */

		/** Read the asset settings, filling in anything a hand-edited store left out. */
		function readAssetSettings() {
		  const out = Object.assign({}, ASSET_DEFAULTS);
		  try {
		    const raw = window.localStorage.getItem(ASSETS_KEY);
		    if (raw === null) return out;
		    const parsed = JSON.parse(raw);
		    if (parsed === null || typeof parsed !== "object") return out;
		    out.autoCompress = parsed.autoCompress !== false;
		    out.includeSource = parsed.includeSource === true;
		    if (Number.isFinite(Number(parsed.thresholdMB))) out.thresholdMB = clamp(Number(parsed.thresholdMB), 1, 4096);
		    if (ASSET_HEIGHTS.includes(Number(parsed.targetHeight))) out.targetHeight = Number(parsed.targetHeight);
		    if (Number.isFinite(Number(parsed.bitrateMbps))) out.bitrateMbps = clamp(Number(parsed.bitrateMbps), 1, 40);
		    return out;
		  } catch {
		    return out;
		  }
		}

		function writeAssetSettings(next) {
		  try {
		    window.localStorage.setItem(ASSETS_KEY, JSON.stringify(next));
		  } catch {
		    /* ignore */
		  }
		}

		/** Merge one patch into the asset settings, persist, and repaint. */
		function setAssetSetting(state, patch) {
		  state.assets = Object.assign({}, state.assets, patch);
		  writeAssetSettings(state.assets);
		  publish(state, {});
		}

		/**
		 * Ask the host whether an encoder exists.
		 *
		 * The probe spawns a process, so the answer is cached in the store and the host
		 * caches it for a minute as well; `force` is what the 重新探测 button uses.
		 */
		async function refreshFfmpeg(state, force) {
		  if (force !== true && state.ffmpeg !== null && Date.now() - state.ffmpeg.at < 60000) return state.ffmpeg;
		  try {
		    const response = await fetch(FFMPEG_URL, { credentials: "same-origin" });
		    const payload = await response.json();
		    // A 404 means the *host half* predates this feature, which is a different
		    // problem from "no encoder installed" and must not be reported as one.
		    if (response.ok !== true || payload?.ok !== true) {
		      state.ffmpeg = { at: Date.now(), available: false, staleHost: true, error: payload?.error ?? `HTTP ${response.status}` };
		    } else {
		      state.ffmpeg = Object.assign({ at: Date.now(), staleHost: false }, payload);
		    }
		  } catch (error) {
		    state.ffmpeg = { at: Date.now(), available: false, staleHost: false, error: String(error && error.message ? error.message : error) };
		  }
		  publish(state, {});
		  return state.ffmpeg;
		}

		/** Poll the asset job until it settles. */
		async function pollAssetJob(state) {
		  for (let attempt = 0; attempt < 2400; attempt += 1) {
		    await new Promise((resolve) => window.setTimeout(resolve, 1500));
		    let payload;
		    try {
		      const response = await fetch(ASSET_JOB_URL, { credentials: "same-origin" });
		      payload = await response.json();
		    } catch (error) {
		      publish(state, { assetJob: { status: "failed", message: "任务轮询失败：" + String(error && error.message ? error.message : error) } });
		      return;
		    }
		    publish(state, { assetJob: payload.job });
		    if (payload.job === null || payload.job === undefined || payload.job.running !== true) return;
		  }
		  publish(state, { assetJob: { status: "failed", message: "等待超时" } });
		}

		/** Start a compression run for the given skins. */
		async function startCompress(state, skinIds, log) {
		  if (skinIds.length === 0) {
		    publish(state, { assetJob: { status: "skipped", message: "没有需要压缩的皮肤" } });
		    return;
		  }
		  publish(state, { assetJob: { status: "starting", message: `准备压缩 ${skinIds.length} 套 …`, log: "" } });
		  let payload;
		  try {
		    const response = await fetch(COMPRESS_URL, {
		      method: "POST",
		      credentials: "same-origin",
		      headers: { "content-type": "application/json" },
		      body: JSON.stringify({ skinIds, settings: state.assets }),
		    });
		    payload = await response.json();
		  } catch (error) {
		    publish(state, { assetJob: { status: "failed", message: "压缩请求失败：" + String(error && error.message ? error.message : error) } });
		    return;
		  }
		  if (payload.ok !== true) {
		    publish(state, { assetJob: { status: "failed", message: payload.error ?? "压缩被拒绝" } });
		    log?.("[dsh-skins] compress refused: " + JSON.stringify(payload));
		    return;
		  }
		  if (state.ffmpeg !== null && state.ffmpeg !== undefined) state.ffmpeg = Object.assign({}, state.ffmpeg, { available: payload.ffmpeg?.available === true, path: payload.ffmpeg?.path ?? null, version: payload.ffmpeg?.version ?? null });
		  publish(state, { assetJob: payload.job });
		  await pollAssetJob(state);
		}

		/** Export one skin as a pack. */
		async function exportSkin(state, skinId) {
		  publish(state, { exportResult: { status: "running", skinId } });
		  let payload;
		  try {
		    const response = await fetch(EXPORT_URL, {
		      method: "POST",
		      credentials: "same-origin",
		      headers: { "content-type": "application/json" },
		      body: JSON.stringify({ skinId, settings: state.assets, automation: state.automation, uiVersion: UI_VERSION }),
		    });
		    payload = await response.json();
		  } catch (error) {
		    publish(state, { exportResult: { status: "failed", message: String(error && error.message ? error.message : error) } });
		    return;
		  }
		  publish(state, { exportResult: payload.ok === true ? { status: "ok", skinId, file: payload.file, bytes: payload.bytes, entries: payload.entries?.length ?? 0 } : { status: "failed", skinId, message: payload.error ?? "导出失败" } });
		}

		/** Upload a pack and unpack it into the skins directory. */
		function postPack(file, onProgress) {
		  return new Promise((resolve, reject) => {
		    const request = new XMLHttpRequest();
		    request.open("POST", IMPORT_URL, true);
		    request.setRequestHeader("content-type", "application/zip");
		    request.setRequestHeader("x-dsh-skin-pack", encodeURIComponent(file.name));
		    if (request.upload !== null && request.upload !== undefined) {
		      request.upload.addEventListener("progress", (event) => {
		        if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
		      });
		    }
		    request.addEventListener("load", () => {
		      let payload = null;
		      try {
		        payload = JSON.parse(request.responseText);
		      } catch {
		        payload = null;
		      }
		      if (payload === null) reject(new Error("HTTP " + request.status));
		      else resolve(payload);
		    });
		    request.addEventListener("error", () => reject(new Error("network error")));
		    request.send(file);
		  });
		}

		async function importPack(ctx, state, file) {
		  publish(state, { importResult: { status: "running", name: file.name, percent: 0 } });
		  try {
		    const payload = await postPack(file, (fraction) =>
		      publish(state, { importResult: { status: "running", name: file.name, percent: Math.round(fraction * 100) } }),
		    );
		    if (payload.ok !== true) {
		      publish(state, { importResult: { status: "failed", name: file.name, message: (payload.error ?? "导入失败") + (payload.detail ? "：" + payload.detail : "") } });
		      return;
		    }
		    publish(state, {
		      importResult: {
		        status: "ok",
		        name: file.name,
		        skinId: payload.skinId,
		        replaced: payload.replaced === true,
		        files: payload.files,
		        bytes: payload.bytes,
		        source: payload.source ?? null,
		        warnings: payload.warnings ?? [],
		      },
		    });
		    // A pack can carry per-skin parameters; adopt them so the imported skin looks
		    // the way it did where it was exported.
		    const settings = payload.manifest?.settings;
		    if (settings !== null && settings !== undefined && typeof settings === "object" && typeof payload.skinId === "string") {
		      const next = Object.assign({}, state.tweaks, { [payload.skinId]: settings });
		      state.tweaks = next;
		      writeTweaks(next);
		    }
		    await loadCatalog(state);
		  } catch (error) {
		    publish(state, { importResult: { status: "failed", name: file.name, message: String(error && error.message ? error.message : error) } });
		  }
		}

		/** Whether a stored knob record actually differs from the defaults. */
		function isTuned(record) {
		  if (record === null || typeof record !== "object") return false;
		  return Object.entries(record).some(([key, value]) => {
		    const fallback = DEFAULT_TWEAKS[key];
		    if (fallback === undefined) return value !== undefined && value !== null;
		    return value !== fallback;
		  });
		}

		/**
		 * Every skin something in this client still refers to.
		 *
		 * Only the client knows this: the current selection, the favourites, the
		 * automation bindings and the per-skin knobs all live in browser storage, so the
		 * host cannot compute the keep set by itself.
		 *
		 * A knobs record only counts while it differs from the defaults — moving a slider
		 * writes an entry even when it lands back on the default, and treating that as a
		 * reference would protect every skin that was ever touched, which is every skin.
		 *
		 * Rotation is deliberately *not* a reference: the catalog is re-read from disk on
		 * every request, so a removed skin simply stops being a candidate.
		 */
		function referencedSkins(state) {
		  const keep = new Set();
		  if (state.skinId !== null && state.skinId !== undefined) keep.add(state.skinId);
		  for (const id of state.favorites) keep.add(id);
		  for (const [id, record] of Object.entries(state.tweaks)) {
		    if (isTuned(record)) keep.add(id);
		  }
		  const automation = state.automation ?? defaultAutomation();
		  for (const id of [automation.system?.dark, automation.system?.light, automation.time?.day, automation.time?.night]) {
		    if (typeof id === "string" && id.length > 0) keep.add(id);
		  }
		  for (const id of Object.values(automation.project?.bindings ?? {})) {
		    if (typeof id === "string" && id.length > 0) keep.add(id);
		  }
		  if (typeof state.catalog.defaultSkin === "string" && state.catalog.defaultSkin.length > 0) keep.add(state.catalog.defaultSkin);
		  return Array.from(keep);
		}

		/** Plan a cleanup, or carry it out. */
		async function runCleanup(ctx, state, dryRun) {
		  const keep = referencedSkins(state);
		  publish(state, { cleanup: dryRun === true ? { status: "planning" } : { status: "running", remove: state.cleanup?.remove ?? [] } });
		  let payload;
		  try {
		    const response = await fetch(CLEANUP_URL, {
		      method: "POST",
		      credentials: "same-origin",
		      headers: { "content-type": "application/json" },
		      body: JSON.stringify({ keep, dryRun: dryRun === true }),
		    });
		    payload = await response.json();
		  } catch (error) {
		    publish(state, { cleanup: { status: "failed", message: String(error && error.message ? error.message : error) } });
		    return;
		  }
		  if (payload.ok !== true) {
		    publish(state, { cleanup: { status: "failed", message: payload.error ?? "清理失败" } });
		    return;
		  }
		  if (dryRun === true) {
		    publish(state, { cleanup: { status: "planned", remove: payload.remove ?? [], kept: payload.kept ?? 0, totalBytes: payload.totalBytes ?? 0, keep } });
		    return;
		  }
		  publish(state, { cleanup: { status: "done", removed: payload.removed ?? [], kept: payload.kept ?? [], totalBytes: payload.totalBytes ?? 0, logFile: payload.logFile, log: payload.log } });
		  await loadCatalog(state);
		}

		/* ------------------------------------------------------------------ *
		 * Developer options: custom CSS, focus mode, the eyedropper
		 * ------------------------------------------------------------------ */

		/** Where the developer stylesheet lives; it is global, not per skin. */
		const CUSTOM_CSS_KEY = "dsh-skins/v1/custom-css";
		/** The mark focus mode puts on every element it hides. */
		const FOCUS_ATTRIBUTE = "data-dsh-skin-hidden";
		/**
		 * The mark for the panel's own ancestor chain in focus mode.
		 *
		 * A separate attribute from the hide mark on purpose: those containers must stay
		 * visible (the settings page lives inside them) and are repositioned instead. Mixing
		 * the two would be how the sidebar's page disappears along with its column.
		 */
		const LANE_ATTRIBUTE = "data-dsh-skin-lane";
		/** The plugin-owned floating exit button, mounted only while focus mode is on. */
		const ANCHOR_ATTRIBUTE = "data-dsh-skin-exit";
		/**
		 * Written while focus mode is on and cleared on the way out, so a window closed
		 * during the mode is recognised on the next boot instead of coming up half hidden.
		 */
		const FOCUS_FLAG_KEY = "dsh-skins/v1/focus-active";
		/** The picker overlay's mark, so a reload can clean up a stranded one. */
		const PICK_ATTRIBUTE = "data-dsh-skin-picker";
		/** The global chord that toggles focus mode, and the physical key it watches. */
		const FOCUS_CHORD_LABEL = "Ctrl + Shift + Alt + Space";
		const FOCUS_CHORD_CODE = "Space";

		/** A sample that is unmissable and harmless: a thin frame around the window. */
		const CUSTOM_CSS_SAMPLE = [
		  "/* 示例：给窗口加一圈橙色描边，用来确认注入生效 */",
		  "body::after {",
		  '  content: "";',
		  "  position: fixed;",
		  "  inset: 0;",
		  "  pointer-events: none;",
		  "  z-index: 2147483647;",
		  "  border: 3px solid #ff7a45;",
		  "}",
		  "",
		].join("\n");

		/** The tokens the eyedropper rewrites. */
		const ACCENT_TOKENS = [
		  "--dsw-alias-brand-primary",
		  "--dsw-alias-brand-text",
		  "--dsw-alias-link",
		  "--dsw-alias-state-business-primary",
		  "--dsw-specific-sidebar-nav-item-active-accent",
		  "--dsw-alias-button-primary-fill",
		];

		/**
		 * Check a stylesheet for the mistakes that actually break an injection.
		 *
		 * Deliberately not a parser: one pass tracks braces, brackets, parentheses,
		 * comments and strings, and reports the first problem of each kind with a line
		 * and column. That covers what breaks a live stylesheet — an unbalanced brace
		 * silently swallows everything after it — while being honest about being a lint
		 * rather than a validation of property names.
		 *
		 * @returns `{ ok, errors, warnings, rules, lines, chars }`.
		 */
		function validateCss(css) {
		  const text = String(css ?? "");
		  const errors = [];
		  const warnings = [];
		  const positionOf = (index) => {
		    const slice = text.slice(0, Math.max(0, index));
		    return { line: slice.split("\n").length, column: index - slice.lastIndexOf("\n") };
		  };
		  const report = (index, message, kind) => {
		    const row = Object.assign(positionOf(index), { message, kind: kind === "warn" ? "warn" : "error" });
		    if (kind === "warn") warnings.push(row);
		    else errors.push(row);
		  };
		  let depth = 0;
		  let openBrace = -1;
		  let parens = 0;
		  let brackets = 0;
		  let quote = null;
		  let quoteAt = -1;
		  // Counted during the scan, not by counting `{` characters: a brace inside a
		  // comment or a string is not a rule, and the panel prints this number.
		  let rules = 0;
		  let index = 0;
		  while (index < text.length) {
		    const char = text[index];
		    const next = text[index + 1];
		    if (quote !== null) {
		      if (char === "\\") index += 2;
		      else if (char === quote) {
		        quote = null;
		        index += 1;
		      } else index += 1;
		      continue;
		    }
		    if (char === "/" && next === "*") {
		      const close = text.indexOf("*/", index + 2);
		      if (close === -1) {
		        report(index, "注释没有闭合（缺少 */）");
		        break;
		      }
		      index = close + 2;
		      continue;
		    }
		    if (char === '"' || char === "'") {
		      quote = char;
		      quoteAt = index;
		      index += 1;
		      continue;
		    }
		    if (char === "{") {
		      if (depth === 0) openBrace = index;
		      depth += 1;
		      rules += 1;
		    } else if (char === "}") {
		      depth -= 1;
		      if (depth < 0) {
		        report(index, "多了一个 }");
		        depth = 0;
		      }
		    } else if (char === "(") parens += 1;
		    else if (char === ")") {
		      parens -= 1;
		      if (parens < 0) {
		        report(index, "多了一个 )");
		        parens = 0;
		      }
		    } else if (char === "[") brackets += 1;
		    else if (char === "]") {
		      brackets -= 1;
		      if (brackets < 0) {
		        report(index, "多了一个 ]");
		        brackets = 0;
		      }
		    }
		    index += 1;
		  }
		  if (quote !== null) report(quoteAt, "字符串没有闭合（缺 " + quote + "）");
		  if (depth > 0) report(openBrace === -1 ? 0 : openBrace, "有 " + depth + " 个 { 没有闭合");
		  if (parens > 0) report(text.length, "有 " + parens + " 个 ( 没有闭合");
		  if (brackets > 0) report(text.length, "有 " + brackets + " 个 [ 没有闭合");
		  if (/@import/u.test(text)) report(text.search(/@import/u), "@import 会去远端拉取样式表，一般不是你想要的", "warn");
		  return {
		    ok: errors.length === 0,
		    errors,
		    warnings,
		    rules,
		    lines: text.split("\n").length,
		    chars: text.length,
		  };
		}

		function readCustomCss() {
		  try {
		    const raw = window.localStorage.getItem(CUSTOM_CSS_KEY);
		    return typeof raw === "string" ? raw : "";
		  } catch {
		    return "";
		  }
		}

		function writeCustomCss(text) {
		  try {
		    window.localStorage.setItem(CUSTOM_CSS_KEY, String(text ?? ""));
		  } catch {
		    /* ignore */
		  }
		}

		/**
		 * Install the developer stylesheet.
		 *
		 * The text goes in through `textContent`, never `innerHTML`: it is data, so a
		 * `</style>` inside it must stay text rather than close the element and start
		 * parsing markup. And only a sheet that passes the lint is installed — a
		 * half-typed rule must not strip the UI bare while the user is still typing, so a
		 * broken edit leaves the previous working sheet in place.
		 *
		 * @returns the validation result.
		 */
		function applyCustomCss(state) {
		  const check = validateCss(state.customCss);
		  state.customCssCheck = check;
		  if (check.ok !== true) return check;
		  if (String(state.customCss).trim().length === 0) {
		    if (state.customStyle !== null && state.customStyle !== undefined) {
		      state.customStyle.remove();
		      state.customStyle = null;
		    }
		    return check;
		  }
		  if (state.customStyle === null || state.customStyle === undefined) {
		    const style = document.createElement("style");
		    style.setAttribute(STYLE_ATTRIBUTE, PACKAGE_ID + "/custom");
		    style.setAttribute("data-dsh-skin-custom", "1");
		    (document.head ?? document.documentElement).append(style);
		    state.customStyle = style;
		  }
		  state.customStyle.textContent = state.customCss;
		  return check;
		}

		/** Replace the developer stylesheet and repaint. */
		function setCustomCss(state, text) {
		  state.customCss = String(text ?? "");
		  writeCustomCss(state.customCss);
		  applyCustomCss(state);
		  publish(state, {});
		}

		/** Drop the developer stylesheet entirely. */
		function clearCustomCss(state) {
		  state.customCss = "";
		  writeCustomCss("");
		  if (state.customStyle !== null && state.customStyle !== undefined) {
		    state.customStyle.remove();
		    state.customStyle = null;
		  }
		  state.customCssCheck = validateCss("");
		  publish(state, {});
		}

		/**
		 * The elements focus mode should hide: everything that is not on the path from
		 * `<body>` down to this panel.
		 *
		 * Structural rather than selector-based on purpose. DSH's own class names are
		 * hashed per build (`.BynINW_frame`), so a selector list would rot silently; the
		 * ancestor walk instead works at any nesting depth and is undone by removing one
		 * attribute. Nothing is unmounted — `display:none` keeps every terminal, reader
		 * and running turn alive, which is what makes the mode safe to leave on.
		 */
		/**
		 * Two rules keep the artwork out of the hide set, and both are load-bearing:
		 *
		 *   1. Anything that *is* or *contains* the background layer is never hidden. The
		 *      layer is appended to `<body>`, so a plain "hide the siblings" walk used to
		 *      hide the artwork itself and left a flat grey window. Everything the plugin
		 *      owns (layer, picker overlay, exit anchor) is therefore protected.
		 *   2. The panel's own ancestor chain is not hidden either — it is *promoted*
		 *      instead (see `enterFocusMode`): the settings page lives inside the right
		 *      sidebar, so hiding the sidebar would hide the page with it. Marking the
		 *      chain as a lane takes those boxes out of the layout (`position:fixed`) and
		 *      turns them into a floating dock, which is what removes the empty column the
		 *      old version left behind.
		 *
		 * `<body>` and `<html>` are never touched: they own the stacking context the
		 * layer sits in, and hiding either one would take the background with it.
		 */
		function collectFocusTargets(state, panelElement) {
		  const protect = [state.layer, state.focusAnchor, state.picker?.overlay, state.picker?.swatch, state.picker?.hint].filter(
		    (node) => node !== null && node !== undefined,
		  );
		  const isProtected = (node) => protect.some((other) => other === node || other.contains(node) || node.contains(other));
		  const targets = [];
		  const lanes = [];
		  let node = panelElement;
		  while (node !== null && node !== undefined) {
		    const parent = node.parentElement;
		    if (parent === null || parent === undefined) break;
		    const atRoot = parent === document.body || parent === document.documentElement;
		    // The chain from the panel up to (not including) body becomes the dock.
		    if (!atRoot) lanes.push(parent);
		    for (const child of Array.from(parent.children)) {
		      if (child === node) continue;
		      // Never the panel's own path, never the artwork, never the plugin's own UI.
		      if (child.contains(panelElement) || isProtected(child)) continue;
		      targets.push(child);
		    }
		    if (atRoot) break;
		    node = parent;
		  }
		  return { targets, lanes };
		}

		/**
		 * Root-layout conflicts in the user's injected CSS.
		 *
		 * The developer stylesheet is applied to the same document this mode manipulates,
		 * so a rule that hides or freezes the root would defeat the exit affordances —
		 * `body{display:none}` hides the exit button, `html{pointer-events:none}` makes it
		 * unclickable. Both are reported and block entry rather than being discovered
		 * after the window has gone blank.
		 *
		 * Deliberately narrow: only root-ish selectors (`html`, `body`, `:root`, `*`, or a
		 * bare `#app`/`#root`) and only declarations that hide or freeze. `body::after`
		 * decorations and ordinary component rules never trip it.
		 *
		 * @returns an array of `{ selector, declaration }` conflicts.
		 */
		function rootLayoutConflicts(css) {
		  const text = String(css ?? "").replace(/\/\*[\s\S]*?\*\//gu, " ");
		  const conflicts = [];
		  const rootish = /^(html|body|:root|\*)$|^#(app|root|application)$/iu;
		  const dangerous = /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)|content-visibility\s*:\s*hidden|pointer-events\s*:\s*none|position\s*:\s*fixed|transform\s*:|filter\s*:)/iu;
		  const rule = /([^{}]+)\{([^{}]*)\}/gu;
		  let match = rule.exec(text);
		  while (match !== null) {
		    const declarations = match[2];
		    for (const one of match[1].split(",")) {
		      const selector = one.trim();
		      // A pseudo-element is a decoration, not the root itself.
		      if (selector.includes("::")) continue;
		      if (!rootish.test(selector)) continue;
		      const hit = dangerous.exec(declarations);
		      if (hit !== null) conflicts.push({ selector, declaration: hit[1].trim() });
		    }
		    match = rule.exec(text);
		  }
		  return conflicts;
		}

		/** The plugin-owned floating way out, so focus mode never depends on memory. */
		function mountFocusAnchor(state) {
		  if (state.focusAnchor !== null && state.focusAnchor !== undefined) return;
		  const anchor = document.createElement("div");
		  anchor.setAttribute(ANCHOR_ATTRIBUTE, "1");
		  anchor.style.cssText = "position:fixed;right:14px;top:50%;transform:translateY(-50%);z-index:2147483000;display:flex;flex-direction:column;gap:6px;align-items:flex-end";
		  const exit = document.createElement("button");
		  exit.type = "button";
		  exit.textContent = "退出专注模式";
		  exit.title = "也可以按 Esc";
		  exit.style.cssText =
		    "opacity:0.5;transition:opacity 120ms ease;font:12px/1.2 'Segoe UI',system-ui,sans-serif;color:#fff;background:rgba(0,0,0,0.55);border:1px solid rgba(255,255,255,0.3);border-radius:9999px;padding:6px 10px;cursor:pointer;backdrop-filter:blur(6px)";
		  exit.addEventListener("mouseenter", () => {
		    exit.style.opacity = "1";
		  });
		  exit.addEventListener("mouseleave", () => {
		    exit.style.opacity = "0.5";
		  });
		  exit.addEventListener("click", (event) => {
		    event.preventDefault();
		    event.stopPropagation();
		    exitFocusMode(state);
		  });
		  anchor.append(exit);
		  (document.body ?? document.documentElement).append(anchor);
		  state.focusAnchor = anchor;
		}

		function unmountFocusAnchor(state) {
		  const anchor = state.focusAnchor;
		  if (anchor === null || anchor === undefined) return;
		  try {
		    anchor.remove();
		  } catch {
		    /* already detached */
		  }
		  state.focusAnchor = null;
		}

		/** Remember that the mode is on, so an unclean exit can be detected next boot. */
		function setFocusFlag(on) {
		  try {
		    if (on === true) window.localStorage.setItem(FOCUS_FLAG_KEY, "1");
		    else window.localStorage.removeItem(FOCUS_FLAG_KEY);
		  } catch {
		    /* ignore */
		  }
		}

		/**
		 * Ask the shell for browser fullscreen while focus mode is on.
		 *
		 * The Windows titlebar buttons are Electron's native overlay, painted above the
		 * page, so no CSS can remove them and this build does not bind F11. Chromium's
		 * Fullscreen API is the one thing available from inside the page, and it hides
		 * the whole native titlebar. It must be called synchronously from the user
		 * gesture that toggled the mode — which is exactly where this helper runs. A
		 * refusal (or a window that forbids fullscreen) leaves the mode itself intact:
		 * the buttons simply stay.
		 */
		function requestFocusFullscreen(state) {
		  if (state.focusFullscreen === true) return;
		  const root = document.documentElement;
		  if (root === null || root === undefined || typeof root.requestFullscreen !== "function") return;
		  try {
		    const attempt = root.requestFullscreen({ navigationUI: "hide" });
		    state.focusFullscreen = true;
		    if (attempt !== undefined && attempt !== null && typeof attempt.catch === "function") {
		      attempt.catch(() => {
		        state.focusFullscreen = false;
		      });
		    }
		  } catch {
		    state.focusFullscreen = false;
		  }
		}

		/** Leave only the fullscreen this mode entered; never someone else's. */
		function releaseFocusFullscreen(state) {
		  if (state.focusFullscreen !== true) return;
		  state.focusFullscreen = false;
		  if (document.fullscreenElement === null || document.fullscreenElement === undefined) return;
		  try {
		    const leaving = document.exitFullscreen();
		    if (leaving !== undefined && leaving !== null && typeof leaving.catch === "function") leaving.catch(() => {});
		  } catch {
		    /* already leaving */
		  }
		}

		/**
		 * Sample what is painted along the top edge, for diagnosing leftover bands.
		 *
		 * A screenshot cannot say which element paints a grey rectangle, and the shell's
		 * class names are hashed per build (0.2.0 `BynINW_`, 0.2.1 `mP3x-q_`) so a
		 * selector written from memory rots silently. This walks `elementFromPoint` over
		 * a grid of top-edge points and records each chain's tag, class suffix, computed
		 * background and box, then posts it with the client report. It runs once per
		 * focus-mode entry — never on a hot path — and is what turns "there is a grey
		 * block" into "this exact element paints it".
		 */
		function probeTopEdge() {
		  const points = [];
		  if (typeof document.elementFromPoint !== "function") return points;
		  const width = window.innerWidth;
		  const xs = [width - 8, width - 80, width - 160, width - 260, width - 380, width - 470];
		  const ys = [6, 20, 44];
		  for (const y of ys) {
		    for (const x of xs) {
		      const element = document.elementFromPoint(x, y);
		      if (element === null || element === undefined) continue;
		      const chain = [];
		      let node = element;
		      for (let depth = 0; depth < 8 && node !== null && node !== undefined; depth += 1) {
		        const style = window.getComputedStyle(node);
		        const rect = node.getBoundingClientRect();
		        chain.push({
		          tag: node.tagName.toLowerCase(),
		          cls: typeof node.className === "string" ? node.className.slice(0, 120) : "",
		          bg: style.backgroundColor,
		          rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
		          z: style.zIndex,
		        });
		        node = node.parentElement;
		      }
		      points.push({ x: Math.round(x), y: Math.round(y), chain });
		    }
		  }
		  return points;
		}

		/**
		 * Enter focus mode: hide the shell's columns, promote the panel's chain to a
		 * floating dock, and leave the artwork alone.
		 *
		 * @returns whether the mode ended up on.
		 */
		function enterFocusMode(state) {
		  if (state.focusMode === true) return true;
		  const panel = document.querySelector(".dsh-skins-panel");
		  if (panel === null || panel === undefined) {
		    state.focusNote = "找不到面板元素，无法进入专注模式";
		    publish(state, {});
		    return false;
		  }
		  // Fool-proofing: a stylesheet that hides or freezes the root would make the exit
		  // affordances unusable, so the mode refuses to start instead.
		  const conflicts = rootLayoutConflicts(state.customCss);
		  if (conflicts.length > 0) {
		    state.focusConflicts = conflicts;
		    state.focusNote =
		      "自定义 CSS 里有会隐藏/冻结根布局的规则，已阻止进入专注模式（否则退出按钮会一起消失）：" +
		      conflicts.map((row) => `${row.selector} { ${row.declaration} }`).join("；");
		    publish(state, {});
		    return false;
		  }
		  state.focusConflicts = [];
		  const { targets, lanes } = collectFocusTargets(state, panel);
		  for (const element of targets) element.setAttribute(FOCUS_ATTRIBUTE, "1");
		  for (const element of lanes) element.setAttribute(LANE_ATTRIBUTE, "1");
		  state.focusTargets = targets;
		  state.focusLanes = lanes;
		  state.focusMode = true;
		  // Fullscreen must be requested from the toggle gesture itself, which is where
		  // this runs; the browser hides the native titlebar, the one thing CSS cannot.
		  requestFocusFullscreen(state);
		  // The artwork's stacking must survive the mode untouched; recording it before and
		  // after is what proves it in the report instead of asserting it in a comment.
		  state.layerZIndexBefore = state.layer === null || state.layer === undefined ? null : String(state.layer.style.zIndex ?? "");
		  mountFocusAnchor(state);
		  setFocusFlag(true);
		  state.focusNote =
		    "已隐藏 " + targets.length + " 个外壳元素、把面板提升为悬浮层（" + lanes.length + " 级容器），背景层未受影响" +
		    (document.documentElement.hasAttribute("data-windows-titlebar")
		      ? state.focusFullscreen === true
		        ? "；Windows 标题栏条已透明化，已请求全屏（原生窗口按钮随全屏隐藏）"
		        : "；Windows 标题栏条已透明化，全屏请求被拒绝，原生窗口按钮仍在"
		      : "");
		  document.documentElement.setAttribute("data-dsh-focus", "1");
		  const onKey = (event) => {
		    if (event.key === "Escape") exitFocusMode(state);
		  };
		  document.addEventListener("keydown", onKey, true);
		  state.focusKey = onKey;
		  publish(state, {});
		  // Diagnose the top edge while the mode is on: the probe is what identifies a
		  // leftover band's painter (see `probeTopEdge`), not a guess from a screenshot.
		  // Diagnostics only — a stripped-down environment (tests, an embedded viewer
		  // without `location`) must never break the mode itself.
		  try {
		    state.focusProbe = probeTopEdge();
		    void sendReport(state, clientReport(state, "focus-probe")).catch(() => {});
		    // The fullscreen transition re-renders the shell asynchronously; sample again
		    // once it settles so the diagnostic reflects the state the user actually sees.
		    window.setTimeout(() => {
		      if (state.focusMode !== true || state.disposed === true) return;
		      try {
		        state.focusProbeSettled = probeTopEdge();
		        void sendReport(state, clientReport(state, "focus-probe-settled")).catch(() => {});
		      } catch {
		        /* diagnostics only */
		      }
		    }, 900);
		  } catch {
		    state.focusProbe = null;
		  }
		  return true;
		}

		/** Put every hidden element back. Safe to call when the mode is already off. */
		function exitFocusMode(state) {
		  for (const element of state.focusTargets ?? []) {
		    try {
		      element.removeAttribute(FOCUS_ATTRIBUTE);
		    } catch {
		      /* an element that left the tree with its attribute is already gone */
		    }
		  }
		  for (const element of state.focusLanes ?? []) {
		    try {
		      element.removeAttribute(LANE_ATTRIBUTE);
		    } catch {
		      /* ignore */
		    }
		  }
		  state.focusTargets = [];
		  state.focusLanes = [];
		  state.focusMode = false;
		  state.focusNote = null;
		  // Undo only the fullscreen this mode asked for.
		  releaseFocusFullscreen(state);
		  // Proof, not promise: the layer's inline z-index is compared either side of the
		  // mode and reported, so "the background keeps its stacking" is checkable.
		  state.layerZIndexAfter = state.layer === null || state.layer === undefined ? null : String(state.layer.style.zIndex ?? "");
		  unmountFocusAnchor(state);
		  setFocusFlag(false);
		  document.documentElement.removeAttribute("data-dsh-focus");
		  if (typeof state.focusKey === "function") {
		    document.removeEventListener("keydown", state.focusKey, true);
		    state.focusKey = null;
		  }
		  publish(state, {});
		}

		/** Toggle focus mode; returns whether it ended up on. */
		function toggleFocusMode(state) {
		  if (state.focusMode === true) {
		    exitFocusMode(state);
		    return false;
		  }
		  enterFocusMode(state);
		  return state.focusMode === true;
		}

		/* ---- the global chord ---------------------------------------------------- */

		/**
		 * Whether an event is the focus-mode chord, Ctrl + Shift + Alt + Space.
		 *
		 * `code` decides and `key` only backs it up when there is no code at all: with Alt
		 * and Shift held some layouts report a different `key`, while `code` stays physical.
		 * Meta is required to be *absent* so the macOS Cmd variant cannot fire by accident.
		 */
		function matchesFocusChord(event) {
		  if (event === null || event === undefined) return false;
		  if (event.ctrlKey !== true || event.shiftKey !== true || event.altKey !== true) return false;
		  if (event.metaKey === true) return false;
		  // The physical key decides. Chromium always reports the space bar as "Space"
		  // whatever the layout, so the `key` spelling is only a fallback for an event with
		  // no code at all — which is also why the two are not OR-ed: that would let a
		  // stray `key: " "` turn an unrelated key into this chord.
		  if (event.code === FOCUS_CHORD_CODE) return true;
		  const code = typeof event.code === "string" ? event.code : "";
		  return code.length === 0 && (event.key === " " || event.key === "Spacebar");
		}

		/** Poll for the settings page: it may have to be opened before the mode can start. */
		function waitForPanel(state, attempts) {
		  return new Promise((resolve) => {
		    let left = attempts;
		    const tick = () => {
		      if (state.disposed === true) {
		        resolve(false);
		        return;
		      }
		      if (document.querySelector(".dsh-skins-panel") !== null) {
		        resolve(true);
		        return;
		      }
		      left -= 1;
		      if (left <= 0) {
		        resolve(false);
		        return;
		      }
		      window.setTimeout(tick, 60);
		    };
		    tick();
		  });
		}

		/**
		 * Toggle focus mode from the chord, from anywhere.
		 *
		 * The panel is the only way back out of the mode, so it has to be in the document
		 * first: when the right sidebar is collapsed (or another tab is showing) the
		 * settings page is opened and the mode starts as soon as it exists. If it never
		 * arrives, `enterFocusMode` refuses and explains — hiding the window with no panel
		 * would be the one unrecoverable outcome.
		 *
		 * @returns the mode's state after the attempt.
		 */
		async function toggleFocusFromHotkey(ctx, state) {
		  if (state.focusMode === true) {
		    exitFocusMode(state);
		    return false;
		  }
		  if (document.querySelector(".dsh-skins-panel") === null) {
		    try {
		      const sidebar = typeof ctx?.get === "function" ? ctx.get("sidebarRight") : null;
		      if (sidebar !== null && sidebar !== undefined && typeof sidebar.openTab === "function") sidebar.openTab(TAB_KIND);
		    } catch (error) {
		      state.focusHotkeyNote = "打开背景设置面板失败：" + String(error && error.message ? error.message : error);
		    }
		    await waitForPanel(state, 12);
		  }
		  enterFocusMode(state);
		  return state.focusMode === true;
		}

		/**
		 * Install the global focus-mode chord on `window`.
		 *
		 * `window` in the capture phase is the only seat that sees the chord in every
		 * state — a focused input, a terminal, an open dialog, or the mode itself. Space is
		 * also the page's scroll key *and* the activation key of whatever button holds
		 * focus, so the handler calls `preventDefault()` and `stopPropagation()` before it
		 * does anything else: without the first the page scrolls behind the artwork, and
		 * without the second the chord reaches the application (and the button underneath
		 * the focus ring) as well.
		 *
		 * The application's shortcut registry is used as a **conflict oracle only**: the
		 * chord is registered, the verdict is kept, and the registration is disposed
		 * immediately. Registering it for real would give one chord two owners — the
		 * service and this listener — and two toggles cancel each other out.
		 */
		function installFocusHotkey(ctx, state) {
		  if (typeof state.disposeFocusHotkey === "function") return state.disposeFocusHotkey;
		  const info = {
		    chord: FOCUS_CHORD_LABEL,
		    installed: false,
		    registry: "unknown",
		    conflict: null,
		    hits: 0,
		    lastFire: null,
		    missed: [],
		    note: null,
		  };
		  // Ask the application whether the chord is free. A refusal is reported, never
		  // fatal: the window listener does the work either way.
		  try {
		    const shortcuts = typeof ctx?.get === "function" ? ctx.get("shortcuts") : null;
		    if (shortcuts !== null && shortcuts !== undefined && typeof shortcuts.register === "function") {
		      const defaults = {};
		      for (const profile of SHORTCUT_PROFILES) defaults[profile] = { code: FOCUS_CHORD_CODE, modifiers: ["primary", "shift", "alt"] };
		      const dispose = shortcuts.register({
		        id: PACKAGE_ID + ".focus-mode",
		        label: () => "专注模式（隐藏全部 UI）",
		        aliases: ["focus mode", "zhuanzhu moshi"],
		        defaults,
		        regions: SHORTCUT_REGIONS,
		        modals: [],
		        resolve: () => ({ status: "handled", run: () => {} }),
		      });
		      if (typeof dispose === "function") dispose();
		      info.registry = "accepted";
		      info.note = "应用快捷键服务认为 " + FOCUS_CHORD_LABEL + " 可用（实际由全局监听处理，避免同一组合有两个所有者）";
		    } else {
		      info.registry = "absent";
		      info.note = "没有可用的快捷键服务，仅使用全局监听";
		    }
		  } catch (error) {
		    info.registry = "refused";
		    info.conflict = String(error && error.message ? error.message : error);
		    info.note = "快捷键服务拒绝了 " + FOCUS_CHORD_LABEL + "：" + info.conflict + "。全局监听仍然有效；若按下无反应，说明该组合被系统或其他软件占用，可改用别的组合。";
		    console.warn("[dsh-skins] the shortcut registry refused " + FOCUS_CHORD_LABEL, error);
		  }

		  const listener = (event) => {
		    if (matchesFocusChord(event) !== true) {
		      // Near-miss bookkeeping: if the chord never arrives at all, the page cannot
		      // see the key press, which is what a system-level grab looks like.
		      if (event.ctrlKey === true && event.shiftKey === true && event.altKey === true && typeof event.code === "string" && event.code.length > 0) {
		        info.missed = info.missed.concat(event.code).slice(-4);
		        state.focusHotkey = Object.assign({}, info);
		      }
		      return;
		    }
		    // Space is the scroll key and the activate key: take it before anything else,
		    // and do not let it reach the application's own handlers.
		    event.preventDefault();
		    event.stopPropagation();
		    if (event.repeat === true) return;
		    info.hits += 1;
		    info.lastFire = new Date().toISOString();
		    state.focusHotkey = Object.assign({}, info);
		    Promise.resolve()
		      .then(() => toggleFocusFromHotkey(ctx, state))
		      .catch((error) => {
		        state.focusHotkey = Object.assign({}, info, { note: "切换专注模式失败：" + String(error && error.message ? error.message : error) });
		        publish(state, {});
		      });
		  };
		  try {
		    window.addEventListener("keydown", listener, true);
		    info.installed = true;
		    // The listener is on `window` (capture), so it runs before anything the page or
		    // a focused control could do with the key.
		    info.note = info.note ?? "全局监听已安装（window / capture）";
		  } catch (error) {
		    info.installed = false;
		    info.note = "无法安装全局键盘监听：" + String(error && error.message ? error.message : error);
		    console.warn("[dsh-skins] could not install the global focus-mode hotkey", error);
		  }
		  state.focusHotkey = Object.assign({}, info);
		  const dispose = () => {
		    try {
		      window.removeEventListener("keydown", listener, true);
		    } catch {
		      /* ignore */
		    }
		    state.disposeFocusHotkey = null;
		  };
		  state.disposeFocusHotkey = dispose;
		  publish(state, {});
		  return dispose;
		}

		/**
		 * Draw the frame the user is looking at into a canvas at viewport size.
		 *
		 * The media is laid out with `object-fit: cover`, so the same cover geometry is
		 * applied here; the layer's CSS filters are replayed through `context.filter`
		 * (canvas supports the filter functions, not the SVG posterize reference) and the
		 * scrim gradient is painted on top, because those are exactly what changes the
		 * pixel the user is pointing at.
		 *
		 * @returns `{ canvas, context, width, height }`, or null when there is nothing to read.
		 */
		function drawFrameForPicking(state) {
		  const media = state.video !== null && state.video !== undefined && state.video.readyState >= 2 ? state.video : state.poster;
		  if (media === null || media === undefined) return null;
		  const width = Math.max(1, Math.round(window.innerWidth || 1280));
		  const height = Math.max(1, Math.round(window.innerHeight || 720));
		  const canvas = document.createElement("canvas");
		  canvas.width = width;
		  canvas.height = height;
		  const context = canvas.getContext("2d", { willReadFrequently: true });
		  if (context === null || context === undefined) return null;
		  const mediaWidth = Number(media.naturalWidth ?? media.videoWidth ?? 0) || width;
		  const mediaHeight = Number(media.naturalHeight ?? media.videoHeight ?? 0) || height;
		  const slider = tweakSliders(state, state.skinId);
		  const parts = [];
		  if (slider.blur > 0) parts.push("blur(" + slider.blur + "px)");
		  if (slider.grayscale > 0) parts.push("grayscale(" + slider.grayscale + "%)");
		  if (slider.saturate !== 100) parts.push("saturate(" + slider.saturate + "%)");
		  if (slider.contrast !== 100) parts.push("contrast(" + slider.contrast + "%)");
		  try {
		    context.filter = parts.length === 0 ? "none" : parts.join(" ");
		  } catch {
		    /* an engine without canvas filters still gets the geometry right */
		  }
		  try {
		    const scale = Math.max(width / mediaWidth, height / mediaHeight);
		    context.drawImage(media, (width - mediaWidth * scale) / 2, (height - mediaHeight * scale) / 2, mediaWidth * scale, mediaHeight * scale);
		  } catch (error) {
		    state.pickNote = "无法绘制当前画面：" + String(error && error.message ? error.message : error);
		    return null;
		  } finally {
		    try {
		      context.filter = "none";
		    } catch {
		      /* ignore */
		    }
		  }
		  const veil = tweaksFor(state, state.skinId).veil;
		  const gradient = context.createLinearGradient(0, 0, 0, height);
		  const stop = (offset, alpha) => gradient.addColorStop(offset, "rgba(0,0,0," + (alpha * veil).toFixed(3) + ")");
		  stop(0, 0.34);
		  stop(0.3, 0.08);
		  stop(0.62, 0.08);
		  stop(1, 0.4);
		  context.fillStyle = gradient;
		  context.fillRect(0, 0, width, height);
		  return { canvas, context, width, height, media: { width: mediaWidth, height: mediaHeight } };
		}

		/** The colour under one viewport point, or null when the canvas refuses. */
		function readPickPixel(state, context, clientX, clientY) {
		  try {
		    const data = context.getImageData(Math.round(clientX), Math.round(clientY), 1, 1).data;
		    return toHex(data[0], data[1], data[2]);
		  } catch (error) {
		    // A cross-origin frame would taint the canvas; the media is served from the
		    // app's own origin, but a refused read must degrade instead of throwing.
		    state.pickNote = "读不到画布像素：" + String(error && error.message ? error.message : error);
		    return null;
		  }
		}

		/**
		 * Open the eyedropper overlay.
		 *
		 * A plain DOM overlay rather than a React one: it has to sit above every column
		 * (including the ones focus mode hides) for exactly one gesture, and it has to be
		 * removable from the teardown path without a component tree.
		 */
		function startPicker(state, onPick) {
		  if (state.picker !== null && state.picker !== undefined) return;
		  const frame = drawFrameForPicking(state);
		  if (frame === null) {
		    publish(state, {});
		    return;
		  }
		  const overlay = document.createElement("div");
		  overlay.setAttribute(PICK_ATTRIBUTE, "1");
		  overlay.style.cssText = "position:fixed;inset:0;z-index:2147483646;cursor:crosshair;background:transparent";
		  const swatch = document.createElement("div");
		  swatch.style.cssText =
		    "position:fixed;pointer-events:none;z-index:2147483647;width:78px;padding:4px 6px;border-radius:6px;font:11px/1.3 ui-monospace,Consolas,monospace;color:#fff;background:rgba(0,0,0,0.72);border:1px solid rgba(255,255,255,0.28)";
		  const chip = document.createElement("span");
		  chip.style.cssText = "display:block;height:14px;border-radius:3px;margin-bottom:3px;background:#000";
		  const label = document.createElement("span");
		  label.textContent = "—";
		  swatch.append(chip, label);
		  const hint = document.createElement("div");
		  hint.textContent = "点击背景取色 · Esc 取消";
		  hint.style.cssText =
		    "position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:2147483647;pointer-events:none;font:12px/1.4 'Segoe UI',system-ui,sans-serif;color:#fff;background:rgba(0,0,0,0.72);border:1px solid rgba(255,255,255,0.28);border-radius:9999px;padding:4px 12px";
		  const onMove = (event) => {
		    const hex = readPickPixel(state, frame.context, event.clientX, event.clientY);
		    if (hex === null) return;
		    chip.style.background = hex;
		    label.textContent = hex;
		    swatch.style.left = Math.min((window.innerWidth || 1280) - 90, event.clientX + 14) + "px";
		    swatch.style.top = Math.min((window.innerHeight || 720) - 52, event.clientY + 14) + "px";
		  };
		  const onKey = (event) => {
		    if (event.key === "Escape") stopPicker(state);
		  };
		  const onClick = (event) => {
		    event.preventDefault();
		    event.stopPropagation();
		    const hex = readPickPixel(state, frame.context, event.clientX, event.clientY);
		    stopPicker(state);
		    if (hex !== null) onPick(hex);
		  };
		  overlay.addEventListener("pointermove", onMove);
		  overlay.addEventListener("click", onClick, true);
		  document.addEventListener("keydown", onKey, true);
		  (document.body ?? document.documentElement).append(overlay, swatch, hint);
		  state.picker = { overlay, swatch, hint, onKey, onMove, onClick };
		  state.pickNote = null;
		  publish(state, {});
		}

		/** Close the overlay and release its listeners. Safe when nothing is open. */
		function stopPicker(state) {
		  const picker = state.picker;
		  if (picker === null || picker === undefined) return;
		  document.removeEventListener("keydown", picker.onKey, true);
		  try {
		    picker.overlay.removeEventListener("pointermove", picker.onMove);
		    picker.overlay.removeEventListener("click", picker.onClick, true);
		  } catch {
		    /* ignore */
		  }
		  for (const node of [picker.overlay, picker.swatch, picker.hint]) {
		    try {
		      node.remove();
		    } catch {
		      /* already detached */
		    }
		  }
		  state.picker = null;
		  publish(state, {});
		}

		/**
		 * Move a picked colour onto the accent while keeping it readable.
		 *
		 * A picked pixel is whatever the user pointed at, and a mid-tone usually cannot
		 * carry either white or black text. So hue and saturation are kept and the
		 * lightness is searched — in both directions, because the feasible window sits on
		 * opposite sides of the surface depending on the panel — for one that clears the
		 * graphic and text floors. `shifted` reports whether the result differs, and the
		 * panel prints the final colour, so nothing changes silently.
		 */
		function adjustAccentForSurface(hex, surfaceHex, options) {
		  const opts = Object.assign({ graphicFloor: 3, textFloor: 4.5 }, options ?? {});
		  const hsl = rgbToHsl(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
		  const measure = (color) => {
		    const against = contrastRatio(color, surfaceHex);
		    const darkInk = contrastRatio(INK_ON_ACCENT, color);
		    const lightInk = contrastRatio(LABEL_ON_ACCENT_LIGHT, color);
		    const ink = darkInk >= lightInk ? INK_ON_ACCENT : LABEL_ON_ACCENT_LIGHT;
		    const inkRatio = Math.max(darkInk, lightInk);
		    return { color, ink, ratio: inkRatio, inkRatio, against, ok: against >= opts.graphicFloor && inkRatio >= opts.textFloor };
		  };
		  const direct = measure(hex);
		  if (direct.ok) return Object.assign(direct, { shifted: false, from: hex, hue: hsl.h, saturation: hsl.s, lightness: hsl.l });
		  let best = Object.assign(direct, { lightness: hsl.l });
		  let bestScore = Math.min(direct.against / opts.graphicFloor, direct.inkRatio / opts.textFloor);
		  for (let step = 1; step <= 60; step += 1) {
		    for (const direction of [1, -1]) {
		      const lightness = clamp(hsl.l + direction * step * 0.014, 0.02, 0.98);
		      const candidate = measure(hslToHex(hsl.h, hsl.s, lightness));
		      if (candidate.ok) return Object.assign(candidate, { shifted: true, from: hex, hue: hsl.h, saturation: hsl.s, lightness });
		      const score = Math.min(candidate.against / opts.graphicFloor, candidate.inkRatio / opts.textFloor);
		      if (score > bestScore) {
		        bestScore = score;
		        best = Object.assign(candidate, { lightness });
		      }
		    }
		  }
		  return Object.assign(best, { shifted: true, from: hex, hue: hsl.h, saturation: hsl.s, approximate: true });
		}

		/** The base token map with the accent family replaced by a picked colour. */
		function withAccentTokens(base, accent) {
		  const next = Object.assign({}, base);
		  const pair = (value) => ({ light: value, dark: value });
		  for (const key of ACCENT_TOKENS) next[key] = pair(accent.color);
		  next["--dsw-alias-label-primary-foreground"] = pair(accent.ink);
		  next["--dsw-alias-interactive-bg-hover"] = pair(rgbaOf(accent.color, 0.14));
		  const lightness = accent.lightness ?? 0.5;
		  next["--dsw-alias-button-primary-hover"] = pair(hslToHex(accent.hue ?? 0, accent.saturation ?? 0.5, clamp(lightness + (lightness > 0.5 ? 0.08 : -0.06), 0.05, 0.95)));
		  return next;
		}

		/**
		 * Apply one picked colour as the global UI accent.
		 *
		 * The surface it is judged against comes from the live measurement of the frame —
		 * the same blend of panel and artwork the ladder uses — so a picked accent is
		 * corrected against what the UI actually draws on rather than a guess.
		 */
		function setAccentOverride(ctx, state, hex) {
		  let surface = state.liveTokens?.surface ?? state.livePreview?.surface ?? null;
		  let surfaceNote = "画布实测";
		  if (surface === null || surface === undefined) {
		    try {
		      const measured = measureDisplayed(state, tweakSliders(state, state.skinId));
		      if (measured !== null) surface = deriveLiveTokens(measured, {}).surface;
		    } catch {
		      surface = null;
		    }
		  }
		  if (surface === null || surface === undefined) {
		    surface = "#111013";
		    surfaceNote = "未能采样画面，按深色面板估算";
		  }
		  const accent = adjustAccentForSurface(hex, surface, {});
		  state.accentOverride = Object.assign({}, accent, { picked: hex, surface, surfaceNote, at: new Date().toISOString() });
		  applyTokenLayer(ctx, state);
		  publish(state, {});
		  return state.accentOverride;
		}

		/** Drop the picked accent and go back to the skin's or the live palette. */
		function clearAccentOverride(ctx, state) {
		  state.accentOverride = null;
		  applyTokenLayer(ctx, state);
		  publish(state, {});
		}

		/**
		 * Remove anything the developer options could have left behind in the document.
		 *
		 * Every mark is an attribute plus transient nodes, so a plugin reload can put the
		 * document back to a clean state without touching DSH's own markup. This runs at
		 * mount because a client rebuild remounts the plugin while the DOM survives.
		 *
		 * @returns whether a focus mode from a previous run was found and cleared.
		 */
		function sweepStrandedUi() {
		  let stranded = false;
		  try {
		    for (const node of Array.from(document.querySelectorAll("[" + FOCUS_ATTRIBUTE + "]"))) {
		      node.removeAttribute(FOCUS_ATTRIBUTE);
		      stranded = true;
		    }
		    for (const node of Array.from(document.querySelectorAll("[" + LANE_ATTRIBUTE + "]"))) {
		      node.removeAttribute(LANE_ATTRIBUTE);
		      stranded = true;
		    }
		    for (const node of Array.from(document.querySelectorAll("[" + ANCHOR_ATTRIBUTE + "]"))) {
		      node.remove();
		      stranded = true;
		    }
		    // The library's floating pieces: a context menu or a confirmation dialog left
		    // behind by a reload would sit above everything with nothing to close it.
		    for (const node of Array.from(document.querySelectorAll("[" + SKIN_MENU_ATTRIBUTE + "], [" + SKIN_DIALOG_ATTRIBUTE + "]"))) {
		      node.remove();
		      stranded = true;
		    }
		    document.documentElement.removeAttribute("data-dsh-dragging");
		    for (const node of Array.from(document.querySelectorAll("[" + PICK_ATTRIBUTE + "]"))) node.remove();
		    document.documentElement.removeAttribute("data-dsh-focus");
		  } catch {
		    /* ignore */
		  }
		  return stranded;
		}

		/**
		 * Recover from a session that ended inside focus mode.
		 *
		 * Detection is a flag written on entry and cleared on exit, so the only way to see
		 * it at boot is a window that was closed (or crashed) while the UI was hidden. The
		 * mode is never resumed automatically: the flag is cleared, every stranded mark is
		 * swept, and the panel is left in the default state, because coming up half hidden
		 * with no way back is the one failure this feature must not have.
		 *
		 * @returns whether a recovery happened.
		 */
		function recoverFocus(state) {
		  let flagged = false;
		  try {
		    flagged = window.localStorage.getItem(FOCUS_FLAG_KEY) === "1";
		    window.localStorage.removeItem(FOCUS_FLAG_KEY);
		  } catch {
		    flagged = false;
		  }
		  const swept = sweepStrandedUi();
		  state.focusMode = false;
		  state.focusTargets = [];
		  state.focusLanes = [];
		  state.focusAnchor = null;
		  state.focusRecovered = flagged || swept;
		  state.focusNote = state.focusRecovered === true ? "上次退出时专注模式还开着，已自动重置为默认模式（不会自动恢复）" : null;
		  return state.focusRecovered;
		}

		/** A one-line description of a DOM node, for the diagnostics report. */
		function describeNode(node) {
		  if (node === null || node === undefined) return "none";
		  const tag = String(node.tagName ?? "?").toLowerCase();
		  const id = typeof node.id === "string" && node.id.length > 0 ? "#" + node.id : "";
		  const classes = typeof node.className === "string" ? node.className.trim().split(/\s+/u).filter((one) => one.length > 0) : [];
		  return tag + id + (classes.length === 0 ? "" : "." + classes.slice(0, 2).join("."));
		}

		/**
		 * What focus mode would do to the document *right now*, without doing it.
		 *
		 * This exists because the first version of the mode was wrong about the real DOM
		 * (the artwork layer turned out to be a child of `<body>`, so it was hidden along
		 * with the columns). The plan is reported on every diagnostic write, so the real
		 * tree can be read from a file instead of being assumed.
		 */
		function focusPlanFor(state) {
		  const panel = typeof document.querySelector === "function" ? document.querySelector(".dsh-skins-panel") : null;
		  if (panel === null || panel === undefined) return { available: false, reason: "panel-not-mounted" };
		  try {
		    const plan = collectFocusTargets(state, panel);
		    return {
		      available: true,
		      hide: plan.targets.map(describeNode),
		      lanes: plan.lanes.map(describeNode),
		      // The one invariant this fix exists for, answered on the real tree rather
		      // than argued in a comment.
		      layerHidden: state.layer === null || state.layer === undefined ? null : plan.targets.includes(state.layer),
		      layer: state.layer === null || state.layer === undefined ? null : { at: describeNode(state.layer), parent: describeNode(state.layer.parentElement), zIndex: String(state.layer.style.zIndex ?? "") },
		      conflicts: rootLayoutConflicts(state.customCss).length,
		      // The two levels that matter for "is anything left visible": what lives beside
		      // the app root, and what lives inside it.
		      bodyChildren: Array.from(document.body?.children ?? []).map(describeNode),
		      rootChildren: Array.from(document.getElementById("root")?.children ?? []).map(describeNode),
		    };
		  } catch (error) {
		    return { available: false, reason: String(error && error.message ? error.message : error) };
		  }
		}

		/* ------------------------------------------------------------------ *
		 * Library management: order, deletion, context menu, batch mode
		 * ------------------------------------------------------------------ */

		/** Marks for the plugin-owned floating pieces, so a reload can sweep them. */
		const SKIN_MENU_ATTRIBUTE = "data-dsh-skin-menu";
		const SKIN_DIALOG_ATTRIBUTE = "data-dsh-skin-dialog";
		const SKIN_CARD_ATTRIBUTE = "data-skin-card";
		/** How far the pointer must travel before a press becomes a drag. */
		const DRAG_THRESHOLD_PX = 5;

		/** A localStorage mirror, so the order is right even before the host answers. */
		function readPrefsCache() {
		  const empty = { version: 1, order: [], favorites: [], hidden: [], tags: {} };
		  try {
		    const raw = window.localStorage.getItem(PREFS_CACHE_KEY);
		    if (raw === null) return empty;
		    const parsed = JSON.parse(raw);
		    return parsed !== null && typeof parsed === "object" ? Object.assign(empty, parsed) : empty;
		  } catch {
		    return empty;
		  }
		}

		function writePrefsCache(preferences) {
		  try {
		    window.localStorage.setItem(PREFS_CACHE_KEY, JSON.stringify(preferences));
		  } catch {
		    /* ignore */
		  }
		}

		/**
		 * Read the preferences the host keeps on disk.
		 *
		 * Order and custom tags only exist on disk (that is the point of the file), while
		 * favourites predate it and live in localStorage — so the two are unioned once on
		 * load and the union is written back. Nothing starred in an older version is lost.
		 */
		async function loadPreferences(state) {
		  state.preferences = readPrefsCache();
		  try {
		    const response = await fetch(PREFS_URL, { credentials: "same-origin" });
		    const payload = await response.json();
		    if (payload.ok !== true || payload.preferences === undefined) {
		      state.preferencesNote = "宿主没有提供偏好接口（还是旧模块？），本次只使用本地缓存";
		      return;
		    }
		    state.preferences = payload.preferences;
		    state.preferencesFile = payload.file ?? null;
		    writePrefsCache(payload.preferences);
		    const local = Array.isArray(state.favorites) ? state.favorites : [];
		    const stored = Array.isArray(payload.preferences.favorites) ? payload.preferences.favorites : [];
		    const union = Array.from(new Set([...stored, ...local]));
		    state.favorites = union;
		    writeFavorites(union);
		    if (union.length !== stored.length) await savePreferences(state, { favorites: union });
		    state.preferencesNote = null;
		  } catch (error) {
		    state.preferencesNote = "读取偏好失败，已回退到本地缓存：" + String(error && error.message ? error.message : error);
		  }
		}

		/**
		 * Persist a patch of the preferences.
		 *
		 * Partial by design: the panel saves the order, the favourites and the tags
		 * independently and the host merges field by field, so saving one can never erase
		 * another. The local mirror is written first, so the UI survives a failed POST.
		 */
		async function savePreferences(state, patch) {
		  const next = Object.assign({ version: 1, order: [], favorites: [], hidden: [], tags: {} }, state.preferences ?? {}, patch);
		  state.preferences = next;
		  state.preferencesSavedAt = new Date().toISOString();
		  writePrefsCache(next);
		  publish(state, {});
		  try {
		    const response = await fetch(PREFS_URL, {
		      method: "POST",
		      credentials: "same-origin",
		      headers: { "content-type": "application/json" },
		      body: JSON.stringify(patch),
		    });
		    const payload = await response.json();
		    if (payload.ok === true) {
		      state.preferences = payload.preferences;
		      state.preferencesFile = payload.file ?? state.preferencesFile;
		      writePrefsCache(payload.preferences);
		      state.preferencesNote = null;
		    } else {
		      state.preferencesNote = "偏好保存被拒绝：" + String(payload.error ?? "unknown");
		    }
		  } catch (error) {
		    state.preferencesNote = "偏好保存失败（本地缓存仍在）：" + String(error && error.message ? error.message : error);
		  }
		  publish(state, {});
		  return state.preferences;
		}

		/**
		 * The library order: what the file names, in the file's order, then anything the
		 * file has never seen in catalog order. New uploads land at the end instead of
		 * being shuffled into the middle.
		 */
		function orderedSkins(state, skins) {
		  const order = state.preferences?.order ?? [];
		  if (order.length === 0) return skins;
		  const rank = new Map(order.map((skinId, index) => [skinId, index]));
		  return skins
		    .map((skin, index) => ({ skin, index, rank: rank.has(skin.skinId) ? rank.get(skin.skinId) : Number.MAX_SAFE_INTEGER }))
		    .sort((left, right) => (left.rank === right.rank ? left.index - right.index : left.rank - right.rank))
		    .map((row) => row.skin);
		}

		/** Move one id in front of another inside a global order. Pure, so it is testable. */
		function reorderIds(globalOrder, skinId, beforeId) {
		  const next = globalOrder.filter((id) => id !== skinId);
		  if (beforeId === null || beforeId === undefined) {
		    next.push(skinId);
		    return next;
		  }
		  const at = next.indexOf(beforeId);
		  next.splice(at < 0 ? next.length : at, 0, skinId);
		  return next;
		}

		/**
		 * Which slot a pointer is over, from the rendered card rectangles.
		 *
		 * Pure on purpose: it takes rectangles instead of reading the DOM, so the drop
		 * decision is testable. The answer is "how many cards come before the pointer", which
		 * handles both axes without needing to detect rows: a card counts as before the
		 * pointer when the pointer is below its vertical middle, or — for a card whose
		 * vertical band contains the pointer — when it is past that card's horizontal middle.
		 * (Two earlier versions got this wrong: one ignored the horizontal axis entirely, the
		 * next lost the row when the pointer sat between two rows.)
		 */
		function dropIndexFromPoint(rects, x, y) {
		  let before = 0;
		  for (const rect of rects) {
		    const centreX = rect.left + rect.width / 2;
		    const centreY = rect.top + rect.height / 2;
		    const inBand = y >= rect.top && y <= rect.top + rect.height;
		    if (y > centreY || (inBand && x > centreX)) before += 1;
		  }
		  return before;
		}

		/**
		 * Whether a drag actually carries files.
		 *
		 * `DataTransfer.types` reports **lowercase** names in Chromium (`["files"]`), so the
		 * old exact-string comparison against `"Files"` never matched — which also meant the
		 * zone could not tell a file drag from an internal one. Case-insensitive now, and an
		 * internal sort drag is rejected outright.
		 */
		function dragCarriesFiles(event) {
		  if (event === null || event === undefined) return false;
		  if (typeof document !== "undefined" && document.documentElement.hasAttribute("data-dsh-dragging")) return false;
		  const transfer = event.dataTransfer;
		  if (transfer === null || transfer === undefined) return false;
		  const types = transfer.types;
		  if (types === null || types === undefined) return false;
		  const list = Array.prototype.slice.call(types);
		  return list.some((one) => typeof one === "string" && one.toLowerCase() === "files");
		}

		/** Append a line to the panel's bottom log area. */
		function logOperation(state, kind, message) {
		  const entry = { at: new Date().toISOString(), kind, message };
		  state.opLog = [entry].concat(state.opLog ?? []).slice(0, 80);
		  publish(state, {});
		  return entry;
		}

		/* ---- drag to reorder ------------------------------------------------------ */

		/** The rendered cards, in document order, with their rectangles. */
		function cardRects() {
		  return Array.from(document.querySelectorAll("[" + SKIN_CARD_ATTRIBUTE + "]")).map((node) => {
		    const rect = typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : { top: 0, left: 0, width: 0, height: 0 };
		    return { node, skinId: node.getAttribute(SKIN_CARD_ATTRIBUTE), top: rect.top, left: rect.left, width: rect.width, height: rect.height };
		  });
		}

		/** Start watching a press: it may become a drag, or stay a click. */
		function beginCardPress(state, skinId, event) {
		  if (state.batch?.active === true) return;
		  if (event?.button !== undefined && event.button !== 0) return;
		  state.cardPress = { skinId, x: event?.clientX ?? 0, y: event?.clientY ?? 0, moved: false };
		}

		/** Promote a press to a drag once the pointer has travelled far enough. */
		function trackCardPress(state, event) {
		  const press = state.cardPress;
		  if (press === null || press === undefined) return;
		  if (press.moved !== true) {
		    const distance = Math.abs((event?.clientX ?? 0) - press.x) + Math.abs((event?.clientY ?? 0) - press.y);
		    if (distance < DRAG_THRESHOLD_PX) return;
		    const rects = cardRects();
		    state.drag = { skinId: press.skinId, order: rects.map((row) => row.skinId), over: rects.findIndex((row) => row.skinId === press.skinId), x: event?.clientX ?? 0, y: event?.clientY ?? 0 };
		    press.moved = true;
		    document.documentElement.setAttribute("data-dsh-dragging", "1");
		    publish(state, {});
		    return;
		  }
		  const active = state.drag;
		  if (active === null || active === undefined) return;
		  const rects = cardRects();
		  state.drag = Object.assign({}, active, { over: dropIndexFromPoint(rects, event?.clientX ?? 0, event?.clientY ?? 0), x: event?.clientX ?? 0, y: event?.clientY ?? 0 });
		  publish(state, {});
		}

		/** Finish a press: either a click (nothing to do) or a drag to commit. */
		async function finishCardPress(ctx, state, event) {
		  state.cardPress = null;
		  const active = state.drag;
		  if (active === null || active === undefined) return;
		  const rects = cardRects();
		  // The slot is "in front of the card that occupies it"; at the end there is no such
		  // card, which is what `null` means.
		  const over = dropIndexFromPoint(rects, event?.clientX ?? active.x, event?.clientY ?? active.y);
		  const before = rects[over]?.skinId ?? null;
		  const visible = rects.map((row) => row.skinId);
		  state.drag = null;
		  document.documentElement.removeAttribute("data-dsh-dragging");
		  if (active.skinId === before || visible[over - 1] === active.skinId) {
		    publish(state, {});
		    return;
		  }
		  // Reorder inside the *global* order, so a filtered view still produces a sensible
		  // result: the card lands in front of whatever it was dropped in front of.
		  const global = orderedSkins(state, state.catalog.skins).map((skin) => skin.skinId);
		  const next = reorderIds(global, active.skinId, before);
		  if ((state.preferences?.order ?? []).join("\n") === next.join("\n")) {
		    publish(state, {});
		    return;
		  }
		  logOperation(state, "order", "顺序已更新（" + next.length + " 套），正在保存…");
		  const saved = await savePreferences(state, { order: next });
		  logOperation(state, "order", "顺序已保存到 " + (state.preferencesFile ?? "偏好文件") + "（" + (saved.order?.length ?? next.length) + " 套）");
		  void ctx;
		}

		/** Drop a pending press or an in-flight drag. Safe when there is neither. */
		function cancelDrag(state) {
		  state.cardPress = null;
		  if (state.drag === null || state.drag === undefined) return;
		  state.drag = null;
		  document.documentElement.removeAttribute("data-dsh-dragging");
		  publish(state, {});
		}

		/* ---- the card context menu ------------------------------------------------ */

		function closeSkinMenu(state) {
		  const open = state.skinMenu;
		  if (open === null || open === undefined) return;
		  try {
		    document.removeEventListener("pointerdown", open.onOutside, true);
		    document.removeEventListener("keydown", open.onKey, true);
		    open.menu.remove();
		  } catch {
		    /* already detached */
		  }
		  state.skinMenu = null;
		  publish(state, {});
		}

		/**
		 * A themed menu button; `danger` marks the destructive entry.
		 *
		 * The action fires from `pointerup` **and** from `click`, whichever arrives first,
		 * guarded so it can only run once. That is the fix for the reported "clicking does
		 * nothing": the shell's own overlay layers sit above a plain body-level menu, so the
		 * press landed on a foreign element — my document-level outside-close then treated it
		 * as a click outside and removed the menu before any `click` could reach the button.
		 * Acting on `pointerup` (which the item still receives once it is on top) plus
		 * stopping propagation on every press inside the menu makes the item work even when
		 * the trailing `click` is lost.
		 */
		function menuItem(state, menu, label, handler, options) {
		  const button = document.createElement("button");
		  button.type = "button";
		  button.setAttribute("role", "menuitem");
		  button.textContent = label;
		  button.style.cssText =
		    "display:block;width:100%;box-sizing:border-box;text-align:left;padding:6px 10px;border:0;border-radius:6px;background:transparent;font:inherit;cursor:pointer;color:" +
		    (options?.danger === true ? "#ff8a8a" : "inherit");
		  let done = false;
		  const run = (event) => {
		    if (event !== null && event !== undefined) {
		      event.preventDefault();
		      event.stopPropagation();
		    }
		    if (done === true) return;
		    done = true;
		    closeSkinMenu(state);
		    handler();
		  };
		  // Every press inside the menu belongs to the menu: nothing may bubble out to a
		  // handler that would close it before the action runs.
		  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
		    button.addEventListener(type, (event) => {
		      event.stopPropagation();
		      if (type === "pointerup" || type === "click") run(event);
		    });
		  }
		  button.addEventListener("mouseenter", () => {
		    button.style.background = options?.danger === true ? "rgba(255,90,90,0.16)" : "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.09))";
		  });
		  button.addEventListener("mouseleave", () => {
		    button.style.background = "transparent";
		  });
		  menu.append(button);
		  return button;
		}

		/**
		 * The per-skin context menu, as a plugin-owned fixed element.
		 *
		 * Fixed and appended to `<body>` rather than rendered inside the panel: the panel
		 * lives in a scrolling column, so a menu for a card near the bottom would be clipped
		 * by it. Colours come from the same `--dsw-*` tokens the panel uses, so the menu
		 * follows the active theme (and a picked accent) instead of guessing at them.
		 */
		function openSkinMenu(ctx, state, skin, clientX, clientY) {
		  closeSkinMenu(state);
		  const menu = document.createElement("div");
		  menu.setAttribute(SKIN_MENU_ATTRIBUTE, "1");
		  menu.setAttribute("role", "menu");
		  menu.style.cssText =
		    "position:fixed;z-index:2147483640;pointer-events:auto;min-width:176px;padding:4px;box-sizing:border-box;border-radius:10px;" +
		    "background:color-mix(in srgb, var(--dsw-alias-bg-layer-1, #1b1b1f) 94%, transparent);" +
		    "border:1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.14));box-shadow:0 14px 34px rgba(0,0,0,0.5);" +
		    "font:13px/1.45 'Segoe UI',system-ui,sans-serif;color:var(--dsw-alias-label-primary, #ededf0);backdrop-filter:blur(10px)";
		  const heading = document.createElement("div");
		  heading.textContent = skinLabel(skin);
		  heading.style.cssText =
		    "padding:4px 10px 6px;font-size:11px;color:var(--dsw-alias-label-secondary, #9a9aa2);border-bottom:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.07));margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:230px";
		  menu.append(heading);
		  // Every entry writes to the panel's log, so a click that *did* work is visible
		  // even when its effect is subtle (applying a skin changes the whole window).
		  menuItem(state, menu, "应用皮肤", () => {
		    logOperation(state, "apply", "应用皮肤：" + skinLabel(skin));
		    void applyById(ctx, state, skin.skinId);
		  });
		  menuItem(state, menu, "导出皮肤包", () => {
		    logOperation(state, "export", "导出皮肤包：" + skinLabel(skin));
		    void exportSkin(state, skin.skinId);
		  });
		  menuItem(state, menu, (state.favorites ?? []).includes(skin.skinId) ? "取消收藏" : "加入收藏", () => {
		    const wasFavorite = (state.favorites ?? []).includes(skin.skinId);
		    toggleFavorite(state, skin.skinId);
		    logOperation(state, "favorite", (wasFavorite ? "已取消收藏：" : "已加入收藏：") + skinLabel(skin));
		  });
		  menuItem(state, menu, "编辑标签…", () => openTagEditor(state, skin, menu));
		  menuItem(state, menu, "删除皮肤", () => void confirmDeleteSkins(ctx, state, [skin.skinId]), { danger: true });

		  const width = 190;
		  const height = 220;
		  menu.style.left = Math.max(8, Math.min(clientX, (window.innerWidth || 1280) - width - 8)) + "px";
		  menu.style.top = Math.max(8, Math.min(clientY, (window.innerHeight || 720) - height - 8)) + "px";
		  const onOutside = (event) => {
		    // A press can be retargeted (a shell layer above the menu), so the whole path is
		    // consulted, not just `event.target`; and the menu ignores presses for a moment
		    // after opening, so the gesture that opened it can never close it.
		    if (Date.now() - openedAt < 150) return;
		    const path = typeof event.composedPath === "function" ? event.composedPath() : null;
		    if (path !== null && path.includes(menu)) return;
		    if (menu.contains(event.target) === true) return;
		    closeSkinMenu(state);
		  };
		  const onKey = (event) => {
		    if (event.key === "Escape") closeSkinMenu(state);
		  };
		  const openedAt = Date.now();
		  (document.body ?? document.documentElement).append(menu);
		  // Proven, not assumed: what the browser actually reports under the menu's own
		  // centre. If a shell layer is above it, the report names that layer.
		  let hit = null;
		  try {
		    if (typeof document.elementFromPoint === "function") {
		      const box = typeof menu.getBoundingClientRect === "function" ? menu.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
		      const node = document.elementFromPoint(box.left + Math.min(20, box.width / 2), box.top + 12);
		      hit = node === null || node === undefined ? null : { at: describeNode(node), inside: menu.contains(node) === true };
		    }
		  } catch {
		    hit = null;
		  }
		  // Registered a tick later: the same gesture that opened the menu cannot close it,
		  // and a lost `click` cannot cost the listener.
		  const attach = () => {
		    if (state.skinMenu === null || state.skinMenu === undefined || state.skinMenu.menu !== menu) return;
		    document.addEventListener("pointerdown", onOutside, true);
		    document.addEventListener("keydown", onKey, true);
		  };
		  if (typeof window.setTimeout === "function") window.setTimeout(attach, 0);
		  else attach();
		  state.skinMenu = { menu, onOutside, onKey, skinId: skin.skinId, hit, openedAt };
		  publish(state, {});
		  return menu;
		}

		/** Swap the menu body for a small tag editor, so no native dialog is needed. */
		function openTagEditor(state, skin, menu) {
		  const current = (state.preferences?.tags ?? {})[skin.skinId] ?? [];
		  while (menu.firstChild !== null) menu.removeChild(menu.firstChild);
		  const label = document.createElement("div");
		  label.textContent = "自定义标签（逗号分隔）";
		  label.style.cssText =
		    "padding:4px 10px 6px;font-size:11px;color:var(--dsw-alias-label-secondary, #9a9aa2);border-bottom:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.07));margin-bottom:4px";
		  const input = document.createElement("input");
		  input.type = "text";
		  input.value = current.join(", ");
		  input.placeholder = "例如：夜景, 冷色";
		  input.style.cssText =
		    "display:block;width:calc(100% - 12px);margin:2px 6px 6px;box-sizing:border-box;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.14));background:var(--dsw-alias-bg-layer-1, #1b1b1f);color:inherit;font:12px/1.4 inherit";
		  const save = document.createElement("button");
		  save.type = "button";
		  save.textContent = "保存标签";
		  save.style.cssText =
		    "display:block;width:calc(100% - 12px);margin:0 6px 4px;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.14));background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.09));color:inherit;font:inherit;cursor:pointer";
		  save.addEventListener("click", (event) => {
		    event.preventDefault();
		    event.stopPropagation();
		    const tags = input.value
		      .split(/[,，]/u)
		      .map((one) => one.trim())
		      .filter((one) => one.length > 0)
		      .slice(0, 24);
		    const next = Object.assign({}, state.preferences?.tags ?? {});
		    if (tags.length === 0) delete next[skin.skinId];
		    else next[skin.skinId] = tags;
		    closeSkinMenu(state);
		    void savePreferences(state, { tags: next }).then(() =>
		      logOperation(state, "tags", skinLabel(skin) + " 的标签已保存到偏好文件：" + (tags.join("、") || "（已清空）")),
		    );
		  });
		  menu.append(label, input, save);
		  input.focus();
		}

		/* ---- deletion, with a confirmation dialog --------------------------------- */

		/** Close the confirmation dialog. Safe when none is open. */
		function closeDeleteDialog(state) {
		  const dialog = state.deleteDialog;
		  if (dialog === null || dialog === undefined) return;
		  try {
		    document.removeEventListener("keydown", dialog.onKey, true);
		    dialog.overlay.remove();
		  } catch {
		    /* already detached */
		  }
		  state.deleteDialog = null;
		  publish(state, {});
		}

		/**
		 * Ask before deleting — the second half of the double confirmation, the first being
		 * the 删除皮肤 menu entry itself.
		 *
		 * The dialog names every skin that will go, states where the folders end up
		 * (Recycle Bin on Windows, the quarantine directory otherwise) because "deleted" and
		 * "recoverable" are different promises, and states that the original uploads are not
		 * touched, because that is the question a user actually has at this point.
		 */
		function confirmDeleteSkins(ctx, state, skinIds) {
		  closeSkinMenu(state);
		  closeDeleteDialog(state);
		  const ids = skinIds.filter((id) => typeof id === "string" && id.length > 0);
		  if (ids.length === 0) return null;
		  const rows = ids.map((id) => {
		    const skin = state.catalog.skins.find((entry) => entry.skinId === id) ?? null;
		    return { id, label: skin === null ? id : skinLabel(skin), bytes: Number(skin?.playback?.bytes ?? skin?.sourceBytes ?? 0) };
		  });
		  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
		  const overlay = document.createElement("div");
		  overlay.setAttribute(SKIN_DIALOG_ATTRIBUTE, "1");
		  overlay.style.cssText =
		    "position:fixed;inset:0;z-index:2147483300;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.52);font:13px/1.5 'Segoe UI',system-ui,sans-serif;color:var(--dsw-alias-label-primary, #ededf0)";
		  const card = document.createElement("div");
		  card.style.cssText =
		    "width:min(420px,92vw);max-height:76vh;overflow:auto;box-sizing:border-box;padding:16px 18px;border-radius:14px;" +
		    "background:color-mix(in srgb, var(--dsw-alias-bg-layer-1, #1b1b1f) 96%, transparent);" +
		    "border:1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.14));box-shadow:0 20px 50px rgba(0,0,0,0.55)";
		  const title = document.createElement("div");
		  title.textContent = "确认删除 " + ids.length + " 套皮肤？";
		  title.style.cssText = "font-size:15px;font-weight:600;margin-bottom:6px";
		  const body = document.createElement("div");
		  body.style.cssText = "font-size:12px;color:var(--dsw-alias-label-secondary, #a5a5ad);margin-bottom:10px";
		  body.textContent =
		    "将删除 output/skins 下对应的文件夹（含图片/视频素材），合计 " +
		    formatBytes(total) +
		    "。Windows 上会移入回收站，其他情况移到 output/_trash（都可恢复）。input_image / input_video 里的原始素材不会被删除。";
		  const list = document.createElement("div");
		  list.style.cssText = "max-height:180px;overflow:auto;margin:0 0 12px;padding:6px 8px;border-radius:8px;background:rgba(0,0,0,0.22);font-size:12px";
		  for (const row of rows.slice(0, 60)) {
		    const line = document.createElement("div");
		    line.textContent = "· " + row.label + (row.bytes > 0 ? "（" + formatBytes(row.bytes) + "）" : "");
		    line.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
		    list.append(line);
		  }
		  if (rows.length > 60) {
		    const more = document.createElement("div");
		    more.textContent = "…以及另外 " + (rows.length - 60) + " 套";
		    list.append(more);
		  }
		  const actions = document.createElement("div");
		  actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
		  const cancel = document.createElement("button");
		  cancel.type = "button";
		  cancel.textContent = "取消";
		  cancel.style.cssText =
		    "padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.16));background:transparent;color:inherit;font:inherit;cursor:pointer";
		  const confirm = document.createElement("button");
		  confirm.type = "button";
		  confirm.textContent = "删除 " + ids.length + " 套";
		  confirm.style.cssText = "padding:6px 14px;border-radius:8px;border:1px solid rgba(255,90,90,0.5);background:rgba(255,70,70,0.22);color:#ffd7d7;font:inherit;cursor:pointer";
		  cancel.addEventListener("click", (event) => {
		    event.preventDefault();
		    closeDeleteDialog(state);
		  });
		  confirm.addEventListener("click", (event) => {
		    event.preventDefault();
		    void performDeleteSkins(ctx, state, ids);
		  });
		  actions.append(cancel, confirm);
		  card.append(title, body, list, actions);
		  overlay.append(card);
		  overlay.addEventListener("pointerdown", (event) => {
		    if (event.target === overlay) closeDeleteDialog(state);
		  });
		  const onKey = (event) => {
		    if (event.key === "Escape") closeDeleteDialog(state);
		  };
		  document.addEventListener("keydown", onKey, true);
		  (document.body ?? document.documentElement).append(overlay);
		  state.deleteDialog = { overlay, onKey, ids };
		  publish(state, {});
		  return overlay;
		}

		/** Carry out a confirmed deletion: recycle the folders, then fix up everything. */
		async function performDeleteSkins(ctx, state, skinIds) {
		  closeDeleteDialog(state);
		  const wasCurrent = skinIds.includes(state.skinId);
		  logOperation(state, "delete", "正在删除 " + skinIds.length + " 套皮肤…");
		  let payload;
		  try {
		    const response = await fetch(CLEANUP_URL, {
		      method: "POST",
		      credentials: "same-origin",
		      headers: { "content-type": "application/json" },
		      body: JSON.stringify({ skinIds, settings: state.assets }),
		    });
		    payload = await response.json();
		  } catch (error) {
		    logOperation(state, "error", "删除失败：" + String(error && error.message ? error.message : error));
		    return;
		  }
		  if (payload.ok !== true) {
		    logOperation(state, "error", "删除被拒绝：" + String(payload.error ?? "unknown") + (payload.detail ? "（" + payload.detail + "）" : ""));
		    return;
		  }
		  const removed = payload.removed ?? [];
		  const went = removed.length > 0 && removed.every((row) => row.how === "recycle-bin") ? "回收站" : "隔离目录/删除";
		  logOperation(state, "delete", "已删除 " + removed.length + " 套（" + formatBytes(payload.totalBytes ?? 0) + "）→ " + went + "；日志 " + (payload.logFile ?? "—"));
		  for (const row of removed) logOperation(state, "delete", "  · " + row.skinId + "  " + formatBytes(row.bytes ?? 0) + "  → " + row.how);
		  if ((payload.missing ?? []).length > 0) logOperation(state, "delete", "  请求的 " + payload.missing.length + " 套已不在磁盘上，跳过");
		  // Drop them from the stored order too, so the file does not accumulate ghosts.
		  // This happens *before* the fallback switch on purpose: the folders are already
		  // gone, and persisting that must not depend on the UI switch completing (which is
		  // the slow, failure-prone half of the operation).
		  const order = (state.preferences?.order ?? []).filter((id) => !skinIds.includes(id));
		  const favorites = (state.favorites ?? []).filter((id) => !skinIds.includes(id));
		  const tags = Object.assign({}, state.preferences?.tags ?? {});
		  for (const id of skinIds) delete tags[id];
		  state.favorites = favorites;
		  writeFavorites(favorites);
		  state.batch = { active: state.batch?.active === true, selected: (state.batch?.selected ?? []).filter((id) => !skinIds.includes(id)) };
		  await savePreferences(state, { order, favorites, tags });
		  // A deleted skin can still be the one on screen. The fallback is chosen from the
		  // catalog as it stands (before the refresh), which is exactly the set that still
		  // exists on disk.
		  if (wasCurrent === true) {
		    const remaining = state.catalog.skins.filter((skin) => !skinIds.includes(skin.skinId));
		    const fallback = remaining.find((skin) => skin.skinId === state.catalog.defaultSkin) ?? remaining[0] ?? null;
		    if (fallback === null) {
		      teardownSkin(state);
		      state.skinId = null;
		      logOperation(state, "delete", "当前皮肤已被删除，且已无可用皮肤：回到内置主题");
		    } else {
		      logOperation(state, "delete", "当前皮肤已被删除，自动切换到 " + skinLabel(fallback));
		      try {
		        await applyById(ctx, state, fallback.skinId);
		      } catch (error) {
		        // The folders are already gone, so a failed switch is reported, not fatal.
		        logOperation(state, "error", "自动切换失败：" + String(error && error.message ? error.message : error) + "（皮肤已删除，可手动选一套）");
		      }
		    }
		  }
		  await loadCatalog(state);
		  publish(state, {});
		}

		/* ---- batch mode ----------------------------------------------------------- */

		/** Toggle one id in the batch selection. */
		function toggleBatchSelection(state, skinId) {
		  const selected = state.batch?.selected ?? [];
		  const next = selected.includes(skinId) ? selected.filter((id) => id !== skinId) : selected.concat(skinId);
		  state.batch = { active: true, selected: next };
		  publish(state, {});
		}

		/** Replace the batch selection wholesale (select-all / clear). */
		function setBatchSelection(state, skinIds) {
		  state.batch = { active: true, selected: Array.from(new Set((skinIds ?? []).filter((id) => typeof id === "string"))) };
		  publish(state, {});
		}

		/** Enter or leave batch mode, clearing the selection on the way out. */
		function setBatchMode(state, active) {
		  state.batch = { active: active === true, selected: active === true ? state.batch?.selected ?? [] : [] };
		  publish(state, {});
		}

		/** Export every selected skin, one at a time, and summarise in the log. */
		async function exportSelection(state, skinIds) {
		  logOperation(state, "export", "开始导出 " + skinIds.length + " 套皮肤…");
		  let done = 0;
		  let bytes = 0;
		  for (const skinId of skinIds) {
		    await exportSkin(state, skinId);
		    const result = state.exportResult;
		    if (result?.status === "ok") {
		      done += 1;
		      bytes += Number(result.bytes ?? 0);
		      logOperation(state, "export", "  · " + skinId + " → " + result.file);
		    } else if (result?.status === "failed") {
		      logOperation(state, "error", "  · " + skinId + " 导出失败：" + result.message);
		    }
		  }
		  logOperation(state, "export", "导出完成：" + done + "/" + skinIds.length + " 套，" + formatBytes(bytes));
		}

		/** Add every selected skin to the favourites and persist it. */
		async function favoriteSelection(state, skinIds) {
		  const next = Array.from(new Set((state.favorites ?? []).concat(skinIds)));
		  state.favorites = next;
		  writeFavorites(next);
		  await savePreferences(state, { favorites: next });
		  logOperation(state, "favorite", "已把 " + skinIds.length + " 套加入收藏（共 " + next.length + " 套收藏）");
		}

		/* ---- interaction polish: hover preview, batch tags, view mode ------------- */

		const HOVER_DELAY_MS = 500;
		const HOVER_PREVIEW_MS = 3000;
		const VIEW_MODE_KEY = "dsh-skins/v1/view-mode";

		function readViewMode() {
		  try {
		    return window.localStorage.getItem(VIEW_MODE_KEY) === "list" ? "list" : "grid";
		  } catch {
		    return "grid";
		  }
		}

		function setViewMode(state, mode) {
		  state.viewMode = mode === "list" ? "list" : "grid";
		  try {
		    window.localStorage.setItem(VIEW_MODE_KEY, state.viewMode);
		  } catch {
		    /* ignore */
		  }
		  publish(state, {});
		  logOperation(state, "view", state.viewMode === "list" ? "切换为列表视图" : "切换为网格视图");
		}

		/** Stop the hover preview: cancel its timers and take the element out. */
		function stopHoverPreview(state) {
		  const preview = state.preview;
		  state.preview = null;
		  state.previewSkin = null;
		  if (preview === null || preview === undefined) return;
		  try {
		    if (preview.timer !== null && preview.timer !== undefined) window.clearTimeout(preview.timer);
		  } catch {
		    /* ignore */
		  }
		  const video = preview.video;
		  if (video === null || video === undefined) return;
		  try {
		    video.pause();
		  } catch {
		    /* ignore */
		  }
		  try {
		    video.removeAttribute("src");
		    video.remove();
		  } catch {
		    /* already detached */
		  }
		  publish(state, {});
		}

		/**
		 * Play a muted 3-second preview inside a video card after half a second of hover.
		 *
		 * Only one preview exists at a time (starting one stops the previous), the element is
		 * muted so no autoplay policy can refuse it, and it is removed — not merely paused —
		 * on the way out, so nothing keeps decoding behind the panel.
		 */
		function startHoverPreview(state, skin) {
		  if (skin === null || skin === undefined || skin.type !== "video") return;
		  stopHoverPreview(state);
		  state.previewSkin = skin.skinId;
		  const timer = window.setTimeout(() => {
		    if (state.previewSkin !== skin.skinId) return;
		    // The ceiling is checked here, not at hover time, because this is where the
		    // element would actually be created.
		    if (videoBudgetAvailable(state) !== true) {
		      state.previewSkin = null;
		      logOperation(state, "perf", "已跳过悬停预览：视频元素已达上限 " + MAX_VIDEO_ELEMENTS + "（当前 " + videoElementCount() + "）");
		      return;
		    }
		    const card = document.querySelector("[" + SKIN_CARD_ATTRIBUTE + '="' + skin.skinId + '"]');
		    const media = card === null || card === undefined ? null : card.querySelector(".dsh-skins-card__media");
		    if (media === null || media === undefined) return;
		    const video = document.createElement("video");
		    video.muted = true;
		    video.defaultMuted = true;
		    video.playsInline = true;
		    video.preload = "auto";
		    video.setAttribute("data-dsh-hover-preview", "1");
		    video.src = ROUTE + "/source/" + encodeURIComponent(skin.skinId);
		    video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;pointer-events:none";
		    media.append(video);
		    state.preview = { skinId: skin.skinId, video, timer: null };
		    try {
		      const started = video.play();
		      if (started !== null && started !== undefined && typeof started.catch === "function") started.catch(() => {});
		    } catch {
		      /* a preview that cannot start is not an error */
		    }
		    state.preview.timer = window.setTimeout(() => stopHoverPreview(state), HOVER_PREVIEW_MS);
		    publish(state, {});
		  }, HOVER_DELAY_MS);
		  state.preview = { skinId: skin.skinId, video: null, timer };
		  publish(state, {});
		}

		/** Add one tag to every selected skin, in one write. */
		async function applyTagSelection(state, skinIds, tag) {
		  const clean = String(tag ?? "").trim().slice(0, 24);
		  if (clean.length === 0) {
		    logOperation(state, "tags", "批量添加标签被跳过：标签为空");
		    return;
		  }
		  const tags = Object.assign({}, state.preferences?.tags ?? {});
		  for (const skinId of skinIds) tags[skinId] = Array.from(new Set((tags[skinId] ?? []).concat(clean)));
		  await savePreferences(state, { tags });
		  logOperation(state, "tags", "已给 " + skinIds.length + " 套添加标签「" + clean + "」");
		}

		/** Select everything that is not selected, within what the filter currently shows. */
		function invertSelection(state, shownIds) {
		  const current = new Set(state.batch?.selected ?? []);
		  state.batch = { active: true, selected: (shownIds ?? []).filter((id) => current.has(id) === false) };
		  publish(state, {});
		}

		/** Put the skin in use at the top of the library without touching the stored order. */
		function pinActiveSkin(skins, activeId, pinned) {
		  if (pinned !== true || activeId === null || activeId === undefined) return skins;
		  const at = skins.findIndex((skin) => skin.skinId === activeId);
		  if (at <= 0) return skins;
		  return [skins[at]].concat(skins.slice(0, at), skins.slice(at + 1));
		}

		/* ---- performance and resource protection --------------------------------- */

		/** How far outside the viewport a thumbnail starts loading. */
		const THUMB_ROOT_MARGIN = "240px";
		/** Hard ceiling on live <video> elements: the background, plus previews. */
		const MAX_VIDEO_ELEMENTS = 3;
		/** How often the panel's runtime block refreshes. */
		const STATUS_TICK_MS = 2000;

		let thumbObserver = null;

		/**
		 * Load the thumbnails that are in (or near) the viewport, and only those.
		 *
		 * The grid can show 50+ cards; attaching 50 image requests at once is what makes the
		 * library feel heavy, so each `<img>` carries its URL in `data-thumb` and gets a real
		 * `src` when it approaches the viewport. Idempotent — it is safe to call after every
		 * render, which is exactly how it is used. Without `IntersectionObserver` every image
		 * loads immediately, because a missing feature must not mean no pictures.
		 *
		 * @returns how many images were handed to the observer (or loaded) in this call.
		 */
		function observeThumbs(doc) {
		  const target = doc ?? document;
		  const pending = Array.from(target.querySelectorAll("img[data-thumb]")).filter((node) => node.getAttribute("data-thumb-observed") !== "1");
		  if (pending.length === 0) return 0;
		  const load = (node) => {
		    const src = node.getAttribute("data-thumb");
		    if (typeof src === "string" && src.length > 0) node.setAttribute("src", src);
		    node.setAttribute("data-thumb-loaded", "1");
		  };
		  if (typeof window.IntersectionObserver !== "function") {
		    for (const node of pending) load(node);
		    return pending.length;
		  }
		  if (thumbObserver === null) {
		    thumbObserver = new window.IntersectionObserver(
		      (entries) => {
		        for (const entry of entries) {
		          if (entry.isIntersecting !== true) continue;
		          load(entry.target);
		          try {
		            thumbObserver.unobserve(entry.target);
		          } catch {
		            /* ignore */
		          }
		        }
		      },
		      { root: null, rootMargin: THUMB_ROOT_MARGIN, threshold: 0.01 },
		    );
		  }
		  for (const node of pending) {
		    // Marked as observed *before* it loads: `data-thumb-loaded` only appears when the
		    // element scrolls into view, so observing must not be keyed off it or every
		    // re-render would re-observe the whole library.
		    node.setAttribute("data-thumb-observed", "1");
		    thumbObserver.observe(node);
		  }
		  return pending.length;
		}

		/** Test hook: forget the shared observer so a fresh document can be observed. */
		function resetThumbObserver() {
		  try {
		    if (thumbObserver !== null) thumbObserver.disconnect();
		  } catch {
		    /* ignore */
		  }
		  thumbObserver = null;
		}

		function videoElementCount(doc) {
		  return (doc ?? document).querySelectorAll("video").length;
		}

		/** Whether one more video element is allowed under the ceiling. */
		function videoBudgetAvailable(state, doc) {
		  const count = videoElementCount(doc);
		  state.videoElements = count;
		  return count < MAX_VIDEO_ELEMENTS;
		}

		/**
		 * Pause everything that costs GPU/CPU while the window is not on screen.
		 *
		 * Only what was *playing* is resumed: a video the user paused stays paused, which is
		 * the difference between "the background came back" and "the background ignored me".
		 * The audio graph is suspended too — a running AudioContext keeps a real-time thread
		 * alive for a background nobody can see.
		 */
		function pauseBackground(state, reason) {
		  if (state.bgPaused === true) return;
		  state.bgPaused = true;
		  state.bgPauseReason = reason;
		  const video = state.video;
		  if (video !== null && video !== undefined && video.paused !== true) {
		    state.bgWasPlaying = true;
		    try {
		      video.pause();
		    } catch {
		      /* ignore */
		    }
		  }
		  stopHoverPreview(state);
		  try {
		    if (state.audioContext !== null && state.audioContext !== undefined && state.audioContext.state === "running") void state.audioContext.suspend();
		  } catch {
		    /* an unsuspendable context is not worth failing over */
		  }
		  publish(state, {});
		}

		/** Undo a background pause, resuming only what it interrupted. */
		function resumeBackground(state) {
		  if (state.bgPaused !== true) return;
		  const wasPlaying = state.bgWasPlaying === true;
		  state.bgPaused = false;
		  state.bgPauseReason = null;
		  state.bgWasPlaying = false;
		  try {
		    if (state.audioContext !== null && state.audioContext !== undefined && state.audioContext.state === "suspended") void state.audioContext.resume();
		  } catch {
		    /* ignore */
		  }
		  const video = state.video;
		  if (wasPlaying === true && video !== null && video !== undefined) {
		    try {
		      const started = video.play();
		      if (started !== null && started !== undefined && typeof started.catch === "function") started.catch(() => {});
		    } catch {
		      /* a refused resume leaves the poster in place, which is a fine fallback */
		    }
		  }
		  publish(state, {});
		}

		/**
		 * Install the window-state guards.
		 *
		 * `visibilitychange` covers minimise and tab switches (Electron reports a minimised
		 * window as hidden); blur/focus covers "the user is working in another window", which
		 * is what was asked for. The returned disposer removes all three.
		 */
		function installBackgroundGuards(state) {
		  const onVisibility = () => {
		    if (document.visibilityState === "hidden" || document.hidden === true) pauseBackground(state, "hidden");
		    else resumeBackground(state);
		  };
		  const onBlur = () => pauseBackground(state, "blur");
		  const onFocus = () => {
		    if (document.hidden !== true && document.visibilityState !== "hidden") resumeBackground(state);
		  };
		  document.addEventListener("visibilitychange", onVisibility);
		  window.addEventListener("blur", onBlur);
		  window.addEventListener("focus", onFocus);
		  return () => {
		    document.removeEventListener("visibilitychange", onVisibility);
		    window.removeEventListener("blur", onBlur);
		    window.removeEventListener("focus", onFocus);
		  };
		}

		/**
		 * The panel's runtime figures.
		 *
		 * The memory number is an estimate by construction (a browser does not expose decoded
		 * image memory), so it states its own basis: 4 bytes per pixel for every loaded
		 * thumbnail, plus one 720p frame buffer per live video element. It is meant to move
		 * when something is wrong, not to be an accounting figure.
		 */
		function readRuntimeStatus(state, doc) {
		  const target = doc ?? document;
		  const videos = target.querySelectorAll("video");
		  const loaded = target.querySelectorAll("img[data-thumb-loaded='1']");
		  let thumbPixels = 0;
		  for (const node of loaded) thumbPixels += (Number(node.naturalWidth) || 160) * (Number(node.naturalHeight) || 90);
		  const playback = state.catalog?.skins?.find((row) => row.skinId === state.skinId)?.playback?.bytes ?? 0;
		  const frames = videos.length * 1280 * 720 * 4;
		  return {
		    at: new Date().toISOString(),
		    videos: videos.length,
		    videoLimit: MAX_VIDEO_ELEMENTS,
		    paused: state.bgPaused === true,
		    pauseReason: state.bgPauseReason ?? null,
		    playing: state.bgPaused === true ? false : state.videoPlaying === true,
		    thumbsLoaded: loaded.length,
		    thumbsPending: target.querySelectorAll("img[data-thumb]").length - loaded.length,
		    estimatedMB: Math.round(((thumbPixels * 4 + frames) / 1048576) * 10) / 10,
		    playbackMB: Math.round((Number(playback) || 0) / 1048576 * 10) / 10,
		  };
		}

		function tickRuntimeStatus(state, doc) {
		  state.runtime = readRuntimeStatus(state, doc);
		  publish(state, {});
		  return state.runtime;
		}

		function startStatusTimer(state) {
		  if (state.statusTimer !== null && state.statusTimer !== undefined) return;
		  tickRuntimeStatus(state);
		  if (typeof window.setInterval === "function") state.statusTimer = window.setInterval(() => tickRuntimeStatus(state), STATUS_TICK_MS);
		}

		function stopStatusTimer(state) {
		  if (state.statusTimer === null || state.statusTimer === undefined) return;
		  try {
		    window.clearInterval(state.statusTimer);
		  } catch {
		    /* ignore */
		  }
		  state.statusTimer = null;
		}

		/* ---- advanced customisation: switch hotkeys, UI knobs, recommendations ---- */

		/** Physical keys that switch skins. PageUp/PageDown first: the arrows are widely taken. */
		const SWITCH_KEYS = { PageUp: -1, PageDown: 1, ArrowUp: -1, ArrowDown: 1 };
		const TOAST_ATTRIBUTE = "data-dsh-skin-toast";
		const TOAST_MS = 1400;
		const UI_KNOBS_KEY = "dsh-skins/v1/ui-knobs";
		const RECOMMEND_KEY = "dsh-skins/v1/recommend";
		const SETTINGS_URL = ROUTE + "/settings";
		const UI_KNOB_LIMITS = { radius: [0, 24], fontScale: [80, 150], panelAlpha: [20, 100] };
		const UI_KNOB_DEFAULTS = { radius: 8, fontScale: 100, panelAlpha: 62 };

		function readUiKnobs() {
		  const out = Object.assign({}, UI_KNOB_DEFAULTS);
		  try {
		    const parsed = JSON.parse(window.localStorage.getItem(UI_KNOBS_KEY) ?? "null");
		    if (parsed === null || typeof parsed !== "object") return out;
		    for (const key of Object.keys(UI_KNOB_DEFAULTS)) if (Number.isFinite(Number(parsed[key]))) out[key] = Number(parsed[key]);
		    return out;
		  } catch {
		    return out;
		  }
		}

		/**
		 * Apply the three knobs as CSS variables, plus a small stylesheet that uses them.
		 *
		 * Written on `document.body` with `important` priority on purpose: the shell keeps its
		 * own `--dsw-*` / `--dsh-*` values inline on `body`, so an ordinary declaration (or an
		 * `html`-level one) would simply lose. The stylesheet then maps the plugin's variables
		 * onto the shell's radius tokens, the content font sizes and the panel surfaces — the
		 * parts I can name without depending on hashed class names.
		 */
		function applyUiKnobs(state) {
		  const knobs = state.uiKnobs ?? UI_KNOB_DEFAULTS;
		  const root = document.documentElement;
		  const body = document.body ?? root;
		  try {
		    root.style.setProperty("--dsh-ui-radius", knobs.radius + "px");
		    root.style.setProperty("--dsh-ui-font-scale", String(knobs.fontScale / 100));
		    root.style.setProperty("--dsh-panel-alpha", String(knobs.panelAlpha / 100));
		    // The shell's own tokens, with priority, since it owns them inline.
		    for (const token of ["--dsw-radius-sm", "--dsw-radius-md", "--dsw-radius-lg"]) body.style.setProperty(token, knobs.radius + "px", "important");
		    const scale = knobs.fontScale / 100;
		    for (const [token, fallback] of [["--dsh-content-font-size-secondary", 13], ["--dsh-content-font-size-tertiary", 12]]) {
		      let base = fallback;
		      try {
		        const current = Number.parseFloat(window.getComputedStyle(body).getPropertyValue(token));
		        if (Number.isFinite(current) && current > 6 && current < 40) base = current;
		      } catch {
		        /* a missing computed style simply keeps the fallback */
		      }
		      body.style.setProperty(token, Math.round(base * scale * 100) / 100 + "px", "important");
		    }
		  } catch {
		    /* a refused custom property must not take the panel down */
		  }
		  if (state.uiKnobStyle === null || state.uiKnobStyle === undefined) {
		    const style = document.createElement("style");
		    style.setAttribute(STYLE_ATTRIBUTE, PACKAGE_ID + "/ui-knobs");
		    style.setAttribute("data-dsh-skin-ui-knobs", "1");
		    style.textContent = [
		      ":root{--dsh-ui-radius:8px;--dsh-ui-font-scale:1;--dsh-panel-alpha:0.62}",
		      // the plugin's own surfaces follow the knobs directly
		      ".dsh-skins-panel{font-size:calc(13px * var(--dsh-ui-font-scale))}",
		      ".dsh-skins-card,.dsh-skins-btn,.dsh-skins-select,.dsh-skins-input{border-radius:var(--dsh-ui-radius)}",
		      ".dsh-skins-card__media,.dsh-skins-oplog,.dsh-skins-batch{border-radius:calc(var(--dsh-ui-radius) * 0.6)}",
		      ".dsh-skins-btn,.dsh-skins-auto-label{font-size:calc(12px * var(--dsh-ui-font-scale))}",
		      ".dsh-skins-note,.dsh-skins-err,.dsh-skins-warn{font-size:calc(12px * var(--dsh-ui-font-scale))}",
		      // panel translucency, driven by the third knob
		      ".dsh-skins-card__info,.dsh-skins-batch,.dsh-skins-batch{opacity:1}",
		      "html[data-dsh-advanced] .dsh-skins-panel{background:color-mix(in srgb, var(--dsw-alias-bg-layer-1, #1b1b1f) calc(var(--dsh-panel-alpha) * 100%), transparent)}",
		    ].join("\n");
		    (document.head ?? document.documentElement).append(style);
		    state.uiKnobStyle = style;
		  }
		  root.setAttribute("data-dsh-advanced", "1");
		  return knobs;
		}

		function setUiKnob(state, key, value) {
		  if (UI_KNOB_LIMITS[key] === undefined) return state.uiKnobs;
		  const [lo, hi] = UI_KNOB_LIMITS[key];
		  const next = Object.assign({}, state.uiKnobs ?? UI_KNOB_DEFAULTS, { [key]: clamp(Number(value) || 0, lo, hi) });
		  state.uiKnobs = next;
		  try {
		    window.localStorage.setItem(UI_KNOBS_KEY, JSON.stringify(next));
		  } catch {
		    /* ignore */
		  }
		  applyUiKnobs(state);
		  publish(state, {});
		  return next;
		}

		/** The centre toast: which skin the hotkey just moved to, and where it sits. */
		function showSwitchToast(state, skin, index, total) {
		  try {
		    for (const node of Array.from(document.querySelectorAll("[" + TOAST_ATTRIBUTE + "]"))) node.remove();
		    const toast = document.createElement("div");
		    toast.setAttribute(TOAST_ATTRIBUTE, "1");
		    toast.style.cssText =
		      "position:fixed;left:50%;top:38%;transform:translate(-50%,-50%);z-index:2147483645;padding:10px 16px;border-radius:12px;" +
		      "background:color-mix(in srgb, var(--dsw-alias-bg-layer-1, #1b1b1f) 88%, transparent);border:1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.16));" +
		      "box-shadow:0 16px 40px rgba(0,0,0,0.5);font:13px/1.5 'Segoe UI',system-ui,sans-serif;color:var(--dsw-alias-label-primary, #ededf0);" +
		      "text-align:center;pointer-events:none;backdrop-filter:blur(10px);transition:opacity 200ms ease";
		    const title = document.createElement("div");
		    title.textContent = skinLabel(skin);
		    title.style.cssText = "font-size:15px;font-weight:600;margin-bottom:2px";
		    const meta = document.createElement("div");
		    meta.textContent = (skin.type === "video" ? (skin.video?.rendition ? "已压缩视频" : "原始视频") : "图片") + " · " + (index + 1) + " / " + total;
		    meta.style.cssText = "font-size:11px;color:var(--dsw-alias-label-secondary, #9a9aa2)";
		    toast.append(title, meta);
		    const thumb = assetUrl(skin, "thumb") ?? assetUrl(skin, "wallpaper") ?? assetUrl(skin, "poster");
		    if (thumb !== null) {
		      const image = document.createElement("img");
		      image.src = thumb;
		      image.alt = "";
		      image.style.cssText = "display:block;width:180px;height:96px;object-fit:cover;border-radius:8px;margin:6px auto 0";
		      toast.append(image);
		    }
		    (document.body ?? document.documentElement).append(toast);
		    state.toast = toast;
		    if (typeof window.setTimeout === "function") {
		      window.setTimeout(() => {
		        try {
		          toast.style.opacity = "0";
		          window.setTimeout(() => toast.remove(), 220);
		        } catch {
		          /* already gone */
		        }
		      }, TOAST_MS);
		    }
		  } catch {
		    /* a toast that cannot be shown must not break the switch */
		  }
		}

		/** Move by one position inside the ordered library, wrapping at both ends. */
		function switchByStep(ctx, state, step) {
		  const list = orderedSkins(state, state.catalog.skins);
		  if (list.length === 0) return null;
		  const at = list.findIndex((skin) => skin.skinId === state.skinId);
		  const nextIndex = at === -1 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length;
		  const next = list[nextIndex];
		  logOperation(state, "switch", "切换到 " + skinLabel(next) + "（" + (nextIndex + 1) + " / " + list.length + "）");
		  showSwitchToast(state, next, nextIndex, list.length);
		  void applyById(ctx, state, next.skinId);
		  return next;
		}

		/** Whether an event is a skin-switch chord: Ctrl+Shift + PageUp/PageDown/Arrow. */
		function switchChordStep(event) {
		  if (event === null || event === undefined) return 0;
		  if (event.ctrlKey !== true || event.shiftKey !== true || event.altKey === true || event.metaKey === true) return 0;
		  const step = SWITCH_KEYS[event.code];
		  return Number.isFinite(step) ? step : 0;
		}

		/**
		 * Install the switch chords on `window` (capture), same discipline as the focus chord.
		 *
		 * Conflict handling: the registry is asked first and the answer is reported, but the
		 * handler never depends on it — and because this listener takes the key in the capture
		 * phase, exactly one owner exists. `PageUp`/`PageDown` are the declared chords;
		 * `Ctrl+Shift+Arrow` is accepted as a fallback because many layouts make the page keys
		 * awkward, but the arrows are widely bound by editors and the shell, so a refusal there
		 * is expected and only logged.
		 */
		function installSwitchHotkeys(ctx, state) {
		  if (typeof state.disposeSwitches === "function") return state.disposeSwitches;
		  const info = { chord: "Ctrl + Shift + PageUp / PageDown", arrows: "Ctrl + Shift + ↑ / ↓", installed: false, registry: [], hits: 0, lastFire: null, note: null };
		  try {
		    const shortcuts = typeof ctx?.get === "function" ? ctx.get("shortcuts") : null;
		    if (shortcuts !== null && shortcuts !== undefined && typeof shortcuts.register === "function") {
		      for (const [code, label] of [["PageUp", "上一套皮肤"], ["PageDown", "下一套皮肤"]]) {
		        try {
		          const dispose = shortcuts.register({
		            id: PACKAGE_ID + ".switch-" + code.toLowerCase(),
		            label: () => label,
		            aliases: [],
		            defaults: shortcutDefaults(code, SHORTCUT_PROFILES),
		            regions: SHORTCUT_REGIONS,
		            modals: [],
		            resolve: () => ({ status: "handled", run: () => {} }),
		          });
		          if (typeof dispose === "function") dispose();
		          info.registry.push(code + ":accepted");
		        } catch (error) {
		          info.registry.push(code + ":refused(" + String(error && error.message ? error.message : error).slice(0, 60) + ")");
		        }
		      }
		      info.note = "注册表结论：" + info.registry.join("，") + "（实际由全局监听处理，避免一个组合两个所有者）";
		    } else {
		      info.note = "没有可用的快捷键服务，仅使用全局监听";
		    }
		  } catch (error) {
		    info.note = "询问快捷键服务失败：" + String(error && error.message ? error.message : error);
		  }
		  const listener = (event) => {
		    const step = switchChordStep(event);
		    if (step === 0) return;
		    event.preventDefault();
		    event.stopPropagation();
		    if (event.repeat === true) return;
		    info.hits += 1;
		    info.lastFire = new Date().toISOString();
		    state.switchHotkey = Object.assign({}, info);
		    try {
		      switchByStep(ctx, state, step);
		    } catch (error) {
		      logOperation(state, "error", "快捷键切换失败：" + String(error && error.message ? error.message : error));
		    }
		    publish(state, {});
		  };
		  try {
		    window.addEventListener("keydown", listener, true);
		    info.installed = true;
		  } catch (error) {
		    info.note = "无法安装切换监听：" + String(error && error.message ? error.message : error);
		  }
		  state.switchHotkey = Object.assign({}, info);
		  const dispose = () => {
		    try {
		      window.removeEventListener("keydown", listener, true);
		    } catch {
		      /* ignore */
		    }
		    state.disposeSwitches = null;
		  };
		  state.disposeSwitches = dispose;
		  publish(state, {});
		  return dispose;
		}

		/* ---- time-of-day recommendation ------------------------------------------ */

		function defaultRecommend() {
		  return { enabled: false, autoApply: false, start: "08:00", end: "18:00", dayPool: [], nightPool: [] };
		}

		function readRecommend() {
		  try {
		    const parsed = JSON.parse(window.localStorage.getItem(RECOMMEND_KEY) ?? "null");
		    if (parsed === null || typeof parsed !== "object") return defaultRecommend();
		    return Object.assign(defaultRecommend(), parsed, {
		      dayPool: Array.isArray(parsed.dayPool) ? parsed.dayPool.filter((id) => typeof id === "string") : [],
		      nightPool: Array.isArray(parsed.nightPool) ? parsed.nightPool.filter((id) => typeof id === "string") : [],
		    });
		  } catch {
		    return defaultRecommend();
		  }
		}

		/**
		 * The automatic pools, derived from catalog facts rather than taste.
		 *
		 * Day wants light, cool skins; night wants dark ones or anything that moves (a video
		 * reads as "evening" because it is the more atmospheric option).
		 */
		function autoPool(skins, mode) {
		  const isCool = (skin) => {
		    const base = skin.colors?.dark?.accent ?? skin.colors?.light?.accent ?? "";
		    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(String(base));
		    if (match === null) return true;
		    return Number.parseInt(match[3], 16) >= Number.parseInt(match[1], 16);
		  };
		  if (mode === "day") {
		    return skins.filter((skin) => skin.type === "image" && (skin.anchorScheme === "light" || isCool(skin))).map((skin) => skin.skinId);
		  }
		  return skins.filter((skin) => skin.type === "video" || skin.anchorScheme === "dark").map((skin) => skin.skinId);
		}

		/** Which skin the clock suggests, and why. Pure, so it can be tested. */
		function recommendDecision(state, config, now) {
		  const skins = state.catalog?.skins ?? [];
		  if (skins.length === 0) return null;
		  const minutes = (now?.getHours?.() ?? 0) * 60 + (now?.getMinutes?.() ?? 0);
		  const start = parseClock(config.start);
		  const end = parseClock(config.end);
		  if (start === null || end === null) return null;
		  const inside = start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
		  const mode = inside ? "day" : "night";
		  const custom = (mode === "day" ? config.dayPool : config.nightPool).filter((id) => skins.some((skin) => skin.skinId === id));
		  const pool = custom.length > 0 ? custom : autoPool(skins, mode);
		  if (pool.length === 0) return null;
		  // Stable within a time bucket: the suggestion does not jump on every tick.
		  const bucket = Math.floor(minutes / 30);
		  const pick = pool[bucket % pool.length];
		  return { mode, skinId: pick, pool: pool.length, custom: custom.length > 0, detail: (inside ? "白天时段 " : "夜间时段 ") + config.start + "–" + config.end + " · " + (custom.length > 0 ? "自定义候选 " + custom.length : "自动候选 " + pool.length) + " 套" };
		}

		function writeRecommend(state, patch) {
		  state.recommend = Object.assign({}, state.recommend ?? defaultRecommend(), patch);
		  try {
		    window.localStorage.setItem(RECOMMEND_KEY, JSON.stringify(state.recommend));
		  } catch {
		    /* ignore */
		  }
		  publish(state, {});
		  return state.recommend;
		}

		function setRecommend(state, patch) {
		  writeRecommend(state, patch);
		  logOperation(state, "recommend", "推荐设置已更新：" + Object.keys(patch).join("、"));
		}

		/** Apply the suggestion when nothing with higher precedence matched. */
		function evaluateRecommendation(ctx, state, reason) {
		  const config = state.recommend ?? defaultRecommend();
		  if (config.enabled !== true) return null;
		  const decision = recommendDecision(state, config, new Date());
		  state.recommendDecision = decision;
		  if (decision === null) return null;
		  if (config.autoApply !== true) {
		    publish(state, {});
		    return decision;
		  }
		  if (state.automationDecision !== null && state.automationDecision !== undefined) return decision;
		  if (decision.skinId === state.skinId) return decision;
		  logOperation(state, "recommend", "按时段推荐：" + decision.detail);
		  void switchTo(ctx, state, state.catalog.skins.find((skin) => skin.skinId === decision.skinId) ?? null, reason ?? "recommend");
		  return decision;
		}

		/* ---- settings export / import / reset ------------------------------------ */

		/** Everything the panel considers its own configuration. */
		function collectSettings(state) {
		  return {
		    format: "dsh-skins-settings/1",
		    exportedAt: new Date().toISOString(),
		    uiVersion: UI_VERSION,
		    revision: REVISION,
		    preferences: state.preferences ?? null,
		    favorites: state.favorites ?? [],
		    tweaks: state.tweaks ?? {},
		    automation: state.automation ?? null,
		    recommend: state.recommend ?? defaultRecommend(),
		    assets: state.assets ?? ASSET_DEFAULTS,
		    uiKnobs: state.uiKnobs ?? UI_KNOB_DEFAULTS,
		    viewMode: state.viewMode ?? "grid",
		    customCss: state.customCss ?? "",
		    skinId: state.skinId ?? null,
		  };
		}

		async function exportSettings(state) {
		  const settings = collectSettings(state);
		  let payload = null;
		  try {
		    const response = await fetch(SETTINGS_URL, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
		    payload = await response.json();
		  } catch (error) {
		    logOperation(state, "error", "配置导出失败：" + String(error && error.message ? error.message : error));
		    return null;
		  }
		  if (payload.ok !== true) {
		    logOperation(state, "error", "配置导出被拒绝：" + String(payload.error ?? "unknown"));
		    return null;
		  }
		  state.settingsFile = payload.file;
		  logOperation(state, "settings", "配置已导出到 " + payload.file + "（" + Object.keys(settings).length + " 个字段）");
		  publish(state, {});
		  return settings;
		}

		/** Apply an imported settings object: local stores first, then the file. */
		async function importSettings(ctx, state, incoming) {
		  if (incoming === null || typeof incoming !== "object") {
		    logOperation(state, "error", "配置导入失败：不是有效的 JSON 对象");
		    return false;
		  }
		  const settings = incoming;
		  if (settings.preferences !== null && typeof settings.preferences === "object") {
		    state.preferences = Object.assign({ version: 1, order: [], favorites: [], hidden: [], tags: {} }, settings.preferences);
		    writePrefsCache(state.preferences);
		    await savePreferences(state, { order: state.preferences.order ?? [], favorites: state.preferences.favorites ?? [], tags: state.preferences.tags ?? {} });
		  }
		  if (Array.isArray(settings.favorites)) {
		    state.favorites = settings.favorites.filter((id) => typeof id === "string");
		    writeFavorites(state.favorites);
		  }
		  if (settings.tweaks !== null && typeof settings.tweaks === "object") {
		    state.tweaks = settings.tweaks;
		    writeTweaks(state.tweaks);
		  }
		  if (settings.automation !== null && typeof settings.automation === "object") {
		    state.automation = Object.assign(defaultAutomation(), settings.automation);
		    writeAutomation(state.automation);
		    startAutomation(ctx, state);
		  }
		  if (settings.recommend !== null && typeof settings.recommend === "object") writeRecommend(state, settings.recommend);
		  if (settings.assets !== null && typeof settings.assets === "object") {
		    state.assets = Object.assign({}, ASSET_DEFAULTS, settings.assets);
		    writeAssetSettings(state.assets);
		  }
		  if (settings.uiKnobs !== null && typeof settings.uiKnobs === "object") {
		    state.uiKnobs = Object.assign({}, UI_KNOB_DEFAULTS, settings.uiKnobs);
		    try {
		      window.localStorage.setItem(UI_KNOBS_KEY, JSON.stringify(state.uiKnobs));
		    } catch {
		      /* ignore */
		    }
		    applyUiKnobs(state);
		  }
		  if (typeof settings.viewMode === "string") state.viewMode = settings.viewMode === "list" ? "list" : "grid";
		  if (typeof settings.customCss === "string") {
		    state.customCss = settings.customCss;
		    writeCustomCss(state.customCss);
		    applyCustomCss(state);
		  }
		  applyTokenLayer(ctx, state);
		  await loadCatalog(state);
		  logOperation(state, "settings", "配置已导入：" + Object.keys(settings).join("、"));
		  publish(state, {});
		  return true;
		}

		/** Back to factory settings, with the current skin left alone. */
		async function resetSettings(ctx, state) {
		  state.preferences = { version: 1, order: [], favorites: [], hidden: [], tags: {} };
		  writePrefsCache(state.preferences);
		  state.favorites = [];
		  writeFavorites([]);
		  state.tweaks = {};
		  writeTweaks({});
		  state.assets = Object.assign({}, ASSET_DEFAULTS);
		  writeAssetSettings(state.assets);
		  state.uiKnobs = Object.assign({}, UI_KNOB_DEFAULTS);
		  try {
		    window.localStorage.setItem(UI_KNOBS_KEY, JSON.stringify(state.uiKnobs));
		  } catch {
		    /* ignore */
		  }
		  applyUiKnobs(state);
		  state.recommend = defaultRecommend();
		  writeRecommend(state, state.recommend);
		  state.viewMode = "grid";
		  await savePreferences(state, { order: [], favorites: [], tags: {} });
		  state.automation = defaultAutomation();
		  writeAutomation(state.automation);
		  startAutomation(ctx, state);
		  clearCustomCss(state);
		  await exportSettings(state);
		  logOperation(state, "settings", "已恢复默认设置（皮肤选择保持不变）");
		  publish(state, {});
		  return true;
		}

		/* ------------------------------------------------------------------ *
		 * Favourites and the library filters
		 * ------------------------------------------------------------------ */

		/** Favourite skin ids, in the order they were added. */
		function readFavorites() {
		  try {
		    const raw = window.localStorage.getItem(FAVORITES_KEY);
		    if (raw === null) return [];
		    const parsed = JSON.parse(raw);
		    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
		  } catch {
		    return [];
		  }
		}

		function writeFavorites(list) {
		  try {
		    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
		  } catch {
		    /* a blocked localStorage must not break the panel */
		  }
		}

		/** Add or remove one skin from the favourites and repaint. */
		function toggleFavorite(state, skinId) {
		  const current = state.favorites;
		  const next = current.includes(skinId) ? current.filter((value) => value !== skinId) : [...current, skinId];
		  state.favorites = next;
		  writeFavorites(next);
		  // Turning the last favourite off while the filter is on would leave an empty
		  // grid with no visible cause, so the filter follows the data.
		  if (next.length === 0 && state.filters.favoriteOnly === true) {
		    state.filters = Object.assign({}, state.filters, { favoriteOnly: false });
		  }
		  publish(state, {});
		  // The favourites are part of the preferences file now, so they survive a cleared
		  // renderer profile and not just localStorage.
		  void savePreferences(state, { favorites: next });
		}

		/** One skin's tags: the generation keywords, the mood words, and the user's own. */
		function skinTags(skin, state) {
		  const custom = state?.preferences?.tags?.[skin?.skinId] ?? [];
		  const raw = [...(skin && skin.styleKeywords ? skin.styleKeywords : []), ...(skin && skin.mood ? skin.mood : []), ...custom];
		  const seen = new Set();
		  for (const value of raw) {
		    const tag = String(value).trim();
		    if (tag.length > 0) seen.add(tag);
		  }
		  return Array.from(seen);
		}

		/** Every tag in the catalog with how many skins carry it, most used first. */
		function tagOptions(state) {
		  const counts = new Map();
		  for (const skin of state.catalog.skins) {
		    for (const tag of skinTags(skin)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
		  }
		  return Array.from(counts.entries())
		    .map(([tag, count]) => ({ tag, count }))
		    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
		}

		/** Replace part of the filter state; it lives in the store so closing the tab keeps it. */
		function setFilter(state, patch) {
		  state.filters = Object.assign({}, state.filters, patch);
		  publish(state, {});
		}

		/* ------------------------------------------------------------------ *
		 * A tiny subscribable view model for the React panel
		 * ------------------------------------------------------------------ */

		/**
		 * Rebuild the frozen snapshot React renders from, bump the version and wake
		 * every listener. One immutable object per change keeps the panel's `useState`
		 * comparison honest, and keeps the skin logic above free of React.
		 */
		function publish(state, patch) {
		  if (patch !== undefined && patch !== null) Object.assign(state, patch);
		  state.version += 1;
		  state.view = {
		    version: state.version,
		    revision: REVISION,
		    uiVersion: UI_VERSION,
		    catalog: state.catalog,
		    catalogError: state.catalogError,
		    skinId: state.skinId,
		    tweaks: tweaksFor(state, state.skinId),
		    slider: tweakSliders(state, state.skinId),
		    tokenSource: state.tokenSource,
		    liveTokensNote: state.liveTokensNote,
		    liveTokensCheck: state.liveTokensCheck,
		    liveTokensSource: state.liveTokensSource,
		    parallaxOn: state.parallaxOn === true,
		    reducedMotion: prefersReducedMotion(),
		    videoPlaying: state.videoPlaying === true,
		    videoMuted: state.videoMuted !== false,
		    videoRate: state.videoRate ?? 1,
		    videoHasAudio: state.videoHasAudio ?? null,
		    videoSilent: state.videoSilent ?? null,
		    videoNote: state.videoNote ?? null,
		    audioReactiveOn: state.audioGraph !== null && state.audioGraph !== undefined,
		    audioLevel: state.audioLevel ?? 0,
		    automation: state.automation,
		    automationNote: state.automationNote,
		    automationDecision: state.automationDecision,
		    automationOrder: AUTOMATION_ORDER,
		    automationTimers: state.automationDisposers.length,
		    workspaceItems: bindableWorkspaces(state),
		    workspaceIndexAt: state.workspaceIndex.at,
		    currentWorkspaceLabel: state.currentWorkspaceLabel,
		    mountedSource: state.mountedSource,
		    assets: state.assets,
		    ffmpeg: state.ffmpeg,
		    assetJob: state.assetJob,
		    exportResult: state.exportResult,
		    importResult: state.importResult,
		    cleanup: state.cleanup,
		    referenced: referencedSkins(state),
		    customCss: state.customCss,
		    customCssCheck: state.customCssCheck,
		    customCssApplied: state.customStyle !== null && state.customStyle !== undefined,
		    focusMode: state.focusMode,
		    focusFullscreen: state.focusFullscreen === true,
		    focusNote: state.focusNote,
		    focusConflicts: state.focusConflicts,
		    focusRecovered: state.focusRecovered,
		    focusLaneCount: (state.focusLanes ?? []).length,
		    focusHotkey: state.focusHotkey,
		    preferences: state.preferences,
		    preferencesFile: state.preferencesFile,
		    preferencesSavedAt: state.preferencesSavedAt,
		    preferencesNote: state.preferencesNote,
		    opLog: state.opLog ?? [],
		    drag: state.drag,
		    batch: state.batch ?? { active: false, selected: [] },
		    skinMenuOpen: state.skinMenu !== null && state.skinMenu !== undefined,
		    deleteDialogOpen: state.deleteDialog !== null && state.deleteDialog !== undefined,
		    uiKnobs: state.uiKnobs,
		    switchHotkey: state.switchHotkey,
		    recommend: state.recommend,
		    recommendDecision: state.recommendDecision,
		    settingsFile: state.settingsFile,
		    settingsNote: state.settingsNote,
		    layerZIndex: { before: state.layerZIndexBefore, after: state.layerZIndexAfter },
		    pickNote: state.pickNote,
		    accentOverride: state.accentOverride,
		    favorites: state.favorites,
		    filters: state.filters,
		    tags: tagOptions(state),
		    job: state.job,
		    hostRevision: state.hostRevision,
		    staleHost: state.hostRevision !== null && state.hostRevision !== REVISION,
		    panelReady: state.panelReady,
		    panelError: state.panelError,
		    shortcutMode: state.shortcutMode,
		    shortcutKeys: state.shortcutKeys,
		  };
		  for (const listener of Array.from(state.listeners)) {
		    try {
		      listener();
		    } catch (error) {
		      console.error("[dsh-skins] panel listener failed", error);
		    }
		  }
		}

		/** Subscribe a component to the view model. */
		function useView(store) {
		  const [view, setView] = react.useState(store.view);
		  react.useEffect(() => {
		    let alive = true;
		    const sync = () => {
		      if (alive) setView(store.view);
		    };
		    store.listeners.add(sync);
		    sync();
		    return () => {
		      alive = false;
		      store.listeners.delete(sync);
		    };
		  }, [store]);
		  return view;
		}

		/* ------------------------------------------------------------------ *
		 * Applying a skin
		 * ------------------------------------------------------------------ */

		/**
		 * Apply a skin.
		 *
		 * Token layering and stylesheet injection are one operation on purpose: either
		 * both describe the same skin, or the previous skin is restored. A failure in
		 * the middle therefore rolls the token layer back rather than leaving the UI in
		 * a half-skinned state.
		 *
		 * @param ctx - client root context carrying the theme service.
		 * @param state - the runtime state object.
		 * @param skin - one catalog entry.
		 * @returns a report fragment describing what was applied.
		 */
		async function applySkin(ctx, state, skin) {
		  const report = { skinId: skin.skinId, tokensApplied: 0, stylesheet: false, layer: false, media: null, errors: [] };

		  // A new skin invalidates the previous skin's live measurement, and the token
		  // layer goes in first: if the stylesheet fetch then fails, the layer still
		  // carries the right polarity, and teardownSkin can undo this cleanly.
		  state.liveTokens = null;
		  state.liveTokensNote = null;
		  state.liveTokensCheck = null;
		  state.liveTokensSource = null;
		  state.skinId = skin.skinId;
		  report.tokensApplied = applyTokenLayer(ctx, state);
		  report.tokenSource = state.tokenSource;

		  const cssUrl = ROUTE + "/doc/" + encodeURIComponent(skin.skinId) + "/theme.css";
		  let css = "";
		  try {
		    const response = await fetch(cssUrl, { credentials: "same-origin" });
		    if (!response.ok) throw new Error("HTTP " + response.status);
		    css = await response.text();
		    report.stylesheet = css.length > 0;
		  } catch (error) {
		    report.errors.push("stylesheet: " + String(error && error.message ? error.message : error));
		  }

		  const style = document.createElement("style");
		  style.setAttribute(STYLE_ATTRIBUTE, PACKAGE_ID + "/" + skin.skinId);
		  style.textContent = css;
		  document.head.append(style);
		  state.style = style;

		  // The shared chrome fix-up is injected once and stays for the session: it is
		  // about the shell's surfaces, not about any one skin.
		  if (state.chromeStyle === null || state.chromeStyle === undefined) {
		    try {
		      const chrome = await fetch(ROUTE + "/chrome.css", { credentials: "same-origin" });
		      if (chrome.ok) {
		        const chromeStyle = document.createElement("style");
		        chromeStyle.setAttribute(STYLE_ATTRIBUTE, PACKAGE_ID + "/chrome");
		        chromeStyle.textContent = await chrome.text();
		        document.head.append(chromeStyle);
		        state.chromeStyle = chromeStyle;
		      }
		    } catch (error) {
		      report.errors.push("chrome-css: " + String(error && error.message ? error.message : error));
		    }
		  }

		  document.documentElement.setAttribute("data-skin", skin.skinId);

		  state.layer = renderLayer(skin, report, state);
		  // The transport owner runs after the element exists, so play/pause, mute and
		  // speed come from the stored knobs rather than from the element's defaults.
		  applyVideoSettings(state);
		  applyLayerTweaks(state);
		  // The live UI layer needs pixels, which only exist now that the frame is
		  // mounted — so it is derived after the layer, never before it.
		  if (tweakSliders(state, state.skinId).uiFollow === true) scheduleLiveTokens(ctx, state);
		  if (tweakSliders(state, state.skinId).audioReactive === true) void applyAudioReactive(ctx, state);
		  return report;
		}

		/**
		 * The full client diagnostic, shared by every report this half sends.
		 *
		 * One shape for all reasons matters: the host half *overwrites* its report file,
		 * so a later, narrower report would hide the earlier evidence. `reason` says
		 * which moment this is.
		 */
		function clientReport(state, reason, extra) {
		  const slider = tweakSliders(state, state.skinId);
		  return Object.assign(
		    {
		      reason,
		      at: new Date().toISOString(),
		      packageId: PACKAGE_ID,
		      revision: REVISION,
		      uiVersion: UI_VERSION,
		      target: state.skinId,
		      applied: state.layer !== null,
		      catalogCount: state.catalog.counts,
		      reducedMotion: prefersReducedMotion(),
		      layer: state.layer !== null,
		      stylesheet: state.style !== null,
		      videoPresent: state.video !== null,
		      media: state.video === null ? "poster" : prefersReducedMotion() ? "poster (reduced-motion)" : "video",
		      prefs: readPrefs(),
		      tweaks: tweaksFor(state, state.skinId),
		      slider,
		      filters: {
		        grayscale: slider.grayscale,
		        saturate: slider.saturate,
		        contrast: slider.contrast,
		        posterize: slider.posterize,
		        levels: posterizeLevels(slider.posterize),
		      },
		      toggles: { uiFollow: slider.uiFollow, parallax: slider.parallax, audioReactive: slider.audioReactive },
		      video: {
		        playing: state.videoPlaying === true,
		        muted: slider.videoMuted,
		        rate: slider.videoRate,
		        silent: state.videoSilent ?? null,
		        hasAudio: state.videoHasAudio ?? null,
		        graph: state.audioGraph === null || state.audioGraph === undefined ? "off" : "on",
		        level: state.audioLevel ?? 0,
		        note: state.videoNote ?? null,
		      },
		      parallaxOn: state.parallaxOn === true,
		      tokenSource: state.tokenSource,
		      liveTokens:
		        state.liveTokens === null || state.liveTokens === undefined
		          ? null
		          : { scheme: state.liveTokens.scheme, alpha: state.liveTokens.alpha, check: state.liveTokens.check, source: state.liveTokensSource },
		      liveTokensNote: state.liveTokensNote,
		      livePreview: state.livePreview ?? null,
		      assets: state.assets,
		      assetJob: state.assetJob === null || state.assetJob === undefined ? null : { status: state.assetJob.status, running: state.assetJob.running === true, message: state.assetJob.message ?? null, results: state.assetJob.results?.length ?? 0 },
		      ffmpeg: state.ffmpeg === null || state.ffmpeg === undefined ? null : { available: state.ffmpeg.available === true, staleHost: state.ffmpeg.staleHost === true, path: state.ffmpeg.path ?? null, error: state.ffmpeg.error ?? null },
		      exportResult: state.exportResult ?? null,
		      importResult: state.importResult ?? null,
		      cleanup: state.cleanup === null || state.cleanup === undefined ? null : { status: state.cleanup.status, remove: state.cleanup.remove?.length ?? 0, logFile: state.cleanup.logFile ?? null },
		      referenced: referencedSkins(state),
		      revision: REVISION,
		      hostRevision: state.hostRevision ?? null,
		      staleHost: state.hostRevision !== null && state.hostRevision !== undefined && state.hostRevision !== REVISION,
		      customCss: { chars: state.customCss.length, rules: state.customCssCheck?.rules ?? 0, ok: state.customCssCheck?.ok === true, applied: state.customStyle !== null && state.customStyle !== undefined, errors: state.customCssCheck?.errors?.length ?? 0, firstError: state.customCssCheck?.errors?.[0]?.message ?? null },
		      focusMode: { on: state.focusMode === true, hidden: (state.focusTargets ?? []).length, lanes: (state.focusLanes ?? []).length, exitButton: state.focusAnchor !== null && state.focusAnchor !== undefined, recovered: state.focusRecovered === true, conflicts: (state.focusConflicts ?? []).map((row) => row.selector + " { " + row.declaration + " }"), layerZIndex: { before: state.layerZIndexBefore, after: state.layerZIndexAfter }, titlebarInPage: document.documentElement.hasAttribute("data-windows-titlebar"), fullscreen: document.fullscreenElement !== null && document.fullscreenElement !== undefined, fullscreenRequested: state.focusFullscreen === true, probe: state.focusProbe ?? null, probeSettled: state.focusProbeSettled ?? null, note: state.focusNote },
		      focusPlan: focusPlanFor(state),
		      library: {
		        preferencesFile: state.preferencesFile,
		        preferencesSavedAt: state.preferencesSavedAt,
		        note: state.preferencesNote,
		        order: (state.preferences?.order ?? []).length,
		        favorites: (state.favorites ?? []).length,
		        tagged: Object.keys(state.preferences?.tags ?? {}).length,
		        batchActive: state.batch?.active === true,
		        batchSelected: (state.batch?.selected ?? []).length,
		        dragging: state.drag === null || state.drag === undefined ? null : { skinId: state.drag.skinId, over: state.drag.over },
		        // What the browser reports under the menu's centre when it opened: if a shell
		        // layer is above the menu, this names it instead of leaving it to guesswork.
		        menuHitTest: state.skinMenu?.hit ?? null,
		        runtime: state.runtime ?? null,
		        // The switch chord's own diagnostics, so "the key did nothing" can be told
		        // apart from "the key never arrived" by reading a file.
		        switchHotkey: state.switchHotkey === null || state.switchHotkey === undefined ? null : Object.assign({}, state.switchHotkey),
		        opLog: (state.opLog ?? []).slice(0, 10).map((row) => `${row.at.slice(11, 19)} [${row.kind}] ${row.message}`),
		      },
		      focusHotkey: state.focusHotkey === null || state.focusHotkey === undefined ? null : Object.assign({}, state.focusHotkey, { note: state.focusHotkeyNote ?? state.focusHotkey.note }),
		      picker: { open: state.picker !== null && state.picker !== undefined, note: state.pickNote },
		      accentOverride: state.accentOverride === null || state.accentOverride === undefined ? null : { picked: state.accentOverride.picked, applied: state.accentOverride.color, shifted: state.accentOverride.shifted === true, against: Number(state.accentOverride.against?.toFixed?.(2) ?? state.accentOverride.against), inkRatio: Number(state.accentOverride.inkRatio?.toFixed?.(2) ?? state.accentOverride.inkRatio), ink: state.accentOverride.ink, surface: state.accentOverride.surface, surfaceNote: state.accentOverride.surfaceNote },
		      automation: {
		        config: state.automation,
		        decision: state.automationDecision ?? null,
		        applied: state.automationApplied ?? null,
		        note: state.automationNote ?? null,
		        timers: state.automationDisposers?.length ?? 0,
		        mountedSource: state.mountedSource ?? null,
		        session: state.currentSessionId ?? null,
		        workspace: state.currentWorkspaceLabel ?? null,
		        workspaceItems: bindableWorkspaces(state).length,
		        workspaceIndexAt: state.workspaceIndex.at,
		      },
		      favorites: state.favorites,
		      libraryFilters: state.filters,
		      tagCount: tagOptions(state).length,
		      shortcutMode: state.shortcutMode,
		      shortcutNote: state.shortcutNote,
		      shortcutKeys: state.shortcutKeys,
		      shortcutDiag: state.shortcutDiag,
		      panelReady: state.panelReady,
		      panelError: state.panelError,
		      guideOrder: GUIDE_ORDER,
		      location: window.location.origin,
		    },
		    extra ?? {},
		  );
		}

		/** Log, stripe and post one report. Failures are diagnostic-only. */
		async function sendReport(state, report) {
		  console.log("[dsh-skins] " + report.reason + " report", report);
		  try {
		    window.localStorage.setItem(REPORT_BACKUP_KEY, JSON.stringify(report));
		  } catch {
		    /* ignore */
		  }
		  try {
		    await fetch(REPORT_URL, {
		      method: "POST",
		      credentials: "same-origin",
		      headers: { "content-type": "application/json" },
		      body: JSON.stringify(report),
		    });
		  } catch {
		    /* the panel still works offline; the report is diagnostic only */
		  }
		}

		/**
		 * Publish a shortcut diagnostic once per distinct outcome.
		 *
		 * Without this the report would keep showing the mode from page load, because
		 * the service's injection callback resolves after the first report was sent —
		 * and a stale "dom" would look like a failure that is not there.
		 */
		function reportShortcutState(state) {
		  const fingerprint = JSON.stringify([state.shortcutMode, state.shortcutNote, state.shortcutKeys]);
		  if (state.shortcutReported === fingerprint) return;
		  state.shortcutReported = fingerprint;
		  void sendReport(state, clientReport(state, "shortcuts-settled"));
		}

		/** Remove whatever the previous skin installed, in reverse order. */
		function teardownSkin(state) {
		  // The audio graph goes first: its loop writes to the layer being removed, and
		  // the context itself is kept for the next element (creating one per skin would
		  // leak a hardware voice each switch).
		  stopAudioLoop(state);
		  const graph = state.audioGraph;
		  if (graph !== null && graph !== undefined) {
		    try {
		      graph.source.disconnect();
		    } catch {
		      /* the element is going away with its node */
		    }
		    try {
		      graph.analyser.disconnect();
		      graph.gain.disconnect();
		    } catch {
		      /* ignore */
		    }
		    state.audioGraph = null;
		  }
		  state.videoPlaying = false;
		  state.videoSilent = undefined;
		  state.videoNote = null;
		  state.videoHasAudio = null;
		  state.audioLevel = 0;
		  if (typeof state.disposeTokens === "function") {
		    try {
		      state.disposeTokens();
		    } catch {
		      /* the theme service may already be gone during unload */
		    }
		    state.disposeTokens = null;
		  }
		  if (state.style !== null && state.style !== undefined) {
		    state.style.remove();
		    state.style = null;
		  }
		  if (state.layer !== null && state.layer !== undefined) {
		    state.layer.remove();
		    state.layer = null;
		  }
		  if (state.video !== null && state.video !== undefined) {
		    try {
		      state.video.pause();
		    } catch {
		      /* already detached */
		    }
		    state.video = null;
		  }
		  state.poster = null;
		  state.scrim = null;
		  state.liveTokens = null;
		  state.liveTokensNote = null;
		  state.liveTokensCheck = null;
		  state.liveTokensSource = null;
		  state.parallax = { x: 0, y: 0 };
		  state.parallaxOn = false;
		  if (state.liveTimer !== null && state.liveTimer !== undefined) {
		    window.clearTimeout(state.liveTimer);
		    state.liveTimer = null;
		  }
		  document.documentElement.removeAttribute("data-skin");
		  state.skinId = null;
		}

		/**
		 * Write every visual knob onto the live layer.
		 *
		 * Deliberately narrow: it touches only `filter`, `opacity` and `transform` on the
		 * two media elements, the scrim's gradient alpha, and one `perspective` on the
		 * layer itself. The layer's own geometry is never modified — that geometry is
		 * what keeps the desktop shell's long-standing 1-device-pixel edge artifact
		 * away, so no knob and no gesture may move it.
		 *
		 * @param state - the runtime state carrying the mounted media elements.
		 */
		function applyLayerTweaks(state) {
		  const settings = tweaksFor(state, state.skinId);
		  const slider = tweakSliders(state, state.skinId);
		  const levels = posterizeLevels(slider.posterize);
		  // The pulse only exists while the graph does, so the variable terms are added
		  // and removed with it rather than always being present.
		  const audioOn = slider.audioReactive === true && prefersReducedMotion() !== true && state.audioGraph !== null && state.audioGraph !== undefined;
		  const filter = layerFilter(slider, audioOn);
		  const parallaxOn = slider.parallax === true && !prefersReducedMotion();
		  state.parallaxOn = parallaxOn;
		  if (!parallaxOn) state.parallax = { x: 0, y: 0 };
		  const offset = state.parallax ?? { x: 0, y: 0 };

		  // Blur needs its own overscan; a moving frame needs a little more, so that no
		  // gesture can expose the layer's edge.
		  const scale = (1 + settings.blur / 100) * (parallaxOn ? LAYER_OVERSCAN : 1);
		  const translate = "translate3d(" + offset.x.toFixed(2) + "px, " + offset.y.toFixed(2) + "px, 0)";
		  const pulse = audioOn ? " scale(var(" + AUDIO_SCALE_VAR + ", 1))" : "";
		  const tilt = parallaxOn
		    ? " rotateX(" + ((-offset.y / PARALLAX_MAX_Y) * PARALLAX_TILT_DEG).toFixed(3) + "deg)" +
		      " rotateY(" + ((offset.x / PARALLAX_MAX_X) * PARALLAX_TILT_DEG).toFixed(3) + "deg)"
		    : "";
		  const transform = translate + pulse + " scale(" + scale.toFixed(4) + ")" + tilt;
		  if (!audioOn) setAudioDrive(state, 0, true);

		  for (const media of [state.poster, state.video]) {
		    if (media === null || media === undefined) continue;
		    media.style.filter = filter;
		    media.style.opacity = String(settings.opacity);
		    media.style.transform = transform;
		    // A short transition is what turns pointer events into a smooth drift; with
		    // parallax off there is nothing to smooth.
		    media.style.transition = parallaxOn ? "transform 160ms cubic-bezier(0.22, 0.61, 0.36, 1)" : "none";
		  }
		  if (levels > 0) ensurePosterizeFilter(levels);

		  if (state.layer !== null && state.layer !== undefined) {
		    // The perspective has to live on the parent for rotateX/rotateY to read as depth.
		    state.layer.style.perspective = parallaxOn ? "900px" : "none";
		  }
		  if (state.scrim !== null && state.scrim !== undefined) {
		    const veil = settings.veil;
		    const ink = (alpha) => "rgba(0,0,0," + (alpha * veil).toFixed(3) + ")";
		    state.scrim.style.background =
		      "linear-gradient(to bottom," +
		      " " + ink(0.34) + " 0%," +
		      " " + ink(0.08) + " 30%," +
		      " " + ink(0.08) + " 62%," +
		      " " + ink(0.4) + " 100%)";
		  }
		  // The SVG filter is dropped once nothing references it, so an idle layer holds
		  // no extra DOM. Order matters: the media must stop pointing at it first.
		  if (levels === 0) removePosterizeFilter();

		  document.documentElement.style.setProperty("--dsh-skin-blur", String(settings.blur));
		  document.documentElement.style.setProperty("--dsh-skin-veil", String(settings.veil));
		}

		/** The CSS `filter` list the current knobs describe. */
		function layerFilter(slider, audioReactive) {
		  const parts = [];
		  if (slider.blur > 0) parts.push("blur(" + slider.blur + "px)");
		  if (slider.grayscale > 0) parts.push("grayscale(" + slider.grayscale + "%)");
		  if (slider.saturate !== 100) parts.push("saturate(" + slider.saturate + "%)");
		  if (slider.contrast !== 100) parts.push("contrast(" + slider.contrast + "%)");
		  // The pulse is a variable, not a number: the per-frame update is then one
		  // custom-property write instead of a filter re-parse on a playing video.
		  if (audioReactive === true) parts.push("brightness(var(" + AUDIO_BRIGHTNESS_VAR + ", 1))");
		  // A real posterize: SVG's discrete component transfer, which no CSS filter
		  // function can express.
		  if (slider.posterize > 0) parts.push("url(#" + POSTERIZE_FILTER_ID + ")");
		  return parts.length === 0 ? "none" : parts.join(" ");
		}

		/** How many tonal steps the posterize slider asks for; 0 means off. */
		function posterizeLevels(value) {
		  if (!(value > 0)) return 0;
		  return Math.max(2, Math.round(32 - (value / 100) * 30));
		}

		/**
		 * Maintain the hidden SVG filter the posterize slider points at.
		 *
		 * `feComponentTransfer` with `type="discrete"` is the one way to quantise
		 * channels inside a CSS filter list: an N-step `tableValues` is an N-level
		 * posterize. The element is written in place so the media never has to re-resolve
		 * the filter reference.
		 *
		 * @param levels - tonal steps, 2..32.
		 * @returns the filter element.
		 */
		function ensurePosterizeFilter(levels) {
		  const namespace = "http://www.w3.org/2000/svg";
		  const svgId = POSTERIZE_FILTER_ID + "-svg";
		  let svg = document.getElementById(svgId);
		  if (svg === null || svg === undefined) {
		    svg = document.createElementNS(namespace, "svg");
		    svg.setAttribute("id", svgId);
		    svg.setAttribute("aria-hidden", "true");
		    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
		    const filter = document.createElementNS(namespace, "filter");
		    filter.setAttribute("id", POSTERIZE_FILTER_ID);
		    // sRGB keeps the banding where the CSS filter functions put their output;
		    // the SVG default (linearRGB) would shift the whole frame.
		    filter.setAttribute("color-interpolation-filters", "sRGB");
		    const transfer = document.createElementNS(namespace, "feComponentTransfer");
		    for (const channel of ["R", "G", "B"]) {
		      const func = document.createElementNS(namespace, "feFunc" + channel);
		      func.setAttribute("type", "discrete");
		      transfer.append(func);
		    }
		    filter.append(transfer);
		    svg.append(filter);
		    const host = document.body ?? document.documentElement;
		    host.append(svg);
		  }
		  const table = [];
		  for (let step = 0; step < levels; step += 1) table.push((step / (levels - 1)).toFixed(4));
		  for (const channel of ["R", "G", "B"]) {
		    const func = svg.querySelector("feFunc" + channel);
		    if (func !== null) func.setAttribute("tableValues", table.join(" "));
		  }
		  return svg;
		}

		/** Drop the posterize filter element once no media references it. */
		function removePosterizeFilter() {
		  const svg = document.getElementById(POSTERIZE_FILTER_ID + "-svg");
		  if (svg !== null && svg !== undefined) svg.remove();
		}

		/**
		 * Aim the layer at the pointer.
		 *
		 * The offset is inverted so the frame reads as *behind* the chrome, and both
		 * axes are clamped to the parallax ceilings — the brief caps the movement at
		 * 10 CSS pixels.
		 */
		function setParallax(state, clientX, clientY) {
		  const width = window.innerWidth || 1;
		  const height = window.innerHeight || 1;
		  const nx = clamp((clientX / width) * 2 - 1, -1, 1);
		  const ny = clamp((clientY / height) * 2 - 1, -1, 1);
		  state.parallax = { x: -nx * PARALLAX_MAX_X, y: -ny * PARALLAX_MAX_Y };
		  applyLayerTweaks(state);
		}

		/**
		 * Hold one passive pointer listener for the fiber's life.
		 *
		 * Updates are coalesced into an animation frame: a pointer stream fires far more
		 * often than the compositor can use, and writing a transform per event would
		 * queue work the frame will discard anyway.
		 */
		function installParallax(state) {
		  let frame = 0;
		  let pending = null;
		  const onMove = (event) => {
		    if (state.parallaxOn !== true) return;
		    pending = { x: event.clientX, y: event.clientY };
		    if (frame !== 0) return;
		    frame = window.requestAnimationFrame(() => {
		      frame = 0;
		      if (pending !== null) setParallax(state, pending.x, pending.y);
		    });
		  };
		  window.addEventListener("pointermove", onMove, { passive: true });
		  return () => {
		    window.removeEventListener("pointermove", onMove);
		    if (frame !== 0) window.cancelAnimationFrame(frame);
		  };
		}

		/* ------------------------------------------------------------------ *
		 * Video-only controls: transport, and the audio-driven pulse
		 * ------------------------------------------------------------------ */

		/** Whether the element reports an audio track; `null` when it cannot say. */
		function videoHasAudio(video) {
		  if (video === null || video === undefined) return null;
		  try {
		    const tracks = video.audioTracks;
		    if (tracks !== null && tracks !== undefined && typeof tracks.length === "number") return tracks.length > 0;
		  } catch {
		    /* the property is not exposed in every build */
		  }
		  try {
		    if (typeof video.webkitAudioDecodedByteCount === "number") return video.webkitAudioDecodedByteCount > 0 ? true : null;
		  } catch {
		    /* ignore */
		  }
		  return null;
		}

		/**
		 * Copy what the element actually did into the store.
		 *
		 * The panel must never claim "playing" while the element is paused, and the
		 * element is the only authority on that: autoplay can be refused, and the user
		 * can use the media keys or the picture-in-picture controls.
		 */
		function syncVideoState(state, note) {
		  const video = state.video;
		  if (video === null || video === undefined) {
		    state.videoPlaying = false;
		    return;
		  }
		  state.videoPlaying = video.paused !== true;
		  state.videoMuted = video.muted === true;
		  state.videoRate = nearestRate(video.playbackRate);
		  const hasAudio = videoHasAudio(video);
		  if (hasAudio !== null) state.videoHasAudio = hasAudio;
		  if (typeof note === "string") state.videoNote = note;
		}

		/**
		 * Apply play/pause, mute and speed to the mounted element.
		 *
		 * The single owner of the transport: `renderLayer` no longer starts playback
		 * itself, so there is exactly one place that can refuse to autoplay.
		 */
		function applyVideoSettings(state, slider) {
		  const video = state.video;
		  if (video === null || video === undefined) return;
		  const wanted = slider ?? tweakSliders(state, state.skinId);
		  video.style.display = prefersReducedMotion() ? "none" : "";
		  try {
		    video.playbackRate = wanted.videoRate;
		  } catch {
		    /* an unsupported rate is not worth failing the background for */
		  }
		  // Muted is set before the play attempt on purpose: it is what makes autoplay admissible.
		  video.muted = wanted.videoMuted;
		  video.defaultMuted = wanted.videoMuted;
		  const graph = state.audioGraph;
		  if (graph !== null && graph !== undefined && graph.element === video) {
		    // Chromium bypasses the element's own volume and mute once a
		    // MediaElementAudioSourceNode exists, so the gain node is the audible
		    // authority for as long as this element is routed.
		    graph.gain.gain.value = wanted.videoMuted ? 0 : 1;
		  }
		  if (wanted.videoPlaying !== true || prefersReducedMotion()) {
		    try {
		      video.pause();
		    } catch {
		      /* already stopped */
		    }
		    syncVideoState(state);
		    return;
		  }
		  const attempt = video.play();
		  if (attempt && typeof attempt.catch === "function") {
		    attempt.catch(() => {
		      video.style.display = "none";
		      syncVideoState(state, "自动播放被拒绝：点「播放」即可（先显示海报帧）");
		      publish(state, {});
		    });
		  }
		  syncVideoState(state);
		}

		/**
		 * Route the element through WebAudio so its amplitude can be read.
		 *
		 * Two consequences are load-bearing and neither is optional:
		 *   * a `MediaElementAudioSourceNode` can only be created once per element, so
		 *     the graph is cached per element and reused;
		 *   * after routing, the element's audio never reaches the speakers outside the
		 *     graph again — so the gain node stays the audible authority even if the
		 *     switch is turned off later, which is why the graph is never torn down
		 *     while its element is mounted.
		 *
		 * It is therefore created lazily: a user who never asks for the effect keeps the
		 * plain element with its own volume and mute.
		 */
		function ensureAudioGraph(state) {
		  const video = state.video;
		  if (video === null || video === undefined) return null;
		  const existingGraph = state.audioGraph;
		  if (existingGraph !== null && existingGraph !== undefined && existingGraph.element === video) return existingGraph;
		  const Ctor = window.AudioContext ?? window.webkitAudioContext;
		  if (typeof Ctor !== "function") {
		    state.videoNote = "此环境不支持 WebAudio，音频律动不可用";
		    return null;
		  }
		  try {
		    if (state.audioContext === null || state.audioContext === undefined) state.audioContext = new Ctor();
		    const context = state.audioContext;
		    if (existingGraph !== null && existingGraph !== undefined) {
		      try {
		        existingGraph.source.disconnect();
		      } catch {
		        /* the previous element is gone; its node is released with it */
		      }
		    }
		    const source = context.createMediaElementSource(video);
		    const analyser = context.createAnalyser();
		    analyser.fftSize = 1024;
		    analyser.smoothingTimeConstant = 0.6;
		    const gain = context.createGain();
		    gain.gain.value = tweakSliders(state, state.skinId).videoMuted ? 0 : 1;
		    source.connect(analyser);
		    analyser.connect(gain);
		    gain.connect(context.destination);
		    state.audioGraph = {
		      element: video,
		      context,
		      source,
		      analyser,
		      gain,
		      buffer: new Uint8Array(analyser.fftSize),
		      level: 0,
		      peak: 0,
		      frames: 0,
		      lastWritten: -1,
		    };
		    return state.audioGraph;
		  } catch (error) {
		    state.videoNote = "音频分析不可用：" + String(error && error.message ? error.message : error);
		    state.audioGraph = null;
		    return null;
		  }
		}

		/** Read the analyser once and fold it into a smoothed 0..1 drive. */
		function audioFrame(state) {
		  const graph = state.audioGraph;
		  if (graph === null || graph === undefined) return 0;
		  graph.analyser.getByteTimeDomainData(graph.buffer);
		  let sum = 0;
		  for (let index = 0; index < graph.buffer.length; index += 1) {
		    const value = (graph.buffer[index] - 128) / 128;
		    sum += value * value;
		  }
		  const rms = Math.sqrt(sum / graph.buffer.length);
		  graph.frames += 1;
		  graph.peak = Math.max(graph.peak, rms);
		  // A background is not a VU meter: the drive is smoothed and scaled so ordinary
		  // programme audio reaches the ceiling without a compressor.
		  graph.level = graph.level * 0.78 + Math.min(1, rms * 3.2) * 0.22;
		  return graph.level;
		}

		/** Publish the drive as the two CSS variables the layer's strings reference. */
		function setAudioDrive(state, level, force) {
		  const graph = state.audioGraph;
		  if (graph !== null && graph !== undefined && force !== true && Math.abs(level - graph.lastWritten) < 0.002) return;
		  if (graph !== null && graph !== undefined) graph.lastWritten = level;
		  const root = document.documentElement;
		  if (!(level > 0.001)) {
		    root.style.removeProperty(AUDIO_SCALE_VAR);
		    root.style.removeProperty(AUDIO_BRIGHTNESS_VAR);
		    return;
		  }
		  root.style.setProperty(AUDIO_SCALE_VAR, (1 + level * AUDIO_SCALE_MAX).toFixed(4));
		  root.style.setProperty(AUDIO_BRIGHTNESS_VAR, (1 + level * AUDIO_BRIGHTNESS_MAX).toFixed(4));
		}

		function stopAudioLoop(state) {
		  if (state.audioFrame !== null && state.audioFrame !== undefined) {
		    window.cancelAnimationFrame(state.audioFrame);
		    state.audioFrame = null;
		  }
		  state.audioLevel = 0;
		  setAudioDrive(state, 0, true);
		}

		/**
		 * One frame of the pulse.
		 *
		 * Coalesced into `requestAnimationFrame`, and it publishes to the panel only when
		 * the "no audio" verdict flips — a store update per frame would re-render the
		 * whole panel sixty times a second for no visible gain.
		 */
		function startAudioLoop(state) {
		  if (state.audioFrame !== null && state.audioFrame !== undefined) return;
		  const step = () => {
		    state.audioFrame = null;
		    const video = state.video;
		    const graph = state.audioGraph;
		    if (video === null || video === undefined || graph === null || graph === undefined || graph.element !== video) return;
		    const level = video.paused === true ? 0 : audioFrame(state);
		    setAudioDrive(state, level);
		    state.audioLevel = Number(level.toFixed(3));
		    if (graph.peak > AUDIO_SILENCE_FLOOR) {
		      if (state.videoSilent !== false) {
		        state.videoSilent = false;
		        state.videoHasAudio = true;
		        publish(state, {});
		      }
		    } else if (graph.frames > AUDIO_SILENCE_FRAMES && video.paused !== true && state.videoSilent !== true) {
		      state.videoSilent = true;
		      publish(state, {});
		    }
		    state.audioFrame = window.requestAnimationFrame(step);
		  };
		  state.audioFrame = window.requestAnimationFrame(step);
		}

		/**
		 * Turn the switch into reality: build the graph, resume the context, run the loop.
		 *
		 * Those three are async or permission-gated, so this is async while `setTweak`
		 * stays synchronous — the caller does not wait for it.
		 */
		async function applyAudioReactive(ctx, state) {
		  const slider = tweakSliders(state, state.skinId);
		  const wanted = slider.audioReactive === true && prefersReducedMotion() !== true && state.video !== null && state.video !== undefined;
		  if (wanted !== true) {
		    stopAudioLoop(state);
		    applyLayerTweaks(state);
		    publish(state, {});
		    return;
		  }
		  const graph = ensureAudioGraph(state);
		  if (graph === null) {
		    applyLayerTweaks(state);
		    publish(state, {});
		    return;
		  }
		  try {
		    // A context created outside a gesture starts suspended; the switch click is
		    // the gesture that lifts it.
		    await graph.context.resume();
		  } catch {
		    /* the effect still works from an already-running context */
		  }
		  graph.frames = 0;
		  graph.peak = 0;
		  graph.level = 0;
		  graph.lastWritten = -1;
		  state.videoSilent = undefined;
		  applyLayerTweaks(state);
		  startAudioLoop(state);
		  publish(state, {});
		}

		/* ------------------------------------------------------------------ *
		 * UI colours following the background
		 * ------------------------------------------------------------------ */

		/**
		 * Read the pixels the user is looking at, filters included.
		 *
		 * `context.filter` takes the same CSS filter functions the media element carries,
		 * so drawing the frame through it measures what is on screen rather than the
		 * original artwork. Blur is skipped (it cannot change the average colour) and the
		 * posterize SVG filter is skipped (canvas `filter` cannot reference one) — the
		 * note in the panel says so when that slider is up.
		 *
		 * @returns the `deriveLiveTokens` input shape, or null when nothing is paintable.
		 */
		function measureDisplayed(state, slider) {
		  const media = state.video !== null && state.video !== undefined && state.video.readyState >= 2 ? state.video : state.poster;
		  if (media === null || media === undefined) return null;
		  const canvas = document.createElement("canvas");
		  canvas.width = SAMPLE_SIZE;
		  canvas.height = SAMPLE_SIZE;
		  const context = canvas.getContext("2d", { willReadFrequently: true });
		  if (context === null || context === undefined) return null;
		  const parts = [];
		  if (slider.grayscale > 0) parts.push("grayscale(" + slider.grayscale + "%)");
		  if (slider.saturate !== 100) parts.push("saturate(" + slider.saturate + "%)");
		  if (slider.contrast !== 100) parts.push("contrast(" + slider.contrast + "%)");
		  try {
		    context.filter = parts.length === 0 ? "none" : parts.join(" ");
		  } catch {
		    /* an engine without canvas filters measures the unfiltered frame */
		  }
		  try {
		    context.drawImage(media, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
		  } catch {
		    return null;
		  } finally {
		    try {
		      context.filter = "none";
		    } catch {
		      /* ignore */
		    }
		  }
		  const stats = (() => {
		    try {
		      // A cross-origin frame would taint the canvas; the media is served from the
		      // app's own origin, but a refused read must degrade, not throw.
		      return analyzeSample(context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data, SAMPLE_SIZE, SAMPLE_SIZE);
		    } catch {
		      return null;
		    }
		  })();
		  if (stats === null) return null;
		  const palette = pickPalette(stats);
		  return {
		    luminance: stats.luminance,
		    luminanceP10: stats.luminanceP10,
		    luminanceP22: stats.luminanceP22,
		    luminanceP78: stats.luminanceP78,
		    luminanceP90: stats.luminanceP90,
		    artworkHue: palette.primary.h,
		    artworkSat: palette.primary.s,
		    accentHue: palette.accent.h,
		    accentSat: palette.accent.s,
		    accentLightness: palette.accent.l,
		    temperature: stats.warmth > 0.04 ? "warm" : stats.warmth < -0.04 ? "cool" : "neutral",
		    measurement: {
		      primary: palette.primary.hex,
		      accent: palette.accent.hex,
		      luminance: Number(stats.luminance.toFixed(3)),
		      luminanceP22: Number(stats.luminanceP22.toFixed(3)),
		      luminanceP78: Number(stats.luminanceP78.toFixed(3)),
		    },
		  };
		}

		/**
		 * Install the token layer the current settings call for.
		 *
		 * The live layer and the skin's shipped palette share one override source on
		 * purpose: `overrideTokens` is keyed by source, so replacing the value replaces
		 * the layer instead of stacking two of them, and turning the switch off restores
		 * exactly what the skin shipped.
		 *
		 * @returns how many tokens are in force.
		 */
		function applyTokenLayer(ctx, state) {
		  if (typeof state.disposeTokens === "function") {
		    try {
		      state.disposeTokens();
		    } catch {
		      /* the theme service may already be gone during unload */
		    }
		    state.disposeTokens = null;
		  }
		  const slider = tweakSliders(state, state.skinId);
		  const skin = state.skinId === null ? null : state.catalog.skins.find((entry) => entry.skinId === state.skinId) ?? null;
		  const live = slider.uiFollow === true && state.liveTokens !== null && state.liveTokens !== undefined ? state.liveTokens : null;
		  const base = live !== null ? live.tokens : skin === null ? null : skin.presentedTokens;
		  if (base === null || base === undefined) {
		    state.tokenSource = "none";
		    return 0;
		  }
		  // A picked accent is layered onto whichever base is in force, so the eyedropper
		  // changes the accent family and nothing else — it does not switch the surfaces
		  // to the live palette behind the user's back.
		  const picked = state.accentOverride ?? null;
		  const tokens = picked === null ? base : withAccentTokens(base, picked);
		  state.disposeTokens = ctx.theme.overrideTokens(PACKAGE_ID, tokens);
		  state.tokenSource = picked !== null ? (live !== null ? "live+pick" : "skin+pick") : live !== null ? "live" : "skin";
		  return Object.keys(tokens).length;
		}

		/**
		 * Wait until the poster can be drawn, so a measurement is never taken from an
		 * undecoded frame (which `drawImage` refuses rather than reporting as blank).
		 */
		async function decodePoster(state) {
		  const poster = state.poster;
		  if (poster === null || poster === undefined) return;
		  if (poster.complete === true || typeof poster.decode !== "function") return;
		  try {
		    await poster.decode();
		  } catch {
		    /* a poster that never decodes simply cannot be measured */
		  }
		}

		/** Re-measure the displayed frame and rebuild the live layer. */
		async function refreshLiveTokens(ctx, state) {
		  const slider = tweakSliders(state, state.skinId);
		  if (slider.uiFollow !== true || state.skinId === null) {
		    state.liveTokens = null;
		    state.liveTokensNote = null;
		    if (state.tokenSource === "live") applyTokenLayer(ctx, state);
		    publish(state, {});
		    return;
		  }
		  await decodePoster(state);
		  const measured = measureDisplayed(state, slider);
		  if (measured === null) {
		    state.liveTokens = null;
		    state.liveTokensNote = "无法采样背景像素（图层还没就绪）";
		    publish(state, {});
		    return;
		  }
		  const derived = deriveLiveTokens(measured, {});
		  state.liveTokens = derived;
		  state.liveTokensNote = derived.note;
		  state.liveTokensCheck = derived.check;
		  state.liveTokensSource = measured.measurement;
		  applyTokenLayer(ctx, state);
		  publish(state, {});
		}

		/**
		 * Derive the live layer once without applying it.
		 *
		 * This exists so a single page load can prove the pipeline works even while the
		 * switch is off: the report then carries the polarity, panel alpha and the
		 * measured contrast ratios the layer *would* use for the skin on screen. It is
		 * also the only place that exercises canvas `filter` and an untainted read of the
		 * app's own media before a user asks for them.
		 */
		async function previewLiveTokens(state) {
		  if (state.skinId === null) {
		    state.livePreview = null;
		    return;
		  }
		  try {
		    await decodePoster(state);
		    const measured = measureDisplayed(state, tweakSliders(state, state.skinId));
		    if (measured === null) {
		      state.livePreview = null;
		      return;
		    }
		    const derived = deriveLiveTokens(measured, {});
		    state.livePreview = {
		      scheme: derived.scheme,
		      alpha: derived.alpha,
		      degraded: derived.degraded,
		      check: derived.check,
		      accent: derived.accent,
		      note: derived.note,
		      source: measured.measurement,
		    };
		  } catch (error) {
		    state.livePreview = null;
		    console.warn("[dsh-skins] the live-colour preview could not be derived", error);
		  }
		}

		/** Coalesce the re-derivations a slider drag would otherwise trigger per pixel. */
		function scheduleLiveTokens(ctx, state) {
		  if (state.liveTimer !== null && state.liveTimer !== undefined) window.clearTimeout(state.liveTimer);
		  state.liveTimer = window.setTimeout(() => {
		    state.liveTimer = null;
		    refreshLiveTokens(ctx, state);
		  }, 180);
		}

		/**
		 * Paint the artwork layer.
		 *
		 * The poster is always painted first and the video sits on top of it, so a slow
		 * or refused decode never shows a black rectangle, and the reduced-motion path
		 * simply leaves the video hidden — no re-layout, no flash.
		 *
		 * @param skin - one catalog entry.
		 * @param report - the report fragment being built.
		 * @param state - the runtime state, so the media elements can be tracked for teardown.
		 * @returns the mounted layer element.
		 */
		function renderLayer(skin, report, state) {
		  const layer = document.createElement("div");
		  layer.setAttribute(LAYER_ATTRIBUTE, "");
		  layer.setAttribute("aria-hidden", "true");
		  layer.style.cssText =
		    "position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;background-color:var(--dsw-alias-bg-base)";

		  const poster = assetUrl(skin, "poster") ?? assetUrl(skin, "wallpaper") ?? assetUrl(skin, "thumb");
		  if (poster !== null) {
		    const image = document.createElement("img");
		    image.className = "skin-media skin-poster";
		    image.alt = "";
		    image.decoding = "async";
		    image.src = poster;
		    image.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block";
		    layer.append(image);
		    state.poster = image;
		    report.media = "poster";
		  }

		  if (skin.type === "video" && skin.video && typeof skin.video.src === "string") {
		    const video = document.createElement("video");
		    video.className = "skin-media skin-video";
		    // Readability first: muted is also what makes autoplay admissible at all.
		    video.muted = true;
		    video.defaultMuted = true;
		    video.loop = true;
		    video.autoplay = true;
		    video.playsInline = true;
		    video.setAttribute("muted", "");
		    video.setAttribute("playsinline", "");
		    video.setAttribute("webkit-playsinline", "");
		    video.preload = "metadata";
		    if (poster !== null) video.poster = poster;
		    video.src = skin.video.src;
		    video.style.cssText =
		      "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;z-index:1";
		    if (prefersReducedMotion()) {
		      video.style.display = "none";
		      report.media = "poster (reduced-motion)";
		    }
		    video.addEventListener("error", () => {
		      video.style.display = "none";
		      report.errors.push("video: decode error, fell back to poster");
		    });
		    // The element is the authority on transport state: autoplay can be refused,
		    // and the user can also stop it from the picture-in-picture chrome. Mirror it
		    // into the store so the panel never shows a stale button.
		    for (const event of ["play", "pause", "ratechange", "volumechange", "loadeddata"]) {
		      video.addEventListener(event, () => {
		        syncVideoState(state);
		        if (event !== "loadeddata") publish(state, {});
		      });
		    }
		    layer.append(video);
		    state.video = video;
		    report.media = prefersReducedMotion() ? "poster (reduced-motion)" : "video";
		  }

		  // The scrim is what keeps text legible over artwork; it is a gradient because
		  // a flat wash would flatten the artwork instead of sitting behind the chrome.
		  const scrim = document.createElement("div");
		  scrim.className = "skin-scrim";
		  scrim.style.cssText = "position:absolute;inset:0;z-index:2";
		  layer.append(scrim);
		  state.scrim = scrim;

		  document.body.append(layer);
		  report.layer = true;
		  return layer;
		}

		/* ------------------------------------------------------------------ *
		 * Catalog + switching
		 * ------------------------------------------------------------------ */

		/** Fetch the catalog and publish it; returns the catalog, or null when it failed. */
		async function loadCatalog(state) {
		  try {
		    const response = await fetch(CATALOG_URL, { credentials: "same-origin" });
		    const catalog = await response.json();
		    if (catalog.ok !== true) throw new Error(catalog.error ?? "catalog unavailable");
		    // A host module from before this edit answers the catalog but carries no
		    // revision, and would 404 the upload and generate routes — so "no revision"
		    // is reported as its own value rather than as agreement.
		    publish(state, {
		      catalog,
		      catalogError: null,
		      hostRevision: typeof catalog.revision === "string" ? catalog.revision : "unknown",
		    });
		    return catalog;
		  } catch (error) {
		    const message = String(error && error.message ? error.message : error);
		    console.error("[dsh-skins] catalog fetch failed", error);
		    publish(state, { catalogError: message });
		    return null;
		  }
		}

		/** Switch to `skin` (or to the fallback when null) and persist the choice. */
		async function switchTo(ctx, state, skin, reason) {
		  const report = { reason, at: new Date().toISOString(), target: skin === null ? null : skin.skinId };
		  try {
		    teardownSkin(state);
		    if (skin === null) {
		      state.skinId = null;
		      writePrefs({ skinId: null });
		      report.applied = false;
		      report.note = "reverted to the built-in theme";
		    } else {
		      report.applied = true;
		      Object.assign(report, await applySkin(ctx, state, skin));
		      writePrefs({ skinId: skin.skinId });
		    }
		    const select = state.panel ? state.panel.querySelector("select") : null;
		    if (select !== null && select !== undefined) select.value = state.skinId ?? "";
		  } catch (error) {
		    report.applied = false;
		    report.errors = [String(error && error.message ? error.message : error)];
		    // A failed skin must not leave a half-applied layer behind.
		    teardownSkin(state);
		  }
		  publish(state, {});
		  // The switch's own `reason` (manual / panel / shortcut-random) wins over the
		  // generic one, so the report says what the user actually did.
		  await sendReport(state, clientReport(state, "apply", report));
		  return report;
		}

		/** Apply whatever the catalog says is selected — used by the panel and the card grid. */
		function applyById(ctx, state, skinId) {
		  const skin = skinId === null ? null : state.catalog.skins.find((entry) => entry.skinId === skinId) ?? null;
		  return switchTo(ctx, state, skin, "panel");
		}

		/* ------------------------------------------------------------------ *
		 * Uploading new source media and generating skins
		 * ------------------------------------------------------------------ */

		/**
		 * Upload one file as a raw request body.
		 *
		 * Raw rather than multipart on purpose: the video sources are hundreds of
		 * megabytes, and streaming them means neither side ever holds one in memory.
		 * The name travels in a header, and the host half pipes the request straight
		 * into `input_image/` or `input_video/`.
		 *
		 * @param file - the File the picker or a drop produced.
		 * @param onProgress - fraction 0..1 callback.
		 * @returns the host half's JSON reply.
		 */
		function uploadFile(file, onProgress) {
		  return new Promise((resolve, reject) => {
		    const request = new XMLHttpRequest();
		    request.open("POST", UPLOAD_URL, true);
		    request.setRequestHeader("content-type", file.type || "application/octet-stream");
		    request.setRequestHeader("x-dsh-skin-filename", encodeURIComponent(file.name));
		    if (request.upload !== null && request.upload !== undefined) {
		      request.upload.addEventListener("progress", (event) => {
		        if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
		      });
		    }
		    request.addEventListener("load", () => {
		      let payload = null;
		      try {
		        payload = JSON.parse(request.responseText);
		      } catch {
		        payload = null;
		      }
		      if (request.status >= 200 && request.status < 300 && payload !== null && payload.ok === true) resolve(payload);
		      else reject(new Error((payload && payload.error ? payload.error : "HTTP " + request.status) + (payload && payload.detail ? ": " + payload.detail : "")));
		    });
		    request.addEventListener("error", () => reject(new Error("network error")));
		    request.addEventListener("abort", () => reject(new Error("aborted")));
		    request.send(file);
		  });
		}

		/* ------------------------------------------------------------------ *
		 * Measuring the media in the renderer
		 *
		 * The workspace's original analysis pass was a vision model reading the
		 * pictures and writing prose — nothing in the repo can produce that. What the
		 * renderer CAN do is read the actual pixels, so this is what an automatic skin
		 * is built from: a measured palette plus measured statistics. The prose fields
		 * say plainly that no visual judgement was made, and a later vision pass can
		 * overwrite the same record in `group_e.json` / `group_v5.json`.
		 * ------------------------------------------------------------------ */

		/** Sample edge length; 64x64 is 4096 pixels and still separates colour families. */
		const SAMPLE_SIZE = 64;

		function rgbToHsl(r, g, b) {
		  const red = r / 255;
		  const green = g / 255;
		  const blue = b / 255;
		  const max = Math.max(red, green, blue);
		  const min = Math.min(red, green, blue);
		  const lightness = (max + min) / 2;
		  const delta = max - min;
		  if (delta === 0) return { h: 0, s: 0, l: lightness };
		  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
		  let hue;
		  if (max === red) hue = ((green - blue) / delta) % 6;
		  else if (max === green) hue = (blue - red) / delta + 2;
		  else hue = (red - green) / delta + 4;
		  hue /= 6;
		  if (hue < 0) hue += 1;
		  return { h: hue, s: saturation, l: lightness };
		}

		function hslToHex(h, s, l) {
		  const channel = (n) => {
		    const k = (n + h * 12) % 12;
		    const a = s * Math.min(l, 1 - l);
		    const value = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
		    return Math.round(value * 255);
		  };
		  const hex = (value) => value.toString(16).padStart(2, "0");
		  return "#" + hex(channel(0)) + hex(channel(8)) + hex(channel(4));
		}

		function toHex(r, g, b) {
		  const hex = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
		  return "#" + hex(r) + hex(g) + hex(b);
		}

		/* --- WCAG maths, mirrored from the pipeline's skin_derive.mjs --------------- *
		 * The live UI layer must clear the same floors the shipped skins were built to,
		 * so the formula has to be the same one: WCAG 2.x relative luminance, not a
		 * perceptual shortcut.
		 * ------------------------------------------------------------------------- */

		/** Relative luminance of a `#rrggbb` colour. */
		function relativeLuminance(hex) {
		  const channel = (value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
		  const [r, g, b] = [1, 3, 5].map((at) => channel(parseInt(hex.slice(at, at + 2), 16) / 255));
		  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
		}

		/** WCAG contrast ratio between two `#rrggbb` colours (1..21). */
		function contrastRatio(a, b) {
		  const la = relativeLuminance(a);
		  const lb = relativeLuminance(b);
		  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
		}

		/** Linear blend: `weight` 1 returns `to`, 0 returns `from`. */
		function mixHex(from, to, weight) {
		  const w = clamp(weight, 0, 1);
		  const pair = [1, 3, 5].map((at) => {
		    const a = parseInt(from.slice(at, at + 2), 16);
		    const b = parseInt(to.slice(at, at + 2), 16);
		    return Math.round(a + (b - a) * w);
		  });
		  return toHex(pair[0], pair[1], pair[2]);
		}

		/** A `#rrggbb` colour at an alpha, as the token layer needs it. */
		function rgbaOf(hex, alpha) {
		  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
		  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1).toFixed(2)})`;
		}

		/** The colour the panel over the artwork actually shows, for the ladder's floor. */
		function blendedSurface(panelHex, artworkHex, alpha) {
		  return mixHex(artworkHex, panelHex, clamp(alpha, 0, 1));
		}

		/** The two text inks: one for a light panel, one for a dark panel. */
		const INK_ON_DARK = "#f2f2f5";
		const INK_ON_LIGHT = "#10131a";
		/**
		 * The label drawn on top of a filled accent is whichever ink clears 4.5:1 there.
		 * A light panel forces a *dark* accent (for its own 3:1 against the panel), and
		 * on a dark accent only white ink can do that — insisting on dark ink would make
		 * that whole half of the lightness range unusable, which is exactly the failure
		 * `verify_visual.mjs` caught on mid-grey and bright backgrounds.
		 */
		const INK_ON_ACCENT = "#10131a";
		const LABEL_ON_ACCENT_LIGHT = "#ffffff";

		/**
		 * Derive a complete, contrast-checked `--dsw-*` token layer from the pixels the
		 * user is actually looking at.
		 *
		 * Two decisions matter, and both are the reason this exists rather than reusing
		 * the shipped palette:
		 *
		 *   1. **Polarity follows the artwork, and the panel's translucency is part of
		 *      the maths.** The shell's surfaces are semi-transparent (a shipped skin
		 *      uses `rgba(base, 0.36)`), so text sits on a *blend* of the panel and the
		 *      wallpaper — not on the panel colour the build-time contrast check tested.
		 *      A bright wallpaper behind a 36%-opaque dark panel still yields a light
		 *      surface, so the ladder is scored against `mix(panel, artwork, alpha)` at
		 *      the *brighter quarter* of the frame (the dark-panel case) or its darker
		 *      quarter (the light-panel case). A background that is too light therefore
		 *      moves the text to dark ink automatically.
		 *   2. **Both scheme slots get the same values.** `overrideTokens` takes
		 *      `{ light, dark }` pairs, but here the *artwork* decides contrast, not the
		 *      application's theme preference: pinning both sides keeps the UI readable
		 *      whichever preference is active, which is the failure the shipped palette
		 *      needed a special case for.
		 *
		 * @param measured - what `measureDisplayed` read off the layer, plus the palette.
		 * @param options - panel alpha window and the contrast floors.
		 * @returns `{ tokens, scheme, alpha, degraded, note, check }`.
		 */
		function deriveLiveTokens(measured, options) {
		  const opts = Object.assign(
		    { panelAlpha: 0.36, maxAlpha: 0.62, rescueAlpha: 0.9, textFloor: 4.5, graphicFloor: 3, tertiaryFloor: 3 },
		    options ?? {},
		  );
		  const hue = measured.artworkHue;
		  const sat = measured.temperature === "neutral" ? 0.06 : 0.1;
		  const artwork = (luma) => hslToHex(hue, Math.min(0.24, measured.artworkSat), clamp(luma, 0, 1));

		  /** Score one polarity: the least opaque panel that clears every floor. */
		  const score = (scheme) => {
		    const panelBase = scheme === "dark" ? hslToHex(hue, sat + 0.02, 0.07) : hslToHex(hue, sat, 0.92);
		    const ink = scheme === "dark" ? INK_ON_DARK : INK_ON_LIGHT;
		    const worst = scheme === "dark" ? measured.luminanceP78 : measured.luminanceP22;
		    const ceiling = Math.max(opts.maxAlpha, opts.rescueAlpha);
		    let last = null;
		    for (let alpha = opts.panelAlpha; alpha <= ceiling + 1e-9; alpha += 0.02) {
		      const surface = blendedSurface(panelBase, artwork(worst), alpha);
		      const secondary = mixHex(ink, surface, scheme === "dark" ? 0.3 : 0.34);
		      const tertiary = mixHex(ink, surface, scheme === "dark" ? 0.48 : 0.52);
		      const text = contrastRatio(ink, surface);
		      const secondaryRatio = contrastRatio(secondary, surface);
		      const tertiaryRatio = contrastRatio(tertiary, surface);
		      const candidate = {
		        scheme,
		        alpha: Number(alpha.toFixed(2)),
		        panelBase,
		        ink,
		        surface,
		        secondary,
		        tertiary,
		        ratios: { text, secondary: secondaryRatio, tertiary: tertiaryRatio },
		      };
		      last = candidate;
		      const needed = scheme === "dark" ? opts.textFloor : opts.textFloor;
		      if (text >= needed && secondaryRatio >= needed && tertiaryRatio >= opts.tertiaryFloor) return candidate;
		    }
		    // Nothing cleared the floors inside the window: report the strongest attempt
		    // rather than pretending, and let the caller mark the layer degraded.
		    return Object.assign(last ?? { scheme, alpha: ceiling, panelBase, ink, ratioFail: true }, { ratioFail: true });
		  };

		  // Prefer the polarity the artwork's own luminance implies; only cross over when
		  // the implied one cannot clear its floors without hiding the wallpaper.
		  const implied = measured.luminance >= 0.5 ? "light" : "dark";
		  const preferred = score(implied);
		  const other = score(implied === "dark" ? "light" : "dark");
		  let chosen = preferred.ratioFail !== true ? preferred : other.ratioFail !== true ? other : preferred;
		  const degraded = chosen.ratios.text < opts.textFloor;

		  // ── the accent: one value, correct on the surface that is really there ─────
		  const accent = liveAccent(chosen, measured, opts);

		  // ── surfaces, borders and the interactive family ──────────────────────────
		  const dark = chosen.scheme === "dark";
		  const ladder = (step) => (dark ? hslToHex(hue, sat + 0.02, 0.07 - step) : hslToHex(hue, sat, 0.92 + step));
		  const layer1 = ladder(0.02);
		  const layer2 = ladder(0.035);
		  const layer3 = ladder(0.05);
		  const edge = dark ? "#f2efe9" : "#1c1a17";
		  const pair = (value) => ({ light: value, dark: value });
		  const tokens = {
		    "--dsw-alias-bg-base": pair(rgbaOf(chosen.panelBase, chosen.alpha)),
		    "--dsw-alias-bg-layer-1": pair(rgbaOf(layer1, Math.min(0.96, chosen.alpha + 0.06))),
		    "--dsw-alias-bg-layer-2": pair(rgbaOf(layer2, Math.min(0.96, chosen.alpha + 0.12))),
		    "--dsw-alias-bg-layer-3": pair(rgbaOf(layer3, 0.96)),
		    "--dsw-alias-bg-overlay": pair(rgbaOf(layer3, 0.96)),
		    "--dsw-alias-bg-module-platform": pair(rgbaOf(layer1, Math.min(0.96, chosen.alpha + 0.06))),
		    "--dsw-specific-sidebar-fill": pair(rgbaOf(layer1, Math.min(0.96, chosen.alpha + 0.06))),
		    "--dsw-specific-input-major": pair(rgbaOf(layer2, Math.min(0.96, chosen.alpha + 0.12))),
		    "--dsw-specific-bubble": pair(rgbaOf(layer2, Math.min(0.96, chosen.alpha + 0.12))),
		    "--dsw-alias-tooltip-bg": pair(rgbaOf(layer3, 0.96)),
		    "--dsw-alias-toast-bg": pair(rgbaOf(layer3, 0.96)),
		    "--dsw-alias-label-primary": pair(chosen.ink),
		    "--dsw-alias-label-secondary": pair(chosen.secondary),
		    "--dsw-alias-label-tertiary": pair(chosen.tertiary),
		    "--dsw-alias-label-dimmed": pair(chosen.tertiary),
		    "--dsw-alias-label-caption": pair(chosen.tertiary),
		    "--dsw-alias-label-primary-foreground": pair(accent.ink),
		    "--dsw-alias-border-l1": pair(rgbaOf(edge, dark ? 0.12 : 0.1)),
		    "--dsw-alias-border-l2": pair(rgbaOf(edge, dark ? 0.18 : 0.16)),
		    "--dsw-alias-border-l3": pair(rgbaOf(edge, dark ? 0.26 : 0.24)),
		    "--dsw-alias-brand-primary": pair(accent.color),
		    "--dsw-alias-brand-text": pair(accent.color),
		    "--dsw-alias-link": pair(accent.color),
		    "--dsw-alias-state-business-primary": pair(accent.color),
		    "--dsw-specific-sidebar-nav-item-active-accent": pair(accent.color),
		    "--dsw-alias-button-primary-fill": pair(accent.color),
		    "--dsw-alias-button-primary-hover": pair(accent.hover),
		    "--dsw-alias-interactive-bg-hover": pair(rgbaOf(accent.color, dark ? 0.2 : 0.14)),
		    "--dsw-alias-scrollbar-bg-l1": pair(rgbaOf(edge, dark ? 0.16 : 0.14)),
		    "--dsw-alias-scrollbar-hover-l1": pair(rgbaOf(edge, dark ? 0.24 : 0.22)),
		  };

		  return {
		    tokens,
		    scheme: chosen.scheme,
		    alpha: chosen.alpha,
		    surface: chosen.surface,
		    ink: chosen.ink,
		    accent: accent.color,
		    accentHue: measured.accentHue,
		    degraded,
		    check: {
		      text: Number(chosen.ratios.text.toFixed(2)),
		      secondary: Number(chosen.ratios.secondary.toFixed(2)),
		      tertiary: Number(chosen.ratios.tertiary.toFixed(2)),
		      accentOnSurface: Number(accent.ratio.toFixed(2)),
		      inkOnAccent: Number(accent.inkRatio.toFixed(2)),
		      worstLuminance: Number((chosen.scheme === "dark" ? measured.luminanceP78 : measured.luminanceP22).toFixed(3)),
		      floor: opts.textFloor,
		      graphicFloor: opts.graphicFloor,
		    },
		    note:
		      (chosen.scheme === "dark" ? "深色面板 + 浅色文字" : "浅色面板 + 深色文字") +
		      " · 面板 α " + chosen.alpha.toFixed(2) +
		      " · 文字对比 " + chosen.ratios.text.toFixed(2) + ":1" +
		      (degraded ? "（已达可达上限）" : ""),
		  };
		}

		/**
		 * The accent for a surface that is already known.
		 *
		 * Sweeps the full lightness range instead of walking one direction, because the
		 * feasible window sits on opposite sides of the surface depending on polarity: a
		 * dark panel needs a light accent, a light panel needs a dark one. Inside the
		 * window the value closest to the artwork's own accent wins, so the UI keeps the
		 * picture's colour rather than a generic one. Each candidate carries the ink that
		 * actually wins on it, and when nothing is feasible the best-scoring candidate is
		 * returned rather than an arbitrary one — a near miss beats a wild guess.
		 */
		function liveAccent(chosen, measured, opts) {
		  const sat = clamp(Math.max(0.32, measured.accentSat), 0.32, 0.62);
		  const feasible = [];
		  let best = null;
		  for (let step = 0; step <= 60; step += 1) {
		    const lightness = 0.08 + step * 0.014;
		    const candidate = hslToHex(measured.accentHue, sat, lightness);
		    const onSurface = contrastRatio(candidate, chosen.surface);
		    const darkInk = contrastRatio(INK_ON_ACCENT, candidate);
		    const lightInk = contrastRatio(LABEL_ON_ACCENT_LIGHT, candidate);
		    const ink = darkInk >= lightInk ? { color: INK_ON_ACCENT, ratio: darkInk } : { color: LABEL_ON_ACCENT_LIGHT, ratio: lightInk };
		    const row = { color: candidate, onSurface, ink, lightness };
		    if (onSurface >= opts.graphicFloor && ink.ratio >= opts.textFloor) feasible.push(row);
		    // How far this candidate is from clearing both floors, in floor units.
		    const score = Math.min(onSurface / opts.graphicFloor, ink.ratio / opts.textFloor);
		    if (best === null || score > best.score) best = { row, score };
		  }
		  const pick =
		    feasible.length === 0
		      ? best.row
		      : feasible.reduce((a, b) => (Math.abs(b.lightness - measured.accentLightness) < Math.abs(a.lightness - measured.accentLightness) ? b : a));
		  // A light accent hovers lighter, a dark one hovers darker.
		  const hover = hslToHex(measured.accentHue, sat, clamp(pick.lightness + (pick.lightness > 0.5 ? 0.08 : -0.06), 0.05, 0.95));
		  return {
		    color: pick.color,
		    hover,
		    ink: pick.ink.color,
		    ratio: pick.onSurface,
		    inkRatio: pick.ink.ratio,
		    lightness: pick.lightness,
		    feasible: feasible.length > 0,
		  };
		}

		/** One sampled frame → measured statistics and a quantised palette. */
		function analyzeSample(data, width, height) {
		  const buckets = new Map();
		  // A 32-bucket lightness histogram, filled per pixel so the percentiles live on
		  // the same scale as `luminance` (HSL lightness, not gamma-corrected luma). The
		  // live UI layer needs the bright and dark quarters of the frame, because text
		  // sits on a translucent panel over exactly those pixels.
		  const histogram = new Array(32).fill(0);
		  let lumaSum = 0;
		  let lumaSq = 0;
		  let satSum = 0;
		  let warmth = 0;
		  let edge = 0;
		  let edgeCount = 0;
		  for (let y = 0; y < height; y += 1) {
		    for (let x = 0; x < width; x += 1) {
		      const i = (y * width + x) * 4;
		      const r = data[i];
		      const g = data[i + 1];
		      const b = data[i + 2];
		      const hsl = rgbToHsl(r, g, b);
		      lumaSum += hsl.l;
		      lumaSq += hsl.l * hsl.l;
		      satSum += hsl.s;
		      warmth += (r - b) / 255;
		      histogram[Math.min(31, Math.max(0, Math.floor(hsl.l * 32)))] += 1;
		      if (x > 0 && y > 0) {
		        const left = i - 4;
		        const up = i - width * 4;
		        edge +=
		          (Math.abs(r - data[left]) + Math.abs(g - data[left + 1]) + Math.abs(b - data[left + 2]) +
		            Math.abs(r - data[up]) + Math.abs(g - data[up + 1]) + Math.abs(b - data[up + 2])) /
		          (6 * 255);
		        edgeCount += 1;
		      }
		      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
		      const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
		      bucket.count += 1;
		      bucket.r += r;
		      bucket.g += g;
		      bucket.b += b;
		      buckets.set(key, bucket);
		    }
		  }
		  const total = width * height;
		  const mean = lumaSum / total;
		  const percentile = (fraction) => {
		    const target = fraction * total;
		    let seen = 0;
		    for (let index = 0; index < histogram.length; index += 1) {
		      seen += histogram[index];
		      if (seen >= target) return (index + 0.5) / histogram.length;
		    }
		    return 1;
		  };
		  const list = [];
		  for (const bucket of buckets.values()) {
		    const r = bucket.r / bucket.count;
		    const g = bucket.g / bucket.count;
		    const b = bucket.b / bucket.count;
		    const hsl = rgbToHsl(r, g, b);
		    list.push({ share: bucket.count / total, hex: toHex(r, g, b), h: hsl.h, s: hsl.s, l: hsl.l });
		  }
		  list.sort((a, b) => b.share - a.share);
		  return {
		    width,
		    height,
		    total,
		    luminance: mean,
		    luminanceP10: percentile(0.1),
		    luminanceP22: percentile(0.22),
		    luminanceP78: percentile(0.78),
		    luminanceP90: percentile(0.9),
		    contrast: Math.sqrt(Math.max(0, lumaSq / total - mean * mean)),
		    saturation: satSum / total,
		    warmth: warmth / total,
		    edgeEnergy: edgeCount === 0 ? 0 : edge / edgeCount,
		    buckets: list,
		  };
		}

		/** Pick the record's colours from the measured buckets. */
		function pickPalette(stats) {
		  const buckets = stats.buckets.filter((bucket) => bucket.share >= 0.002);
		  const mids = buckets.filter((bucket) => bucket.l >= 0.1 && bucket.l <= 0.92);
		  const primary = mids[0] ?? buckets[0] ?? { hex: "#7a7a7a", h: 0.6, s: 0.1, l: 0.5 };
		  const ranked = buckets.slice().sort((a, b) => b.s * Math.sqrt(b.share) - a.s * Math.sqrt(a.share));
		  const accent = ranked.find((bucket) => bucket.s >= 0.16 && bucket.l >= 0.18 && bucket.l <= 0.86) ?? primary;
		  const secondaries = [];
		  for (const bucket of buckets) {
		    if (bucket.hex === primary.hex || bucket.hex === accent.hex) continue;
		    if (secondaries.includes(bucket.hex)) continue;
		    secondaries.push(bucket.hex);
		    if (secondaries.length === 3) break;
		  }
		  const desaturated = buckets.slice().sort((a, b) => a.s - b.s).slice(0, 3).map((bucket) => bucket.hex);
		  const neutrals = [];
		  for (const hex of [toHex(0, 0, 0), primary.hex, ...desaturated, toHex(255, 255, 255)]) {
		    if (!neutrals.includes(hex)) neutrals.push(hex);
		    if (neutrals.length === 3) break;
		  }
		  return { primary, accent, secondaries, neutrals };
		}

		/** Turn measurements into the analysis record the build pipeline asks for. */
		function buildRecord(measured, scan) {
		  const stats = measured.stats;
		  const palette = pickPalette(stats);
		  const luminance = Number(stats.luminance.toFixed(3));
		  const saturation = stats.saturation < 0.25 ? "muted" : stats.saturation < 0.5 ? "balanced" : "vivid";
		  const temperature = stats.warmth > 0.04 ? "warm" : stats.warmth < -0.04 ? "cool" : "neutral";
		  const contrast = stats.contrast < 0.1 ? "low" : stats.contrast < 0.22 ? "medium" : "high";
		  const busyness = stats.edgeEnergy < 0.06 ? "calm" : stats.edgeEnergy < 0.16 ? "moderate" : "busy";
		  const scheme = luminance >= 0.5 ? "light" : "dark";
		  const surface = hslToHex(palette.primary.h, 0.07, scheme === "dark" ? 0.08 : 0.92);
		  const luminanceWord = luminance < 0.25 ? "低照度" : luminance < 0.6 ? "中间调" : "高调";
		  const busynessWord = busyness === "calm" ? "平滑" : busyness === "moderate" ? "适中" : "繁复";
		  const temperatureWord = temperature === "warm" ? "暖调" : temperature === "cool" ? "冷调" : "中性调";
		  const measuredLine = `均亮 ${luminance.toFixed(2)} · 对比 ${contrast} · 饱和 ${saturation} · ${temperatureWord} · ${busynessWord} · 边能量 ${stats.edgeEnergy.toFixed(3)}`;
		  const record = {
		    file: scan.name,
		    autoMeasured: true,
		    firstImpression: `自动像素测量（未经视觉分析）：主色 ${palette.primary.hex}，强调色 ${palette.accent.hex}；${measuredLine}。`,
		    size: `${measured.native.width}x${measured.native.height}`,
		    primaryColor: palette.primary.hex,
		    secondaryColors: palette.secondaries.length > 0 ? palette.secondaries : [palette.primary.hex],
		    accentColor: palette.accent.hex,
		    neutrals: palette.neutrals,
		    luminance,
		    contrast,
		    saturation,
		    temperature,
		    material: "未做材质鉴定（自动像素测量）",
		    lighting: `${luminanceWord}，${measuredLine}`,
		    composition: `画幅 ${measured.native.width}×${measured.native.height}，屏幕取样 ${stats.width}×${stats.height}；${busynessWord}的明暗分布。`,
		    busyness,
		    styleKeywords: ["自动测量", temperatureWord, saturation === "vivid" ? "浓色" : saturation === "balanced" ? "匀色" : "淡色", busynessWord],
		    mood: [],
		    backgroundSuitability: {
		      dark: luminance <= 0.45 ? `good，实测均亮 ${luminance.toFixed(2)}，深色面板可以压住背景` : `workable，实测偏亮（均亮 ${luminance.toFixed(2)}），深色面板需靠遮罩平衡`,
		      light: luminance >= 0.45 ? `good，实测均亮 ${luminance.toFixed(2)}，浅色面板与背景同向` : `workable，实测偏暗（均亮 ${luminance.toFixed(2)}），浅色面板需描边分离`,
		    },
		    paletteProposal: {
		      accent: palette.accent.hex,
		      surface,
		      companion: palette.secondaries[0] ?? palette.primary.hex,
		      scheme,
		      rationale: `${measuredLine}；强调色取自占比最高的高饱和色块 ${palette.accent.hex}，面板底色由主色 ${palette.primary.hex} 的色相派生。`,
		    },
		  };
		  if (scan.kind === "video") {
		    const lumas = measured.frames.map((frame) => frame.luminance);
		    const drift = Math.max(...lumas) - Math.min(...lumas);
		    record.frameCount = measured.frames.length;
		    record.sampledTimes = measured.times;
		    record.frameDrift = drift > 0.22 ? "large" : "small";
		    record.motionNote = `${measured.frames.length} 帧实测均亮范围 ${Math.min(...lumas).toFixed(2)}~${Math.max(...lumas).toFixed(2)}（漂移 ${drift.toFixed(2)}）。`;
		    record.posterAdvice = `取第 ${measured.bestIndex + 1} 帧（t=${measured.bestTime.toFixed(2)}s）：均亮最接近 0.45。`;
		  }
		  return record;
		}

		/** Decode an image file and sample it down to `SAMPLE_SIZE` square. */
		async function sampleFromImage(file) {
		  const bitmap = await new Promise((resolve, reject) => {
		    const image = new Image();
		    image.onload = () => resolve(image);
		    image.onerror = () => reject(new Error("image decode failed"));
		    image.src = URL.createObjectURL(file);
		  });
		  try {
		    const canvas = document.createElement("canvas");
		    canvas.width = SAMPLE_SIZE;
		    canvas.height = SAMPLE_SIZE;
		    const context = canvas.getContext("2d", { willReadFrequently: true });
		    context.drawImage(bitmap, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
		    const data = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
		    return {
		      native: { width: bitmap.naturalWidth || bitmap.width, height: bitmap.naturalHeight || bitmap.height },
		      stats: analyzeSample(data, SAMPLE_SIZE, SAMPLE_SIZE),
		    };
		  } finally {
		    if (typeof bitmap.src === "string" && bitmap.src.startsWith("blob:")) URL.revokeObjectURL(bitmap.src);
		  }
		}

		/** Seek a video element and wait for the frame to be paintable. */
		function seekVideo(video, time) {
		  return new Promise((resolve, reject) => {
		    const onSeeked = () => {
		      video.removeEventListener("seeked", onSeeked);
		      resolve();
		    };
		    video.addEventListener("seeked", onSeeked);
		    const timer = window.setTimeout(() => {
		      video.removeEventListener("seeked", onSeeked);
		      reject(new Error("seek timed out"));
		    }, 8000);
		    video.addEventListener("seeked", () => window.clearTimeout(timer), { once: true });
		    video.currentTime = time;
		  });
		}

		/** Decode a video's sampled frames, measure them, and keep the best as a poster. */
		async function sampleFromVideo(file, onProgress) {
		  const video = document.createElement("video");
		  video.muted = true;
		  video.playsInline = true;
		  video.preload = "auto";
		  video.src = URL.createObjectURL(file);
		  const cleanup = () => {
		    try {
		      URL.revokeObjectURL(video.src);
		    } catch {
		      /* ignore */
		    }
		  };
		  await new Promise((resolve, reject) => {
		    const timer = window.setTimeout(() => reject(new Error("video metadata timed out")), 20000);
		    video.addEventListener("loadeddata", () => {
		      window.clearTimeout(timer);
		      resolve();
		    }, { once: true });
		    video.addEventListener("error", () => {
		      window.clearTimeout(timer);
		      reject(new Error("video decode failed"));
		    }, { once: true });
		  });
		  try {
		    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
		    const fractions = [0.08, 0.35, 0.62, 0.9];
		    const times = fractions.map((fraction) => Math.max(0, Math.min(duration > 0 ? duration - 0.05 : 0, fraction * duration)));
		    const canvas = document.createElement("canvas");
		    canvas.width = SAMPLE_SIZE;
		    canvas.height = SAMPLE_SIZE;
		    const context = canvas.getContext("2d", { willReadFrequently: true });
		    const frames = [];
		    const measuredTimes = [];
		    let index = 0;
		    for (const time of times) {
		      index += 1;
		      onProgress(index / (times.length + 1));
		      try {
		        await seekVideo(video, time);
		      } catch {
		        continue;
		      }
		      context.drawImage(video, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
		      frames.push(analyzeSample(context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data, SAMPLE_SIZE, SAMPLE_SIZE));
		      measuredTimes.push(Number(time.toFixed(2)));
		    }
		    if (frames.length === 0) throw new Error("no frame could be sampled");
		    // Average the frames for the record; keep the frame closest to mid-grey as
		    // the poster, because a poster is what the reduced-motion path shows.
		    const average = (pick) => frames.reduce((sum, frame) => sum + pick(frame), 0) / frames.length;
		    const stats = Object.assign({}, frames[0], {
		      luminance: average((frame) => frame.luminance),
		      contrast: average((frame) => frame.contrast),
		      saturation: average((frame) => frame.saturation),
		      warmth: average((frame) => frame.warmth),
		      edgeEnergy: average((frame) => frame.edgeEnergy),
		      buckets: frames.flatMap((frame) => frame.buckets).sort((a, b) => b.share - a.share).slice(0, 40),
		    });
		    let bestIndex = 0;
		    let bestScore = Number.POSITIVE_INFINITY;
		    frames.forEach((frame, at) => {
		      const score = Math.abs(frame.luminance - 0.45) - frame.contrast * 0.5;
		      if (score < bestScore) {
		        bestScore = score;
		        bestIndex = at;
		      }
		    });
		    onProgress(0.95);
		    await seekVideo(video, measuredTimes[bestIndex] ?? 0);
		    const posterCanvas = document.createElement("canvas");
		    const scale = Math.min(1, 1280 / (video.videoWidth || 1280));
		    posterCanvas.width = Math.max(2, Math.round((video.videoWidth || 1280) * scale));
		    posterCanvas.height = Math.max(2, Math.round((video.videoHeight || 720) * scale));
		    posterCanvas.getContext("2d").drawImage(video, 0, 0, posterCanvas.width, posterCanvas.height);
		    const poster = await new Promise((resolve) => posterCanvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.92));
		    onProgress(1);
		    return {
		      native: { width: video.videoWidth || 0, height: video.videoHeight || 0, duration },
		      stats,
		      frames,
		      times: measuredTimes,
		      bestIndex,
		      bestTime: measuredTimes[bestIndex] ?? 0,
		      poster,
		    };
		  } finally {
		    cleanup();
		  }
		}

		/**
		 * Send a video's measured poster frame, so a skin can be built for a video the
		 * headless frame extractor never touched. The host half writes it in the same
		 * report shape the extractor produces, and skips this when a real report exists.
		 */
		function uploadPoster(name, poster, facts) {
		  return new Promise((resolve, reject) => {
		    const request = new XMLHttpRequest();
		    request.open("POST", ROUTE + "/frames/" + encodeURIComponent(name), true);
		    request.setRequestHeader("content-type", poster.type || "image/jpeg");
		    request.setRequestHeader("x-dsh-poster-at", String(facts.atSeconds));
		    request.setRequestHeader("x-dsh-video-width", String(facts.width));
		    request.setRequestHeader("x-dsh-video-height", String(facts.height));
		    request.setRequestHeader("x-dsh-video-duration", String(facts.duration));
		    request.addEventListener("load", () => {
		      let payload = null;
		      try {
		        payload = JSON.parse(request.responseText);
		      } catch {
		        payload = null;
		      }
		      if (request.status >= 200 && request.status < 300 && payload !== null && payload.ok === true) resolve(payload);
		      else reject(new Error(payload && payload.error ? payload.error : "HTTP " + request.status));
		    });
		    request.addEventListener("error", () => reject(new Error("network error")));
		    request.send(poster);
		  });
		}

		/** Ask the host half to run the skin pipeline, then poll it to completion. */
		async function startGenerate(state, records) {
		  if (state.job !== null && state.job !== undefined && state.job.status === "running") return;
		  publish(state, { job: { status: "starting", log: "", startedAt: new Date().toISOString(), newSkins: [] } });
		  let payload;
		  try {
		    const response = await fetch(GENERATE_URL, {
		      method: "POST",
		      credentials: "same-origin",
		      headers: { "content-type": "application/json" },
		      body: JSON.stringify({ records: records ?? {} }),
		    });
		    payload = await response.json();
		  } catch (error) {
		    publish(state, { job: { status: "failed", message: "generate request failed: " + String(error && error.message ? error.message : error) } });
		    return;
		  }
		  if (payload.ok !== true) {
		    publish(state, { job: { status: "failed", message: payload.error ?? "generate refused", detail: payload.detail ?? null } });
		    return;
		  }
		  publish(state, { job: payload.job });
		  // Roughly 45 minutes of patience: the video branch re-encodes posters.
		  for (let attempt = 0; attempt < 1800; attempt += 1) {
		    await new Promise((resolve) => window.setTimeout(resolve, 1500));
		    let current;
		    try {
		      const response = await fetch(JOB_URL, { credentials: "same-origin" });
		      current = await response.json();
		    } catch (error) {
		      publish(state, { job: { status: "failed", message: "job poll failed: " + String(error && error.message ? error.message : error) } });
		      return;
		    }
		    publish(state, { job: current.job });
		    if (current.job === null || current.job === undefined || current.job.status !== "running") {
		      if (current.job !== null && current.job !== undefined && current.job.status === "succeeded") await loadCatalog(state);
		      return;
		    }
		  }
		  publish(state, { job: { status: "failed", message: "timed out waiting for the pipeline" } });
		}

		/* ------------------------------------------------------------------ *
		 * Panel styling — dsw tokens only, so the panel follows the app's dark theme
		 * and the applied skin's own palette at the same time.
		 * ------------------------------------------------------------------ */

		const PANEL_CSS = [
		  ".dsh-skins-panel{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5}",
		  ".dsh-skins-panel *{box-sizing:border-box}",
		  ".dsh-skins-scroll{flex:1;min-height:0;overflow:auto;padding:10px 12px 18px;scrollbar-gutter:stable}",
		  ".dsh-skins-note{color:var(--dsw-alias-label-tertiary);font-size:11px;margin:0 0 10px}",
		  ".dsh-skins-warn{color:var(--dsw-alias-state-warn-primary);font-size:11px;margin:0 0 10px}",
		  ".dsh-skins-err{color:var(--dsw-alias-state-error-primary);font-size:11px;margin:6px 0 0;word-break:break-word}",
		  ".dsh-skins-section{margin:0 0 18px}",
		  ".dsh-skins-section__head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0 0 8px}",
		  ".dsh-skins-section__title{font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);text-transform:none}",
		  ".dsh-skins-section__note{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
		  ".dsh-skins-now{display:flex;align-items:center;gap:10px;padding:10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}",
		  ".dsh-skins-now__thumb{width:44px;height:30px;flex:none;border-radius:var(--dsw-radius-sm);overflow:hidden;background:var(--dsw-alias-bg-layer-2)}",
		  ".dsh-skins-now__thumb img{width:100%;height:100%;object-fit:cover;display:block}",
		  ".dsh-skins-now__text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}",
		  ".dsh-skins-now__name{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
		  ".dsh-skins-now__meta{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
		  ".dsh-skins-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
		  ".dsh-skins-btn{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:4px 10px;cursor:pointer;white-space:nowrap}",
		  ".dsh-skins-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
		  ".dsh-skins-btn:disabled{color:var(--dsw-alias-label-quaternary,var(--dsw-alias-label-tertiary));cursor:default;opacity:.6}",
		  ".dsh-skins-btn--primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}",
		  ".dsh-skins-seg{display:inline-flex;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);overflow:hidden}",
		  ".dsh-skins-seg button{font:inherit;font-size:11px;color:var(--dsw-alias-label-secondary);background:transparent;border:0;padding:3px 9px;cursor:pointer}",
		  ".dsh-skins-seg button[data-on=true]{background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}",
		  ".dsh-skins-input{width:100%;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:4px 8px;outline:none}",
		  ".dsh-skins-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px}",
		  ".dsh-skins-card{display:flex;flex-direction:column;gap:0;padding:0;overflow:hidden;cursor:pointer;text-align:left;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);color:inherit;font:inherit}",
		  ".dsh-skins-card:hover{background:var(--dsw-alias-interactive-bg-hover)}",
		  ".dsh-skins-card[data-active=true]{border-color:var(--dsw-alias-brand-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}",
		  ".dsh-skins-card__media{display:block;width:100%;aspect-ratio:16/10;background:var(--dsw-alias-bg-layer-2);overflow:hidden}",
		  ".dsh-skins-card__media img{width:100%;height:100%;object-fit:cover;display:block}",
		  ".dsh-skins-card__meta{display:flex;align-items:center;gap:4px;padding:5px 7px 6px}",
		  ".dsh-skins-card__name{flex:1;min-width:0;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
		  ".dsh-skins-card__badge{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary)}",
		  ".dsh-skins-field{margin:0 0 12px}",
		  ".dsh-skins-field__head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin:0 0 4px}",
		  ".dsh-skins-field__label{font-size:12px;color:var(--dsw-alias-label-secondary)}",
		  ".dsh-skins-field__value{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
		  ".dsh-skins-range{width:100%;margin:0;accent-color:var(--dsw-alias-brand-primary);background:transparent}",
		  ".dsh-skins-range:disabled{opacity:.5}",
		  // switches: the same track/knob idea the shell uses, built from tokens
		  ".dsh-skins-subhead{margin:2px 0 8px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l1);font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
		  ".dsh-skins-toggle__row{display:flex;align-items:center;justify-content:space-between;gap:10px}",
		  ".dsh-skins-toggle__hint{margin:3px 0 0;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary)}",
		  ".dsh-skins-switch{position:relative;flex:none;width:34px;height:18px;padding:0;cursor:pointer;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));border:.5px solid var(--dsw-alias-border-l2);border-radius:9999px;transition:background 140ms ease,border-color 140ms ease}",
		  ".dsh-skins-switch:disabled{cursor:default;opacity:.5}",
		  ".dsh-skins-switch[data-on=true]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}",
		  ".dsh-skins-switch__knob{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:9999px;background:var(--dsw-alias-label-primary);transition:transform 140ms cubic-bezier(0.32,0.08,0.24,1),background 140ms ease}",
		  ".dsh-skins-switch[data-on=true] .dsh-skins-switch__knob{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground,#fff)}",
		  ".dsh-skins-switch:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
		  // automation rows
		  ".dsh-skins-auto-block{margin:0 0 10px;display:flex;flex-direction:column;gap:6px}",
		  ".dsh-skins-auto-grid{display:grid;grid-template-columns:auto 1fr;gap:6px;align-items:center}",
		  ".dsh-skins-auto-label{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}",
		  ".dsh-skins-select{font:inherit;font-size:11px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:3px 6px;min-width:0;width:100%}",
		  ".dsh-skins-select:disabled{opacity:.5}",
		  ".dsh-skins-time{width:auto;flex:0 0 92px;font-size:11px;color-scheme:dark}",
		  ".dsh-skins-number{width:64px;flex:0 0 64px;font-size:11px}",
		  ".dsh-skins-drop{display:flex;flex-direction:column;gap:8px;padding:10px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}",
		  ".dsh-skins-drop[data-over=true]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover)}",
		  ".dsh-skins-up{display:flex;flex-direction:column;gap:3px;font-size:11px}",
		  ".dsh-skins-up__row{display:flex;justify-content:space-between;gap:8px}",
		  ".dsh-skins-up__bar{height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));overflow:hidden}",
		  ".dsh-skins-up__bar > i{display:block;height:100%;background:var(--dsw-alias-brand-primary)}",
		  ".dsh-skins-log{margin:6px 0 0;max-height:150px;overflow:auto;font-family:var(--dsw-font-family-mono,ui-monospace,Consolas,monospace);font-size:10.5px;line-height:1.45;white-space:pre-wrap;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:6px 8px}",
		  // one line for the whole pipeline
		  ".dsh-skins-progress{margin:0 0 10px;padding:5px 8px;font-size:11px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-brand-primary);border-radius:var(--dsw-radius-sm)}",
		  // the drop zone
		  ".dsh-skins-drop__hint{margin:0 0 2px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}",
		  ".dsh-skins-drop__sub{margin:0 0 8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
		  ".dsh-skins-drop[data-over=true]{border-color:var(--dsw-alias-brand-primary);border-style:solid;background:var(--dsw-alias-interactive-bg-hover);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}",
		  ".dsh-skins-drop[data-over=true] .dsh-skins-drop__hint{color:var(--dsw-alias-brand-primary)}",
		  ".dsh-skins-drop[data-busy=true]{opacity:.75}",
		  // upload rows
		  ".dsh-skins-up__row{display:grid;grid-template-columns:1fr auto auto;gap:6px;align-items:center}",
		  ".dsh-skins-up__name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
		  ".dsh-skins-up__bar{width:56px}",
		  ".dsh-skins-up__state{color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
		  ".dsh-skins-up__row[data-status=failed] .dsh-skins-up__state{color:var(--dsw-alias-state-error-primary)}",
		  ".dsh-skins-up__row[data-status=done] .dsh-skins-up__state{color:var(--dsw-alias-state-success-primary)}",
		  // the job's step checklist
		  ".dsh-skins-steps{margin:8px 0 0;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);overflow:hidden}",
		  ".dsh-skins-step{display:grid;grid-template-columns:14px 1fr auto;gap:6px;align-items:center;padding:3px 8px;font-size:11px;color:var(--dsw-alias-label-secondary)}",
		  ".dsh-skins-step + .dsh-skins-step{border-top:.5px solid var(--dsw-alias-border-l1)}",
		  ".dsh-skins-step__mark{color:var(--dsw-alias-label-quaternary,var(--dsw-alias-label-tertiary));text-align:center}",
		  ".dsh-skins-step[data-status=ok] .dsh-skins-step__mark{color:var(--dsw-alias-state-success-primary)}",
		  ".dsh-skins-step[data-status=failed] .dsh-skins-step__mark{color:var(--dsw-alias-state-error-primary)}",
		  ".dsh-skins-step[data-status=running] .dsh-skins-step__mark{color:var(--dsw-alias-brand-primary)}",
		  ".dsh-skins-step__title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
		  ".dsh-skins-step__ms{font-size:10px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
		  // tag filter
		  ".dsh-skins-tagpicker{display:flex;flex-direction:column;gap:6px;flex:1 1 130px;min-width:0}",
		  ".dsh-skins-caret{margin-left:4px;font-size:9px;color:var(--dsw-alias-label-tertiary)}",
		  ".dsh-skins-tagpanel{display:flex;flex-direction:column;gap:6px;padding:8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}",
		  ".dsh-skins-taglist{display:flex;flex-wrap:wrap;gap:4px;max-height:168px;overflow:auto;align-content:flex-start}",
		  ".dsh-skins-tag{display:inline-flex;align-items:baseline;gap:4px;font:inherit;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l3);border-radius:9999px;padding:2px 8px;cursor:pointer;max-width:100%}",
		  ".dsh-skins-tag:hover{background:var(--dsw-alias-interactive-bg-hover)}",
		  ".dsh-skins-tag[data-on=true]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover)}",
		  ".dsh-skins-tag__label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
		  ".dsh-skins-tag__count{font-size:9.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
		  ".dsh-skins-chip{display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:11px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));border:.5px solid var(--dsw-alias-brand-primary);border-radius:9999px;padding:2px 8px;cursor:pointer}",
		  ".dsh-skins-chip__x{color:var(--dsw-alias-label-tertiary)}",
		  ".dsh-skins-btn[data-on=true]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover)}",
		  // favourite toggle on a card
		  ".dsh-skins-card__media{position:relative}",
		  ".dsh-skins-card__fav{position:absolute;top:4px;right:4px;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;padding:0;cursor:pointer;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb, var(--dsw-alias-bg-base) 62%, transparent);border:.5px solid var(--dsw-alias-border-l3);border-radius:9999px;opacity:.55;transition:opacity 120ms ease}",
		  ".dsh-skins-card:hover .dsh-skins-card__fav{opacity:1}",
		  ".dsh-skins-card__fav:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
		  ".dsh-skins-card__fav[data-on=true]{opacity:1;color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}",
		  ".dsh-skins-card:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
		  ".dsh-skins-card[data-favorite=true]{border-color:var(--dsw-alias-border-l2)}",
		  // the export affordance on a card, tucked under the heart
		  ".dsh-skins-card__pack{position:absolute;top:4px;right:26px;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;padding:0;cursor:pointer;font-size:12px;line-height:1;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb, var(--dsw-alias-bg-base) 62%, transparent);border:.5px solid var(--dsw-alias-border-l3);border-radius:9999px;opacity:0;transition:opacity 120ms ease}",
		  ".dsh-skins-card:hover .dsh-skins-card__pack{opacity:.75}",
		  ".dsh-skins-card__pack:hover{opacity:1;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
		  ".dsh-skins-card__pack:focus-visible{opacity:1;outline:1px solid var(--dsw-alias-brand-primary)}",
		  // the cleanup preview list
		  ".dsh-skins-cleanlist{margin:6px 0 0;max-height:150px;overflow:auto;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}",
		  ".dsh-skins-cleanrow{display:flex;justify-content:space-between;gap:8px;padding:2px 8px;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
		  ".dsh-skins-cleanrow + .dsh-skins-cleanrow{border-top:.5px solid var(--dsw-alias-border-l1)}",
		  // focus mode: the shell's columns are hidden, the panel's own chain is *promoted*
		  // to a floating dock rather than hidden (the page lives inside the sidebar), and
		  // the artwork layer is never touched — not its display, not its z-index.
		  "[" + FOCUS_ATTRIBUTE + "]{display:none !important}",
		  "html[data-dsh-focus] body{background-color:transparent !important}",
		  // Windows: the strip across the top (and its top-right corner) is page paint,
		  // not native chrome — it is the frame's own `padding-top` plus its `::before`
		  // rule, so it is not in the hidden set and would otherwise stay as a grey band
		  // over the artwork. Selectors match the *suffix* of the CSS-module class name
		  // (`_frame`), never a baked-in hash prefix: 0.2.0 used `BynINW_frame` and
		  // 0.2.1 renamed the prefix to `mP3x-q_frame`, which is exactly how the strip
		  // came back after the upgrade. Clearing both keeps the drag region alive (the
		  // pseudo-element keeps `-webkit-app-region: drag`) and lets the artwork reach
		  // the top edge. The window buttons themselves are Electron's overlay, drawn
		  // above the page, so CSS can hide the band but not the buttons.
		  "html[data-dsh-focus][data-windows-titlebar] [class*=\"_frame\"]:not([data-dsh-skin-layer]){padding-top:0 !important;background:transparent !important}",
		  "html[data-dsh-focus][data-windows-titlebar] [class*=\"_frame\"]:not([data-dsh-skin-layer])::before{background:transparent !important}",
		  // Fullscreen drops the titlebar attribute's layout, but the frame still owns
		  // its background; clearing it in both states keeps the artwork full-bleed.
		  "html[data-dsh-focus] [class*=\"_frame\"]:not([data-dsh-skin-layer]){background:transparent !important}",
		  // Keep the promoted panel clear of those native buttons: they sit in the
		  // top-right ~40px band, so the lane starts below it instead of under it.
		  "html[data-dsh-focus][data-windows-titlebar] [data-dsh-skin-lane]{padding-top:calc(10px + var(--dsh-windows-titlebar-height, 40px)) !important}",
		  "html[data-dsh-focus] [" +
		    LANE_ATTRIBUTE +
		    "]{position:fixed !important;top:0 !important;right:0 !important;bottom:0 !important;left:auto !important;width:min(420px,100vw) !important;min-width:0 !important;max-width:none !important;height:auto !important;margin:0 !important;padding:10px 12px !important;gap:0 !important;background:transparent !important;border:0 !important;border-radius:0 !important;box-shadow:none !important;display:block !important;overflow:auto !important;z-index:40 !important}",
		  "html[data-dsh-focus] [" + LANE_ATTRIBUTE + "] .dsh-skins-panel{height:auto !important;min-height:0 !important}",
		  "html[data-dsh-focus] .dsh-skins-panel{box-shadow:none}",
		  // the developer stylesheet editor
		  ".dsh-skins-css{display:block;width:100%;box-sizing:border-box;margin:6px 0 0;padding:6px 8px;font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);resize:vertical;tab-size:2}",
		  ".dsh-skins-css:focus{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:-1px}",
		  ".dsh-skins-cssissues{margin:6px 0 0;max-height:130px;overflow:auto;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}",
		  ".dsh-skins-cssissue{padding:2px 8px;font-size:11px;color:var(--dsw-alias-state-error-primary,#e5484d)}",
		  ".dsh-skins-cssissue--warn{color:var(--dsw-alias-state-warning-primary,#e5a13d)}",
		  // library management: the info badge, selection, drag affordances, the log
		  ".dsh-skins-card__info{position:absolute;top:4px;left:4px;display:flex;gap:4px;align-items:center;padding:1px 6px;border-radius:9999px;font-size:10px;line-height:1.5;color:#fff;background:rgba(0,0,0,0.62);border:.5px solid rgba(255,255,255,0.22);backdrop-filter:blur(4px);pointer-events:none;white-space:nowrap}",
		  ".dsh-skins-card__info[data-kind=rendition]{background:rgba(28,110,72,0.72)}",
		  ".dsh-skins-card__info[data-kind=original]{background:rgba(120,72,20,0.7)}",
		  ".dsh-skins-card__size{font-variant-numeric:tabular-nums;opacity:.9}",
		  ".dsh-skins-card__del{position:absolute;bottom:4px;right:4px;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;padding:0;cursor:pointer;font-size:12px;line-height:1;color:#ff9a9a;background:rgba(0,0,0,0.55);border:.5px solid rgba(255,120,120,0.45);border-radius:9999px;opacity:0;transition:opacity 120ms ease}",
		  ".dsh-skins-card:hover .dsh-skins-card__del{opacity:.8}",
		  ".dsh-skins-card__del:hover{opacity:1;background:rgba(190,40,40,0.7);color:#fff}",
		  ".dsh-skins-card__check{position:absolute;top:4px;right:4px;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border-radius:5px;font-size:12px;color:#fff;background:rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.5)}",
		  ".dsh-skins-card__check[data-on=true]{background:var(--dsw-alias-brand-primary,#4c8dff);border-color:transparent}",
		  ".dsh-skins-card[data-selected=true]{outline:2px solid var(--dsw-alias-brand-primary,#4c8dff);outline-offset:-2px}",
		  ".dsh-skins-card[data-batch=true]{cursor:pointer}",
		  ".dsh-skins-card[data-dragging=true]{opacity:.45}",
		  ".dsh-skins-grid[data-dragging=true] .dsh-skins-card{transition:opacity 120ms ease}",
		  ".dsh-skins-card[data-drop-before=true]::before{content:\"\";position:absolute;left:-4px;top:-2px;bottom:-2px;border-left:2px dashed var(--dsw-alias-brand-primary,#4c8dff)}",
		  "html[data-dsh-dragging] .dsh-skins-card,html[data-dsh-dragging] .dsh-skins-grid{cursor:grabbing}",
		  ".dsh-skins-batch{padding:6px 8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3)}",
		  ".dsh-skins-btn--danger{color:#ff9a9a;border-color:rgba(255,110,110,0.4)}",
		  ".dsh-skins-oplog{max-height:190px;overflow:auto;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}",
		  ".dsh-skins-oplog__row{display:flex;gap:6px;padding:3px 8px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}",
		  ".dsh-skins-oplog__row + .dsh-skins-oplog__row{border-top:.5px solid var(--dsw-alias-border-l1)}",
		  ".dsh-skins-oplog__time{font-variant-numeric:tabular-nums;opacity:.7;flex:0 0 auto}",
		  ".dsh-skins-oplog__kind{flex:0 0 auto;opacity:.85;min-width:44px}",
		  ".dsh-skins-oplog__row[data-kind=delete] .dsh-skins-oplog__kind,.dsh-skins-oplog__row[data-kind=error] .dsh-skins-oplog__kind{color:#ff9a9a}",
		  ".dsh-skins-oplog__row[data-kind=order] .dsh-skins-oplog__kind{color:var(--dsw-alias-brand-primary,#4c8dff)}",
		  ".dsh-skins-oplog__msg{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
		  // the "in use" marker, and the list view
		  ".dsh-skins-card__inuse{position:absolute;top:4px;left:4px;z-index:3;padding:1px 7px;border-radius:9999px;font-size:10px;font-weight:600;line-height:1.6;color:#08111f;background:linear-gradient(180deg,#7ce7a6,#3fd07f);box-shadow:0 2px 8px rgba(0,0,0,0.4);pointer-events:none}",
		  ".dsh-skins-card[data-active=true]{outline:2px solid #3fd07f;outline-offset:-2px}",
		  ".dsh-skins-card[data-active=true] .dsh-skins-card__info{left:auto;right:4px;top:26px}",
		  ".dsh-skins-list{display:flex;flex-direction:column;gap:2px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);overflow:hidden}",
		  ".dsh-skins-row{display:grid;grid-template-columns:auto auto minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr) auto;gap:8px;align-items:center;padding:4px 8px;cursor:pointer;background:var(--dsw-alias-bg-layer-1)}",
		  ".dsh-skins-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.06))}",
		  ".dsh-skins-row + .dsh-skins-row{border-top:.5px solid var(--dsw-alias-border-l1)}",
		  ".dsh-skins-row[data-active=true]{box-shadow:inset 2px 0 0 #3fd07f}",
		  ".dsh-skins-row[data-selected=true]{background:color-mix(in srgb, var(--dsw-alias-brand-primary,#4c8dff) 18%, transparent)}",
		  ".dsh-skins-row__thumb{width:52px;height:30px;object-fit:cover;border-radius:4px;background:rgba(255,255,255,0.05)}",
		  ".dsh-skins-row__check{width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;font-size:11px;color:#fff;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.4)}",
		  ".dsh-skins-row__check[data-on=true]{background:var(--dsw-alias-brand-primary,#4c8dff);border-color:transparent}",
		  ".dsh-skins-row__inuse{padding:0 6px;border-radius:9999px;font-size:10px;font-weight:600;color:#08111f;background:#3fd07f;white-space:nowrap}",
		  ".dsh-skins-row__name{font-size:12px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
		  ".dsh-skins-row__meta,.dsh-skins-row__tags{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}",
		  ".dsh-skins-row__actions{display:flex;gap:4px}",
		  ".dsh-skins-row__actions .dsh-skins-btn{padding:2px 8px;font-size:11px}",
		  // the runtime block, and lazy thumbnails keeping their box while unloaded
		  ".dsh-skins-runtime{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:6px 8px;margin:0 0 8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3)}",
		  ".dsh-skins-runtime__title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary)}",
		  ".dsh-skins-runtime__grid{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:1 1 auto;min-width:0}",
		  ".dsh-skins-runtime__ok{color:#5fd08a}",
		  ".dsh-skins-runtime__paused{color:#e5a13d}",
		  "img[data-thumb]:not([data-thumb-loaded]){background:linear-gradient(100deg,rgba(255,255,255,0.04),rgba(255,255,255,0.09),rgba(255,255,255,0.04));background-size:200% 100%}",
		].join("\n");

		/** Install the panel stylesheet once per document. */
		function ensurePanelStyle() {
		  const tagId = PACKAGE_ID + "/panel.css";
		  if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
		  const tag = document.createElement("style");
		  tag.setAttribute("data-plugin", PACKAGE_ID);
		  tag.setAttribute("data-plugin-css", tagId);
		  tag.textContent = PANEL_CSS;
		  document.head.append(tag);
		}

		/* ------------------------------------------------------------------ *
		 * Panel components
		 * ------------------------------------------------------------------ */

		function Section(props) {
		  return h(
		    "section",
		    { className: "dsh-skins-section" },
		    h(
		      "div",
		      { className: "dsh-skins-section__head" },
		      h("span", { className: "dsh-skins-section__title" }, props.title),
		      props.note === undefined || props.note === null ? null : h("span", { className: "dsh-skins-section__note" }, props.note),
		    ),
		    props.children,
		  );
		}

		function SliderField(props) {
		  return h(
		    "div",
		    { className: "dsh-skins-field" },
		    h(
		      "div",
		      { className: "dsh-skins-field__head" },
		      h("span", { className: "dsh-skins-field__label" }, props.label),
		      h("span", { className: "dsh-skins-field__value" }, props.readout),
		    ),
		    h("input", {
		      className: "dsh-skins-range",
		      type: "range",
		      min: props.min,
		      max: props.max,
		      step: props.step,
		      value: props.value,
		      disabled: props.disabled === true,
		      "aria-label": props.label,
		      onChange: (event) => props.onChange(Number(event.target.value)),
		    }),
		  );
		}

		/** A labelled switch row: the track/knob pair the dark theme already uses elsewhere. */
		function ToggleField(props) {
		  return h(
		    "div",
		    { className: "dsh-skins-field dsh-skins-toggle" },
		    h(
		      "div",
		      { className: "dsh-skins-toggle__row" },
		      h("span", { className: "dsh-skins-field__label" }, props.label),
		      h(
		        "button",
		        {
		          type: "button",
		          role: "switch",
		          className: "dsh-skins-switch",
		          "aria-checked": props.checked ? "true" : "false",
		          "data-on": props.checked ? "true" : "false",
		          "aria-label": props.label,
		          disabled: props.disabled === true,
		          onClick: () => props.onChange(!props.checked),
		        },
		        h("span", { className: "dsh-skins-switch__knob" }),
		      ),
		    ),
		    props.hint === undefined || props.hint === null ? null : h("div", { className: "dsh-skins-toggle__hint" }, props.hint),
		  );
		}

		/** The favourite toggle's glyph: outline when off, filled when on. */
		function HeartGlyph(props) {
		  const filled = props !== null && props !== undefined && props.filled === true;
		  return h(
		    "svg",
		    {
		      width: "13",
		      height: "13",
		      viewBox: "0 0 24 24",
		      "aria-hidden": "true",
		      fill: filled ? "currentColor" : "none",
		      stroke: "currentColor",
		      strokeWidth: "2",
		      strokeLinecap: "round",
		      strokeLinejoin: "round",
		    },
		    h("path", { d: "M12 20.4S3.6 15 3.6 9.3A4.6 4.6 0 0 1 12 6.5a4.6 4.6 0 0 1 8.4 2.8c0 5.7-8.4 11.1-8.4 11.1z" }),
		  );
		}

		/**
		 * One skin card.
		 *
		 * A `div` with the button role rather than a `<button>`, because the favourite,
		 * export and delete controls have to be real buttons inside it and a button cannot
		 * nest in a button. Keyboard activation is therefore spelled out here.
		 *
		 * The card is also the drag handle: a press starts a potential drag and the grid
		 * decides where the dashed insertion line goes. In batch mode a press selects
		 * instead, because the two gestures would otherwise fight over the same movement.
		 */
		function SkinCard(props) {
		  const skin = props.skin;
		  const thumb = assetUrl(skin, "thumb") ?? assetUrl(skin, "wallpaper") ?? assetUrl(skin, "poster");
		  const favorite = props.favorite === true;
		  const activate = () => (props.batchActive === true ? props.onSelect(skin) : props.onApply(skin));
		  // What the user is actually storing: the rendition when one exists, otherwise the
		  // original. `playback` comes from the host, so the panel does not guess.
		  const playback = skin.playback ?? null;
		  const bytes = Number(playback?.bytes ?? skin.sourceBytes ?? 0);
		  const kind = skin.type === "video" ? (skin.video?.rendition ? "已压缩视频" : "原始视频") : "图片";
		  const listens = typeof window !== "undefined" && typeof window.addEventListener === "function";
		  // Killing the *native* drag is what keeps the sort drag ours. A card contains an
		  // <img>, and Chromium starts a native image drag on mousedown+move for any image
		  // that does not say otherwise — that native drag is what the shell's global drop
		  // overlay reacts to ("文件或图片拖动到此处即可添加"), which is the reported bug.
		  const suppressNativeDrag = (event) => {
		    event.preventDefault();
		    event.stopPropagation();
		    if (event.dataTransfer) event.dataTransfer.effectAllowed = "none";
		  };
		  return h(
		    "div",
		    {
		      className: "dsh-skins-card",
		      draggable: "false",
		      [SKIN_CARD_ATTRIBUTE]: skin.skinId,
		      "data-active": props.active ? "true" : "false",
		      "data-favorite": favorite ? "true" : "false",
		      "data-selected": props.selected === true ? "true" : "false",
		      "data-dragging": props.dragging === true ? "true" : "false",
		      "data-drop-before": props.dropBefore === true ? "true" : "false",
		      "data-batch": props.batchActive === true ? "true" : "false",
		      role: "button",
		      tabIndex: 0,
		      title: skinLabel(skin) + (skin.design ? "\n" + skin.design : "") + "\n右键：应用 / 导出 / 标签 / 删除",
		      // A native drag must not start here at all — not from the card, not from the
		      // thumbnail — and the drag events must not bubble up to the document either.
		      onDragStart: suppressNativeDrag,
		      onDragEnter: (event) => event.stopPropagation(),
		      onDragOver: (event) => event.stopPropagation(),
		      onDrop: (event) => event.stopPropagation(),
		      onClick: (event) => {
		        // A click that ended a drag must not also apply the skin.
		        if (props.dragging === true || event?.defaultPrevented === true) return;
		        activate();
		      },
		      onContextMenu: (event) => {
		        event.preventDefault();
		        event.stopPropagation();
		        props.onMenu(skin, event);
		      },
		      // Hover preview: the delay, the muting, the 3-second cap and "only one at a
		      // time" all live in the helper; the card only reports enter and leave.
		      onPointerEnter: () => props.onHoverStart(skin),
		      onPointerLeave: () => props.onHoverEnd(skin),
		      onPointerDown: (event) => {
		        if (props.batchActive === true) return;
		        props.onPress(skin, event);
		        if (listens === true) {
		          const move = (moveEvent) => props.onDragMove(moveEvent);
		          const up = (upEvent) => {
		            window.removeEventListener("pointermove", move, true);
		            window.removeEventListener("pointerup", up, true);
		            window.removeEventListener("keydown", key, true);
		            props.onDrop(upEvent);
		          };
		          const key = (keyEvent) => {
		            if (keyEvent.key !== "Escape") return;
		            window.removeEventListener("pointermove", move, true);
		            window.removeEventListener("pointerup", up, true);
		            window.removeEventListener("keydown", key, true);
		            props.onCancelDrag();
		          };
		          window.addEventListener("pointermove", move, true);
		          window.addEventListener("pointerup", up, true);
		          window.addEventListener("keydown", key, true);
		        }
		      },
		      onKeyDown: (event) => {
		        if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
		          event.preventDefault();
		          activate();
		        }
		        if (event.key === "Delete") {
		          event.preventDefault();
		          props.onDelete(skin);
		        }
		        if (event.key === "ContextMenu" || (event.shiftKey === true && event.key === "F10")) {
		          event.preventDefault();
		          const rect = event.target?.getBoundingClientRect?.() ?? { left: 40, top: 40, width: 0, height: 0 };
		          props.onMenu(skin, { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
		        }
		      },
		    },
		    // The "in use" marker, first in the stack so it sits above everything else.
		    props.active === true ? h("span", { className: "dsh-skins-card__inuse" }, "使用中") : null,
		    // The information badge: the kind of asset (and whether the video is the
		    // compressed copy) plus the size of what is actually played.
		    h(
		      "span",
		      { className: "dsh-skins-card__info", "data-kind": skin.type === "video" ? (skin.video?.rendition ? "rendition" : "original") : "image" },
		      h("span", { className: "dsh-skins-card__kind" }, kind),
		      bytes > 0 ? h("span", { className: "dsh-skins-card__size" }, formatBytes(bytes)) : null,
		    ),
		    props.batchActive === true
		      ? h("span", { className: "dsh-skins-card__check", "data-on": props.selected === true ? "true" : "false", "aria-hidden": "true" }, props.selected === true ? "✓" : "")
		      : null,
		    h(
		      "span",
		      { className: "dsh-skins-card__media" },
		      thumb === null
		        ? null
		        : h("img", {
		            // The URL rides in `data-thumb` until the card approaches the viewport:
		            // 50 cards must not mean 50 simultaneous image requests.
		            "data-thumb": thumb,
		            src: undefined,
		            alt: "",
		            loading: "lazy",
		            decoding: "async",
		            draggable: "false",
		            onDragStart: suppressNativeDrag,
		          }),
		      h(
		        "button",
		        {
		          type: "button",
		          className: "dsh-skins-card__fav",
		          "data-on": favorite ? "true" : "false",
		          "aria-pressed": favorite ? "true" : "false",
		          "aria-label": (favorite ? "取消收藏 " : "收藏 ") + skinLabel(skin),
		          title: favorite ? "取消收藏" : "加入收藏",
		          onClick: (event) => {
		            event.stopPropagation();
		            event.preventDefault();
		            props.onToggleFavorite(skin);
		          },
		          onKeyDown: (event) => {
		            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
		          },
		        },
		        h(HeartGlyph, { filled: favorite }),
		      ),
		      h(
		        "button",
		        {
		          type: "button",
		          className: "dsh-skins-card__pack",
		          "aria-label": "导出皮肤包 " + skinLabel(skin),
		          title: "导出为 .zip 皮肤包",
		          onClick: (event) => {
		            event.stopPropagation();
		            event.preventDefault();
		            props.onExport(skin);
		          },
		          onKeyDown: (event) => {
		            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
		          },
		        },
		        "⤓",
		      ),
		      h(
		        "button",
		        {
		          type: "button",
		          className: "dsh-skins-card__del",
		          "aria-label": "删除皮肤 " + skinLabel(skin),
		          title: "删除这套皮肤（会先确认）",
		          onClick: (event) => {
		            event.stopPropagation();
		            event.preventDefault();
		            props.onDelete(skin);
		          },
		          onKeyDown: (event) => {
		            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
		          },
		        },
		        "␡",
		      ),
		    ),
		    h(
		      "span",
		      { className: "dsh-skins-card__meta" },
		      h("span", { className: "dsh-skins-card__name" }, skinLabel(skin)),
		      h("span", { className: "dsh-skins-card__badge" }, skin.type === "video" ? "视频" : "图片"),
		    ),
		  );
		}

		/**
		 * The tag filter.
		 *
		 * A disclosure rather than a floating menu on purpose: the column is ~320px
		 * wide and the panel's scroll container would clip an absolutely positioned
		 * popup, so the list expands in place and scrolls itself. The catalog carries
		 * 300+ distinct tags across the 40 skins, so it has its own search box and
		 * shows the per-tag skin count, most used first.
		 */
		function TagPicker(props) {
		  const [needle, setNeedle] = react.useState("");
		  const trimmed = needle.trim().toLowerCase();
		  const list = props.tags.filter((row) => trimmed.length === 0 || row.tag.toLowerCase().includes(trimmed));
		  return h(
		    "div",
		    { className: "dsh-skins-tagpicker" },
		    h(
		      "button",
		      {
		        type: "button",
		        className: "dsh-skins-btn",
		        "data-on": props.selected.length > 0 ? "true" : "false",
		        "aria-expanded": props.open ? "true" : "false",
		        onClick: () => props.onOpen(!props.open),
		      },
		      props.selected.length === 0 ? "按标签筛选" : "标签 · " + props.selected.length,
		      h("span", { className: "dsh-skins-caret" }, props.open ? "▲" : "▼"),
		    ),
		    props.open
		      ? h(
		          "div",
		          { className: "dsh-skins-tagpanel" },
		          h("input", {
		            className: "dsh-skins-input",
		            type: "search",
		            placeholder: "过滤标签…",
		            value: needle,
		            "aria-label": "过滤标签列表",
		            onChange: (event) => setNeedle(event.target.value),
		          }),
		          h(
		            "div",
		            { className: "dsh-skins-taglist" },
		            list.length === 0 ? h("p", { className: "dsh-skins-note", style: { margin: "4px 2px" } }, "没有匹配的标签。") : null,
		            list.map((row) =>
		              h(
		                "button",
		                {
		                  key: row.tag,
		                  type: "button",
		                  className: "dsh-skins-tag",
		                  "data-on": props.selected.includes(row.tag) ? "true" : "false",
		                  "aria-pressed": props.selected.includes(row.tag) ? "true" : "false",
		                  onClick: () => props.onToggle(row.tag),
		                },
		                h("span", { className: "dsh-skins-tag__label" }, row.tag),
		                h("span", { className: "dsh-skins-tag__count" }, String(row.count)),
		              ),
		            ),
		          ),
		          h(
		            "div",
		            { className: "dsh-skins-tools" },
		            h("button", { type: "button", className: "dsh-skins-btn", disabled: props.selected.length === 0, onClick: props.onClear }, "清除标签"),
		            h("span", { className: "dsh-skins-note", style: { margin: 0 } }, list.length + " / " + props.tags.length + " 个标签"),
		          ),
		        )
		      : null,
		  );
		}

		/** The generation job's steps as a plain checklist — the honest progress bar. */
		function JobSteps(props) {
		  const job = props.job;
		  if (job === null || job === undefined || !Array.isArray(job.steps) || job.steps.length === 0) return null;
		  return h(
		    "div",
		    { className: "dsh-skins-steps" },
		    job.steps.map((step, index) =>
		      h(
		        "div",
		        { key: step.id + "-" + index, className: "dsh-skins-step", "data-status": step.status },
		        h(
		          "span",
		          { className: "dsh-skins-step__mark" },
		          step.status === "ok" ? "✓" : step.status === "failed" ? "✗" : step.status === "skipped" ? "–" : "•",
		        ),
		        h("span", { className: "dsh-skins-step__title" }, step.title),
		        h("span", { className: "dsh-skins-step__ms" }, step.ms > 0 ? (step.ms / 1000).toFixed(1) + "s" : ""),
		      ),
		    ),
		  );
		}

		/** The whole panel: current skin, library, knobs, upload+generate, automation. */
		function SkinsPanel(props) {
		  const store = props.store;
		  const view = useView(store);
		  const [queue, setQueue] = react.useState([]);
		  const [dropOver, setDropOver] = react.useState(false);
		  const [tagOpen, setTagOpen] = react.useState(false);
		  const [busy, setBusy] = react.useState(false);
		  const [bindPath, setBindPath] = react.useState("");
		  const [batchTag, setBatchTag] = react.useState("");
		  /** dragenter/dragleave fire for every child element; a depth counter stops the flicker. */
		  const dragDepth = react.useRef(0);
		  // The panel is a session-scoped slot, so it receives the same workspace
		  // snapshot the left column renders. Harvesting it is what lets the automation
		  // resolve a session while the panel is closed — and recording `sessionId` means
		  // a project rule still works even where `sidebarRight.mounted` is unavailable.
		  const useWorkspaces = props.useWorkspaces;
		  const workspaceSnapshot = typeof useWorkspaces === "function" ? useWorkspaces((snapshot) => snapshot) : null;
		  react.useEffect(() => {
		    harvestWorkspaces(store, workspaceSnapshot);
		    if (typeof props.sessionId === "string" && props.sessionId.length > 0) {
		      refreshWorkspaceFromSession(store, props.sessionId);
		    }
		  }, [workspaceSnapshot, props.sessionId, store]);

		  react.useEffect(() => {
		    // After every render, so newly rendered cards are observed and the ones already in
		    // view get their src. Idempotent, and a no-op when nothing is pending.
		    observeThumbs();
		  });
		  react.useEffect(() => {
		    startStatusTimer(store);
		    return () => stopStatusTimer(store);
		  }, [store]);
		  const runtime = view.runtime ?? store.runtime ?? null;

		  const catalog = view.catalog;
		  const skins = catalog && Array.isArray(catalog.skins) ? catalog.skins : [];
		  const current = view.skinId === null ? null : skins.find((skin) => skin.skinId === view.skinId) ?? null;
		  const filters = view.filters;
		  const favorites = view.favorites;
		  const needle = filters.query.trim().toLowerCase();
		  // The stored order wins over the catalog's, so a drag survives a reload.
		  const ordered2 = orderedSkins(store, skins);
		  const visible = ordered2.filter((skin) => {
		    if (filters.type !== "all" && skin.type !== filters.type) return false;
		    if (filters.favoriteOnly === true && !favorites.includes(skin.skinId)) return false;
		    const tags = skinTags(skin, store);
		    if (filters.tags.length > 0 && !filters.tags.some((tag) => tags.includes(tag))) return false;
		    if (needle.length === 0) return true;
		    return (skinLabel(skin) + " " + skin.skinId + " " + (skin.design ?? "") + " " + tags.join(" ")).toLowerCase().includes(needle);
		  });
		  // The skin in use is pinned to the front while browsing (never while dragging, so a
		  // drop cannot be undone by the pin) — the stored order file is left untouched.
		  const viewMode = store.viewMode ?? readViewMode();
		  const knobs = store.uiKnobs ?? UI_KNOB_DEFAULTS;
		  const recommend = view.recommend ?? store.recommend ?? defaultRecommend();
		  const batch = view.batch ?? { active: false, selected: [] };
		  const drag = view.drag ?? null;
		  const shown = pinActiveSkin(visible, view.skinId, drag === null && viewMode === "grid");
		  const dragOverId = drag === null ? null : shown[drag.over]?.skinId ?? null;  const job = view.job;
		  const auto = view.automation ?? defaultAutomation();
		  const assets = view.assets ?? ASSET_DEFAULTS;
		  const ffmpeg = view.ffmpeg ?? null;
		  const ffmpegReady = ffmpeg !== null && ffmpeg.available === true;
		  const assetJob = view.assetJob ?? null;
		  const compressing = assetJob !== null && assetJob.running === true;
		  const exportResult = view.exportResult ?? null;
		  const importResult = view.importResult ?? null;
		  const cleanup = view.cleanup ?? null;
		  const cssCheck = view.customCssCheck ?? validateCss("");
		  const picking = view.picker?.open === true;
		  const focusConflicts = view.focusConflicts ?? [];
		  // "Not installed" and "the probe could not run" are different problems, and an
		  // ordinary missing binary (ENOENT) is the only one worth staying quiet about.
		  const ffmpegError = ffmpeg?.error;
		  const ffmpegReason =
		    typeof ffmpegError === "string" && ffmpegError.length > 0 && !/ENOENT|not.?found|exit-\d/iu.test(ffmpegError)
		      ? "（探测失败：" + ffmpegError.slice(0, 60) + "）"
		      : "";
		  // The batch target: video skins with no rendition yet whose source is over the
		  // threshold. Rotation is not a reference, so this is stable across a cleanup.
		  const oversizedVideoIds = skins
		    .filter((entry) => entry.type === "video" && entry.video?.rendition == null && Number(entry.video?.sourceBytes ?? 0) > assets.thresholdMB * 1048576)
		    .map((entry) => entry.skinId);

		  /** Upload every accepted file in order, measure it, then kick off one generation run. */
		  const acceptFiles = react.useCallback(
		    async (files) => {
		      const accepted = [];
		      for (const file of Array.from(files)) {
		        const isVideo = /^video\//u.test(file.type) || /\.(mp4|m4v|mov|webm|mkv)$/iu.test(file.name);
		        const isImage = /^image\//u.test(file.type) || /\.(png|jpe?g|webp|avif|gif|bmp)$/iu.test(file.name);
		        accepted.push({ name: file.name, size: file.size, kind: isVideo ? "video" : isImage ? "image" : "unknown", file });
		      }
		      setQueue(accepted.map((item) => ({ name: item.name, size: item.size, kind: item.kind, percent: 0, status: item.kind === "unknown" ? "skipped" : "waiting", message: item.kind === "unknown" ? "不支持的格式" : "" })));
		      setBusy(true);
		      const patch = (index, changes) => setQueue((rows) => rows.map((row, at) => (at === index ? Object.assign({}, row, changes) : row)));
		      const records = {};
		      let uploaded = 0;
		      for (let index = 0; index < accepted.length; index += 1) {
		        const item = accepted[index];
		        if (item.kind === "unknown") continue;
		        patch(index, { status: "uploading" });
		        try {
		          const reply = await uploadFile(item.file, (fraction) => patch(index, { percent: Math.round(fraction * 100) }));
		          uploaded += 1;
		          patch(index, { status: "done", percent: 100, message: reply.bytes ? formatBytes(reply.bytes) : "" });
		        } catch (error) {
		          patch(index, { status: "failed", message: String(error && error.message ? error.message : error) });
		          continue;
		        }
		        // Measure the pixels that were just uploaded — the same File object, read
		        // locally, so no second round trip is needed.
		        patch(index, { status: "measuring", message: "测量像素…" });
		        try {
		          const measured = item.kind === "video" ? await sampleFromVideo(item.file, () => {}) : await sampleFromImage(item.file);
		          records[item.name] = buildRecord(measured, { name: item.name, kind: item.kind });
		          if (item.kind === "video" && measured.poster !== null && measured.poster !== undefined) {
		            try {
		              await uploadPoster(item.name, measured.poster, {
		                atSeconds: measured.bestTime,
		                width: measured.native.width,
		                height: measured.native.height,
		                duration: measured.native.duration,
		              });
		              patch(index, { status: "done", message: "已测量 + 海报帧已上传" });
		            } catch (error) {
		              patch(index, { status: "done", message: "已测量（海报帧上传失败：" + String(error && error.message ? error.message : error) + "）" });
		            }
		          } else {
		            patch(index, { status: "done", message: "已测量 " + (records[item.name].primaryColor ?? "") });
		          }
		        } catch (error) {
		          patch(index, { status: "done", message: "已上传（像素测量失败：" + String(error && error.message ? error.message : error) + "，将用占位配色）" });
		        }
		      }
		      setBusy(false);
		      if (uploaded > 0) await startGenerate(store, records);
		    },
		    [store],
		  );

		  const onPick = react.useCallback((event) => {
		    const files = event.target.files;
		    if (files !== null && files !== undefined && files.length > 0) void acceptFiles(files);
		    event.target.value = "";
		  }, [acceptFiles]);

		  /** The shared, case-insensitive check: a text or internal drag must not light up. */
		  const dragHasFiles = (event) => dragCarriesFiles(event) && store.drag === null && store.cardPress === null;

		  const onDragEnter = react.useCallback((event) => {
		    if (!dragHasFiles(event)) return;
		    event.preventDefault();
		    dragDepth.current += 1;
		    setDropOver(true);
		  }, []);

		  const onDragOver = react.useCallback((event) => {
		    if (!dragHasFiles(event)) return;
		    event.preventDefault();
		    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		    setDropOver(true);
		  }, []);

		  const onDragLeave = react.useCallback((event) => {
		    if (!dragHasFiles(event)) return;
		    dragDepth.current = Math.max(0, dragDepth.current - 1);
		    if (dragDepth.current === 0) setDropOver(false);
		  }, []);

		  const onDrop = react.useCallback(
		    (event) => {
		      event.preventDefault();
		      dragDepth.current = 0;
		      setDropOver(false);
		      const transfer = event.dataTransfer;
		      const files = transfer ? transfer.files : null;
		      if (files !== null && files !== undefined && files.length > 0) void acceptFiles(files);
		    },
		    [acceptFiles],
		  );

		  const slider = view.slider;
		  const noSkin = view.skinId === null;
		  const percent = (value) => Math.round(value) + "%";

		  // ── one progress line for the whole pipeline, then the step checklist ──────
		  const uploading = queue.some((row) => row.status === "waiting" || row.status === "uploading" || row.status === "measuring");
		  const running = job !== null && job !== undefined && job.status === "running";
		  const steps = job !== null && job !== undefined && Array.isArray(job.steps) ? job.steps : [];
		  const finishedSteps = steps.filter((step) => step.status !== "running").length;
		  const banner =
		    busy || uploading || running
		      ? "正在处理：" +
		        (uploading ? "上传 / 测量素材" : null) +
		        (uploading && running ? " → " : null) +
		        (running ? "生成皮肤 " + finishedSteps + "/" + Math.max(steps.length, 1) + " 步" : null)
		      : null;

		  return h(
		    "div",
		    { className: "dsh-skins-panel" },
		    h(
		      "div",
		      { className: "dsh-skins-scroll" },
		      view.staleHost
		        ? h(
		            "p",
		            { className: "dsh-skins-warn" },
		            "宿主半侧版本为 " +
		              (view.hostRevision ?? "未知") +
		              "，本面板需要 " +
		              view.revision +
		              "：切换皮肤、细节调节、自定义 CSS、专注模式与吸管现在就能用；上传、自动生成、大视频压缩、皮肤包导出/导入与清理要等 dsh 桌面端**完全退出并重新启动**之后。",
		          )
		        : null,
		      view.catalogError === null || view.catalogError === undefined
		        ? null
		        : h("p", { className: "dsh-skins-err" }, "皮肤目录读取失败：" + view.catalogError),
		      banner === null ? null : h("p", { className: "dsh-skins-progress" }, banner),

		      // ---- current ----
		      h(
		        Section,
		        { title: "当前背景", note: catalog ? skins.length + " 套可用" : "读取中…" },
		        h(
		          "div",
		          { className: "dsh-skins-now" },
		          h(
		            "span",
		            { className: "dsh-skins-now__thumb" },
		            current !== null && (assetUrl(current, "thumb") ?? assetUrl(current, "wallpaper")) !== null
		              ? h("img", { src: assetUrl(current, "thumb") ?? assetUrl(current, "wallpaper"), alt: "", decoding: "async" })
		              : null,
		          ),
		          h(
		            "span",
		            { className: "dsh-skins-now__text" },
		            h("span", { className: "dsh-skins-now__name" }, skinLabel(current)),
		            h(
		              "span",
		              { className: "dsh-skins-now__meta" },
		              current === null
		                ? "dsh 内置主题"
		                : (current.type === "video" ? "视频背景" : "图片背景") + (current.styleKeywords && current.styleKeywords.length > 0 ? " · " + current.styleKeywords.slice(0, 3).join(" / ") : ""),
		            ),
		          ),
		          h(
		            "span",
		            { className: "dsh-skins-tools" },
		            h(
		              "button",
		              { type: "button", className: "dsh-skins-btn", disabled: skins.length === 0, title: "随机换一套皮肤" + (view.shortcutKeys && view.shortcutKeys.random ? "（" + view.shortcutKeys.random + "）" : ""), onClick: () => void applyRandom(props.ctx, store, "button-random") },
		              "随机",
		            ),
		            h(
		              "button",
		              { type: "button", className: "dsh-skins-btn", disabled: noSkin, onClick: () => void applyById(props.ctx, store, null) },
		              "回退内置",
		            ),
		          ),
		        ),
		      ),

		      // ---- knobs ----
		      h(
		        Section,
		        { title: "细节调节", note: noSkin ? "先选一套皮肤" : "即时生效 · 按皮肤记忆" },
		        h(ToggleField, {
		          label: "UI颜色跟随背景",
		          checked: slider.uiFollow === true,
		          disabled: noSkin,
		          hint:
		            view.liveTokensNote !== null && view.liveTokensNote !== undefined
		              ? view.liveTokensNote
		              : "按当前画面实测主色/强调色重建 --dsw-*；背景过浅时文字自动转深色",
		          onChange: (next) => {
		            setTweak(props.ctx, store, view.skinId, "uiFollow", next);
		            if (next) void refreshLiveTokens(props.ctx, store);
		            else void refreshLiveTokens(props.ctx, store);
		          },
		        }),
		        h(ToggleField, {
		          label: "鼠标视差",
		          checked: slider.parallax === true,
		          disabled: noSkin,
		          hint: view.reducedMotion
		            ? "系统开启了「减少动态效果」，视差不会生效"
		            : "背景随指针轻微位移与倾斜（≤" + PARALLAX_MAX_X + "px）",
		          onChange: (next) => setTweak(props.ctx, store, view.skinId, "parallax", next),
		        }),
		        h(SliderField, {
		          label: "模糊",
		          readout: slider.blur + " px",
		          min: TWEAK_LIMITS.blur.min,
		          max: TWEAK_LIMITS.blur.max,
		          step: TWEAK_LIMITS.blur.step,
		          value: slider.blur,
		          disabled: noSkin,
		          onChange: (value) => setTweak(props.ctx, store, view.skinId, "blur", value),
		        }),
		        h(SliderField, {
		          label: "背景不透明度",
		          readout: percent(slider.opacity),
		          min: TWEAK_LIMITS.opacity.min,
		          max: TWEAK_LIMITS.opacity.max,
		          step: TWEAK_LIMITS.opacity.step,
		          value: slider.opacity,
		          disabled: noSkin,
		          onChange: (value) => setTweak(props.ctx, store, view.skinId, "opacity", value),
		        }),
		        h(SliderField, {
		          label: "遮罩强度",
		          readout: percent(slider.veil),
		          min: TWEAK_LIMITS.veil.min,
		          max: TWEAK_LIMITS.veil.max,
		          step: TWEAK_LIMITS.veil.step,
		          value: slider.veil,
		          disabled: noSkin,
		          onChange: (value) => setTweak(props.ctx, store, view.skinId, "veil", value),
		        }),
		        h("div", { className: "dsh-skins-subhead" }, "实时滤镜"),
		        h(SliderField, {
		          label: "灰度",
		          readout: slider.grayscale + "%",
		          min: TWEAK_LIMITS.grayscale.min,
		          max: TWEAK_LIMITS.grayscale.max,
		          step: TWEAK_LIMITS.grayscale.step,
		          value: slider.grayscale,
		          disabled: noSkin,
		          onChange: (value) => setTweak(props.ctx, store, view.skinId, "grayscale", value),
		        }),
		        h(SliderField, {
		          label: "饱和度",
		          readout: slider.saturate + "%",
		          min: TWEAK_LIMITS.saturate.min,
		          max: TWEAK_LIMITS.saturate.max,
		          step: TWEAK_LIMITS.saturate.step,
		          value: slider.saturate,
		          disabled: noSkin,
		          onChange: (value) => setTweak(props.ctx, store, view.skinId, "saturate", value),
		        }),
		        h(SliderField, {
		          label: "对比度",
		          readout: slider.contrast + "%",
		          min: TWEAK_LIMITS.contrast.min,
		          max: TWEAK_LIMITS.contrast.max,
		          step: TWEAK_LIMITS.contrast.step,
		          value: slider.contrast,
		          disabled: noSkin,
		          onChange: (value) => setTweak(props.ctx, store, view.skinId, "contrast", value),
		        }),
		        h(SliderField, {
		          label: "色调分离",
		          readout: slider.posterize === 0 ? "关闭" : posterizeLevels(slider.posterize) + " 级",
		          min: TWEAK_LIMITS.posterize.min,
		          max: TWEAK_LIMITS.posterize.max,
		          step: TWEAK_LIMITS.posterize.step,
		          value: slider.posterize,
		          disabled: noSkin,
		          onChange: (value) => setTweak(props.ctx, store, view.skinId, "posterize", value),
		        }),
		        slider.posterize > 0 && current !== null && current.type === "video"
		          ? h("p", { className: "dsh-skins-note", style: { margin: "-6px 0 10px" } }, "色调分离是逐像素运算，视频上可能掉帧。")
		          : null,
		        // ── video-only group: nothing here renders for an image background ────
		        current !== null && current.type === "video"
		          ? h(
		              "div",
		              { className: "dsh-skins-video" },
		              h("div", { className: "dsh-skins-subhead" }, "视频控制"),
		              h(
		                "div",
		                { className: "dsh-skins-tools" },
		                h(
		                  "button",
		                  {
		                    type: "button",
		                    className: "dsh-skins-btn",
		                    disabled: view.reducedMotion,
		                    onClick: () => setTweak(props.ctx, store, view.skinId, "videoPlaying", !(slider.videoPlaying === true)),
		                  },
		                  slider.videoPlaying === true ? "⏸ 暂停" : "▶ 播放",
		                ),
		                h(
		                  "button",
		                  {
		                    type: "button",
		                    className: "dsh-skins-btn",
		                    "data-on": slider.videoMuted === true ? "false" : "true",
		                    onClick: () => setTweak(props.ctx, store, view.skinId, "videoMuted", !(slider.videoMuted === true)),
		                  },
		                  slider.videoMuted === true ? "🔇 已静音" : "🔊 有声",
		                ),
		              ),
		              h(
		                "div",
		                { className: "dsh-skins-field__head", style: { margin: "10px 0 4px" } },
		                h("span", { className: "dsh-skins-field__label" }, "播放速度"),
		                h("span", { className: "dsh-skins-field__value" }, slider.videoRate + "x"),
		              ),
		              h(
		                "span",
		                { className: "dsh-skins-seg" },
		                VIDEO_RATES.map((rate) =>
		                  h(
		                    "button",
		                    {
		                      key: rate,
		                      type: "button",
		                      "data-on": slider.videoRate === rate ? "true" : "false",
		                      onClick: () => setTweak(props.ctx, store, view.skinId, "videoRate", rate),
		                    },
		                    rate + "x",
		                  ),
		                ),
		              ),
		              h(ToggleField, {
		                label: "音频律动",
		                checked: slider.audioReactive === true,
		                disabled: view.reducedMotion || view.videoHasAudio === false,
		                hint: view.reducedMotion
		                  ? "系统开启了「减少动态效果」，律动不会生效"
		                  : view.videoHasAudio === false
		                    ? "此视频没有音频轨"
		                    : view.videoSilent === true
		                      ? "已开启，但约 1.5 秒内没读到音频（该视频可能没有音轨或已被静音轨覆盖）"
		                      : view.audioReactiveOn === true
		                        ? "实时读取音频振幅 · 当前驱动 " + (view.audioLevel ?? 0) + (slider.videoMuted === true ? "（已静音，但分析仍然进行）" : "")
		                        : "按音频振幅做轻微缩放（≤" + Math.round(AUDIO_SCALE_MAX * 100) + "%）与亮度波动",
		                onChange: (next) => setTweak(props.ctx, store, view.skinId, "audioReactive", next),
		              }),
		              view.videoNote !== null && view.videoNote !== undefined ? h("p", { className: "dsh-skins-note", style: { margin: "4px 0 0" } }, view.videoNote) : null,
		              h(
		                "div",
		                { className: "dsh-skins-tools", style: { marginTop: "8px" } },
		                h(
		                  "button",
		                  {
		                    type: "button",
		                    className: "dsh-skins-btn",
		                    disabled: ffmpegReady !== true || compressing,
		                    title: ffmpegReady === true ? "把原视频转成 " + assets.targetHeight + "p / " + assets.bitrateMbps + " Mbps 的播放副本" : "需要先安装 ffmpeg",
		                    onClick: () => void startCompress(store, [view.skinId]),
		                  },
		                  "压缩当前视频",
		                ),
		                h(
		                  "span",
		                  { className: "dsh-skins-note", style: { margin: 0 } },
		                  current.video?.rendition
		                    ? "播放压缩副本 " + formatBytes(current.video.renditionBytes ?? 0) + "（原 " + formatBytes(current.video.sourceBytes ?? 0) + "）"
		                    : "播放原视频 " + formatBytes(current.video?.sourceBytes ?? 0),
		                ),
		              ),
		            )
		          : null,
		        h(
		          "div",
		          { className: "dsh-skins-tools" },
		          h(
		            "button",
		            {
		              type: "button",
		              className: "dsh-skins-btn",
		              disabled: noSkin,
		              onClick: () => {
		                if (view.skinId === null) return;
		                const next = Object.assign({}, store.tweaks);
		                delete next[view.skinId];
		                store.tweaks = next;
		                writeTweaks(next);
		                applyLayerTweaks(store);
		                void refreshLiveTokens(props.ctx, store);
		                publish(store, {});
		              },
		            },
		            "重置本皮肤",
		          ),
		        ),
		      ),

		      // ---- library ----
		      h(
		        Section,
		        { title: "皮肤库", note: shown.length + " / " + skins.length },
		        h(
		          "div",
		          { className: "dsh-skins-tools", style: { marginBottom: "8px" } },
		          h("input", {
		            className: "dsh-skins-input",
		            type: "search",
		            placeholder: "搜索名称 / 风格 / 标签",
		            value: filters.query,
		            "aria-label": "搜索皮肤",
		            onChange: (event) => setFilter(store, { query: event.target.value }),
		            style: { flex: "1 1 120px", width: "auto" },
		          }),
		          h(
		            "span",
		            { className: "dsh-skins-seg" },
		            ["all", "image", "video"].map((value) =>
		              h(
		                "button",
		                { key: value, type: "button", "data-on": filters.type === value ? "true" : "false", onClick: () => setFilter(store, { type: value }) },
		                value === "all" ? "全部" : value === "image" ? "图片" : "视频",
		              ),
		            ),
		          ),
		        ),
		        h(
		          "div",
		          { className: "dsh-skins-tools", style: { marginBottom: "8px" } },
		          h(TagPicker, {
		            tags: view.tags,
		            selected: filters.tags,
		            open: tagOpen,
		            onOpen: setTagOpen,
		            onToggle: (tag) =>
		              setFilter(store, {
		                tags: filters.tags.includes(tag) ? filters.tags.filter((value) => value !== tag) : [...filters.tags, tag],
		              }),
		            onClear: () => setFilter(store, { tags: [] }),
		          }),
		          h(
		            "button",
		            {
		              type: "button",
		              className: "dsh-skins-btn",
		              "data-on": filters.favoriteOnly ? "true" : "false",
		              "aria-pressed": filters.favoriteOnly ? "true" : "false",
		              onClick: () => setFilter(store, { favoriteOnly: !filters.favoriteOnly }),
		            },
		            h(HeartGlyph, { filled: filters.favoriteOnly }),
		            " 仅收藏 (" + favorites.length + ")",
		          ),
		          filters.tags.length > 0 || filters.favoriteOnly || filters.query.length > 0 || filters.type !== "all"
		            ? h(
		                "button",
		                {
		                  type: "button",
		                  className: "dsh-skins-btn",
		                  onClick: () => setFilter(store, { tags: [], favoriteOnly: false, query: "", type: "all" }),
		                },
		                "清除筛选",
		              )
		            : null,
		          h(
		            "button",
		            {
		              type: "button",
		              className: "dsh-skins-btn",
		              "data-on": batch.active === true ? "true" : "false",
		              "aria-pressed": batch.active === true ? "true" : "false",
		              title: "进入后可以勾选多套皮肤，再批量收藏 / 加标签 / 导出 / 删除",
		              onClick: () => setBatchMode(store, batch.active !== true),
		            },
		            batch.active === true ? "退出批量" : "批量选择",
		          ),
		          // View switch: the grid is for browsing art, the list for reading facts.
		          h(
		            "span",
		            { className: "dsh-skins-seg", title: "网格 / 列表视图" },
		            ["grid", "list"].map((mode) =>
		              h(
		                "button",
		                { key: mode, type: "button", "data-on": viewMode === mode ? "true" : "false", onClick: () => setViewMode(store, mode) },
		                mode === "grid" ? "网格" : "列表",
		              ),
		            ),
		          ),
		        ),
		        // ── batch actions ─────────────────────────────────────────────────────
		        batch.active === true
		          ? h(
		              "div",
		              { className: "dsh-skins-tools dsh-skins-batch" },
		              h("span", { className: "dsh-skins-auto-label" }, "已选 " + batch.selected.length + " / " + shown.length),
		              h("button", { type: "button", className: "dsh-skins-btn", onClick: () => setBatchSelection(store, shown.map((skin) => skin.skinId)) }, "全选"),
		              h("button", { type: "button", className: "dsh-skins-btn", onClick: () => invertSelection(store, shown.map((skin) => skin.skinId)) }, "反选"),
		              h("button", { type: "button", className: "dsh-skins-btn", onClick: () => setBatchSelection(store, []) }, "清空"),
		              h(
		                "button",
		                { type: "button", className: "dsh-skins-btn", disabled: batch.selected.length === 0, onClick: () => void favoriteSelection(store, batch.selected) },
		                "批量加入收藏",
		              ),
		              h(
		                "button",
		                { type: "button", className: "dsh-skins-btn", disabled: batch.selected.length === 0, onClick: () => void exportSelection(store, batch.selected) },
		                "批量导出",
		              ),
		              h(
		                "button",
		                { type: "button", className: "dsh-skins-btn dsh-skins-btn--danger", disabled: batch.selected.length === 0, onClick: () => void confirmDeleteSkins(props.ctx, store, batch.selected) },
		                "批量删除 (" + batch.selected.length + ")",
		              ),
		            )
		          : null,
		        batch.active === true
		          ? h(
		              "div",
		              { className: "dsh-skins-tools" },
		              h("input", {
		                className: "dsh-skins-input",
		                type: "text",
		                placeholder: "批量标签，例如：夜景",
		                value: batchTag,
		                "aria-label": "批量标签",
		                style: { flex: "1 1 120px", width: "auto" },
		                onChange: (event) => setBatchTag(event.target.value),
		              }),
		              h(
		                "button",
		                {
		                  type: "button",
		                  className: "dsh-skins-btn",
		                  disabled: batch.selected.length === 0 || batchTag.trim().length === 0,
		                  onClick: () => {
		                    void applyTagSelection(store, batch.selected, batchTag);
		                    setBatchTag("");
		                  },
		                },
		                "批量添加标签",
		              ),
		            )
		          : null,
		        // ── order / persistence state ─────────────────────────────────────────
		        h(
		          "p",
		          { className: view.preferencesNote === null || view.preferencesNote === undefined ? "dsh-skins-note" : "dsh-skins-warn", style: { margin: "0 0 8px" } },
		          "拖拽缩略图即可排序" +
		            (view.preferences?.order?.length > 0 ? "（已保存 " + view.preferences.order.length + " 套顺序" : "（尚未保存顺序") +
		            (view.preferencesSavedAt === null || view.preferencesSavedAt === undefined ? "" : " · " + view.preferencesSavedAt.slice(11, 19)) +
		            "）" +
		            (view.preferencesFile ? " · " + view.preferencesFile : "") +
		            (view.preferencesNote ? " · " + view.preferencesNote : ""),
		        ),
		        filters.tags.length > 0
		          ? h(
		              "div",
		              { className: "dsh-skins-tools", style: { marginBottom: "8px" } },
		              filters.tags.map((tag) =>
		                h(
		                  "button",
		                  { key: tag, type: "button", className: "dsh-skins-chip", title: "移除这个标签", onClick: () => setFilter(store, { tags: filters.tags.filter((value) => value !== tag) }) },
		                  tag,
		                  h("span", { className: "dsh-skins-chip__x" }, "×"),
		                ),
		              ),
		            )
		          : null,
		        viewMode === "list"
		          ? h(
		              "div",
		              { className: "dsh-skins-list" },
		              shown.map((skin) => {
		                const selected = (batch.selected ?? []).includes(skin.skinId);
		                const tabbable = skin.playback?.width !== null && skin.playback?.width !== undefined && skin.playback?.height !== null && skin.playback?.height !== undefined;
		                const resolution = tabbable ? skin.playback.width + "×" + skin.playback.height : "—";
		                const size = formatBytes(Number(skin.playback?.bytes ?? skin.sourceBytes ?? 0));
		                const kind = skin.type === "video" ? (skin.video?.rendition ? "已压缩视频" : "原始视频") : "图片";
		                const thumb = assetUrl(skin, "thumb") ?? assetUrl(skin, "wallpaper") ?? assetUrl(skin, "poster");
		                return h(
		                  "div",
		                  {
		                    key: skin.skinId,
		                    className: "dsh-skins-row",
		                    "data-active": skin.skinId === view.skinId ? "true" : "false",
		                    "data-selected": selected ? "true" : "false",
		                    onClick: () => (batch.active === true ? toggleBatchSelection(store, skin.skinId) : void applyById(props.ctx, store, skin.skinId)),
		                    onContextMenu: (event) => {
		                      event.preventDefault();
		                      event.stopPropagation();
		                      openSkinMenu(props.ctx, store, skin, event.clientX, event.clientY);
		                    },
		                    title: skinLabel(skin) + (skin.design ? "\n" + skin.design : "") + "\n右键：应用 / 导出 / 标签 / 删除",
		                  },
		                  batch.active === true ? h("span", { className: "dsh-skins-row__check", "data-on": selected ? "true" : "false", "aria-hidden": "true" }, selected ? "✓" : "") : null,
		                  skin.skinId === view.skinId ? h("span", { className: "dsh-skins-row__inuse" }, "使用中") : null,
		                  h("img", { className: "dsh-skins-row__thumb", src: thumb ?? "", alt: "", loading: "lazy", decoding: "async", draggable: "false" }),
		                  h("span", { className: "dsh-skins-row__name" }, skinLabel(skin)),
		                  h("span", { className: "dsh-skins-row__meta" }, resolution + " · " + size + " · " + kind),
		                  h("span", { className: "dsh-skins-row__tags" }, skinTags(skin, store).slice(0, 3).join(" · ") || "—"),
		                  h(
		                    "span",
		                    { className: "dsh-skins-row__actions" },
		                    h("button", { type: "button", className: "dsh-skins-btn", onClick: (event) => { event.stopPropagation(); void applyById(props.ctx, store, skin.skinId); } }, "应用"),
		                    h("button", { type: "button", className: "dsh-skins-btn", onClick: (event) => { event.stopPropagation(); void exportSkin(store, skin.skinId); } }, "导出"),
		                    h("button", { type: "button", className: "dsh-skins-btn dsh-skins-btn--danger", onClick: (event) => { event.stopPropagation(); void confirmDeleteSkins(props.ctx, store, [skin.skinId]); } }, "删除"),
		                  ),
		                );
		              }),
		            )
		          : h(
		              "div",
		              { className: "dsh-skins-grid", "data-dragging": drag === null ? "false" : "true" },
		              shown.map((skin) =>
		                h(SkinCard, {
		                  key: skin.skinId,
		                  skin,
		                  active: skin.skinId === view.skinId,
		                  favorite: favorites.includes(skin.skinId),
		                  batchActive: batch.active === true,
		                  selected: (batch.selected ?? []).includes(skin.skinId),
		                  dragging: drag !== null && drag.skinId === skin.skinId,
		                  dropBefore: dragOverId === skin.skinId && drag !== null && drag.skinId !== skin.skinId,
		                  onApply: (picked) => void applyById(props.ctx, store, picked.skinId),
		                  onToggleFavorite: (picked) => toggleFavorite(store, picked.skinId),
		                  onExport: (picked) => void exportSkin(store, picked.skinId),
		                  onSelect: (picked) => toggleBatchSelection(store, picked.skinId),
		                  onMenu: (picked, event) => openSkinMenu(props.ctx, store, picked, event.clientX, event.clientY),
		                  onDelete: (picked) => void confirmDeleteSkins(props.ctx, store, [picked.skinId]),
		                  onPress: (picked, event) => beginCardPress(store, picked.skinId, event),
		                  onDragMove: (event) => trackCardPress(store, event),
		                  onDrop: (event) => void finishCardPress(props.ctx, store, event),
		                  onCancelDrag: () => cancelDrag(store),
		                  onHoverStart: (picked) => startHoverPreview(store, picked),
		                  onHoverEnd: () => stopHoverPreview(store),
		                }),
		              ),
		            ),
		        catalog !== null && catalog !== undefined && shown.length === 0 ? h("p", { className: "dsh-skins-note" }, "没有匹配的皮肤。") : null,
		      ),

		      // ---- upload + generate ----
		      h(
		        Section,
		        { title: "新增素材", note: "图片 → input_image · 视频 → input_video" },
		        h(
		          "div",
		          {
		            className: "dsh-skins-drop",
		            "data-over": dropOver ? "true" : "false",
		            "data-busy": busy ? "true" : "false",
		            onDragEnter: onDragEnter,
		            onDragOver: onDragOver,
		            onDragLeave: onDragLeave,
		            onDrop: onDrop,
		          },
		          h(
		            "p",
		            { className: "dsh-skins-drop__hint" },
		            dropOver ? "松开鼠标即开始上传" : "把图片或视频拖到这里",
		          ),
		          h(
		            "p",
		            { className: "dsh-skins-drop__sub" },
		            dropOver ? "识别类型 → 复制到 input_* → 实测像素 → 生成皮肤" : "支持多选 · 松手即自动识别并生成",
		          ),
		          h(
		            "div",
		            { className: "dsh-skins-tools" },
		            h(
		              "label",
		              { className: "dsh-skins-btn", style: { display: "inline-block" } },
		              "选择文件…",
		              h("input", { type: "file", accept: "image/*,video/*", multiple: true, style: { display: "none" }, onChange: onPick, disabled: busy }),
		            ),
		            h(
		              "button",
		              {
		                type: "button",
		                className: "dsh-skins-btn dsh-skins-btn--primary",
		                disabled: busy || (job !== null && job !== undefined && job.status === "running"),
		                onClick: () => void startGenerate(store),
		              },
		              job !== null && job !== undefined && job.status === "running" ? "生成中…" : "只生成新皮肤",
		            ),
		          ),
		          queue.length === 0
		            ? null
		            : h(
		                "div",
		                { className: "dsh-skins-up" },
		                queue.map((row) =>
		                  h(
		                    "div",
		                    { key: row.name + row.size, className: "dsh-skins-up__row", "data-status": row.status },
		                    h("span", { className: "dsh-skins-up__name", title: row.name + " · " + formatBytes(row.size) }, row.name),
		                    h("span", { className: "dsh-skins-up__bar" }, h("i", { style: { width: row.percent + "%" } })),
		                    h(
		                      "span",
		                      { className: "dsh-skins-up__state" },
		                      row.status === "waiting"
		                        ? "等待"
		                        : row.status === "uploading"
		                          ? "上传 " + row.percent + "%"
		                          : row.status === "measuring"
		                            ? "测量中…"
		                            : row.status === "done"
		                              ? row.message
		                              : row.status === "skipped"
		                                ? row.message
		                                : "失败：" + row.message,
		                    ),
		                  ),
		                ),
		              ),
		        ),
		        h(JobSteps, { job }),
		        job === null || job === undefined
		          ? null
		          : h(
		              "div",
		              null,
		              h(
		                "p",
		                { className: "dsh-skins-note", style: { marginTop: "8px" } },
		                "生成任务：" +
		                  (job.status === "running" ? "运行中" : job.status === "succeeded" ? "完成" : job.status === "failed" ? "失败" : job.status) +
		                  (job.newSkins && job.newSkins.length > 0 ? " · 新增 " + job.newSkins.length + " 套" : "") +
		                  (job.message ? " · " + job.message : ""),
		              ),
		              job.log ? h("pre", { className: "dsh-skins-log" }, job.log) : null,
		            ),
		        view.panelReady === false && view.panelError ? h("p", { className: "dsh-skins-err" }, view.panelError) : null,
		      ),

		      // ---- assets: encoder, packs, cleanup ----
		      h(
		        Section,
		        { title: "素材与导出", note: assets.autoCompress ? "自动压缩 " + assets.targetHeight + "p / " + assets.bitrateMbps + " Mbps" : "自动压缩已关闭" },
		        // the encoder, and what to do when there is none
		        h(
		          "p",
		          { className: ffmpegReady ? "dsh-skins-note" : "dsh-skins-warn", style: { margin: "0 0 8px" } },          ffmpeg === null
		            ? "正在探测 ffmpeg …"
		            : ffmpeg.staleHost === true
		              ? "宿主半侧还是重启前的模块，压缩/导出/清理/导入都还不可用：请完全退出并重新启动 dsh 桌面端。"
		              : ffmpegReady
		                ? "ffmpeg：" + (ffmpeg.path === "ffmpeg.exe" || ffmpeg.path === "ffmpeg" ? "PATH 中的 " + ffmpeg.path : ffmpeg.path) + (ffmpeg.version ? " · " + String(ffmpeg.version).slice(0, 42) : "")
		                : "未找到 ffmpeg" + ffmpegReason + " —— 大视频不会被压缩。Windows 安装：winget install --id Gyan.FFmpeg -e，装好后点「重新探测」（原视频一直保留在 input_video/）",
		        ),
		        h(
		          "div",
		          { className: "dsh-skins-tools", style: { marginBottom: "8px" } },
		          h(
		            "button",
		            { type: "button", className: "dsh-skins-btn", onClick: () => void refreshFfmpeg(store, true) },
		            "重新探测 ffmpeg",
		          ),
		          h(
		            "button",
		            {
		              type: "button",
		              className: "dsh-skins-btn",
		              disabled: ffmpegReady !== true || compressing,
		              onClick: () => void startCompress(store, oversizedVideoIds, (...args) => console.log("[dsh-skins]", ...args)),
		            },
		            "压缩所有超阈值视频 (" + oversizedVideoIds.length + ")",
		          ),
		        ),
		        h(ToggleField, {
		          label: "大视频自动压缩",
		          checked: assets.autoCompress === true,
		          hint: "上传的视频超过阈值时，用 ffmpeg 转成 " + assets.targetHeight + "p / " + assets.bitrateMbps + " Mbps 再播放；原视频保留为备份",
		          onChange: (next) => setAssetSetting(store, { autoCompress: next }),
		        }),
		        h(
		          "div",
		          { className: "dsh-skins-auto-grid" },
		          h("span", { className: "dsh-skins-auto-label" }, "阈值"),
		          h("input", {
		            className: "dsh-skins-input dsh-skins-number",
		            type: "number",
		            min: 1,
		            max: 4096,
		            value: assets.thresholdMB,
		            "aria-label": "压缩阈值（MB）",
		            onChange: (event) => setAssetSetting(store, { thresholdMB: clamp(Number(event.target.value), 1, 4096) || 50 }),
		          }),
		          h("span", { className: "dsh-skins-auto-label" }, "目标高度"),
		          h(SkinSelectLike, {
		            values: ASSET_HEIGHTS.map((height) => ({ value: String(height), label: height + "p" })),
		            value: String(assets.targetHeight),
		            label: "目标高度",
		            onChange: (value) => setAssetSetting(store, { targetHeight: Number(value) }),
		          }),
		          h("span", { className: "dsh-skins-auto-label" }, "码率 Mbps"),
		          h("input", {
		            className: "dsh-skins-input dsh-skins-number",
		            type: "number",
		            min: 1,
		            max: 40,
		            value: assets.bitrateMbps,
		            "aria-label": "目标码率（Mbps）",
		            onChange: (event) => setAssetSetting(store, { bitrateMbps: clamp(Number(event.target.value), 1, 40) || 5 }),
		          }),
		        ),
		        compressing || assetJob !== null
		          ? h(
		              "div",
		              null,
		              h(
		                "p",
		                { className: "dsh-skins-note", style: { margin: "8px 0 0" } },
		                "压缩任务：" + (assetJob?.status ?? "—") + (assetJob?.message ? " · " + assetJob.message : "") + (compressing ? "（进行中，可继续用面板）" : ""),
		              ),
		              assetJob?.log ? h("pre", { className: "dsh-skins-log" }, assetJob.log) : null,
		            )
		          : null,
		        // ── export ────────────────────────────────────────────────────────────
		        h("div", { className: "dsh-skins-subhead" }, "皮肤包导出 / 导入"),
		        h(
		          "div",
		          { className: "dsh-skins-tools", style: { marginBottom: "8px" } },
		          h(
		            "button",
		            { type: "button", className: "dsh-skins-btn", disabled: noSkin, onClick: () => void exportSkin(store, view.skinId) },
		            "导出当前皮肤",
		          ),
		          h(
		            "button",
		            {
		              type: "button",
		              className: "dsh-skins-btn",
		              "data-on": assets.includeSource === true ? "true" : "false",
		              "aria-pressed": assets.includeSource === true ? "true" : "false",
		              onClick: () => setAssetSetting(store, { includeSource: assets.includeSource !== true }),
		            },
		            "包含原始视频",
		          ),
		          h(
		            "label",
		            { className: "dsh-skins-btn", style: { display: "inline-block" } },
		            "导入 .zip…",
		            h("input", {
		              type: "file",
		              accept: ".zip,application/zip",
		              style: { display: "none" },
		              onChange: (event) => {
		                const files = event.target.files;
		                if (files !== null && files !== undefined && files.length > 0) void importPack(props.ctx, store, files[0]);
		                event.target.value = "";
		              },
		            }),
		          ),
		        ),
		        h(
		          "p",
		          { className: "dsh-skins-note", style: { margin: "0 0 8px" } },
		          assets.includeSource === true
		            ? "导出会带上 input_video 里的原视频（包可能很大）；导入时它会回到 input_video/。"
		            : "默认只打包皮肤自身（含压缩后的播放副本 assets/source.mp4）；需要原视频就打开「包含原始视频」。",
		        ),
		        exportResult === null || exportResult === undefined
		          ? null
		          : h(
		              "p",
		              { className: exportResult.status === "ok" ? "dsh-skins-note" : "dsh-skins-err", style: { margin: "0 0 8px" } },
		              exportResult.status === "ok"
		                ? "已导出 " + exportResult.skinId + " → " + exportResult.file + "（" + formatBytes(exportResult.bytes) + " · " + exportResult.entries + " 项）"
		                : exportResult.status === "running"
		                  ? "正在打包 " + exportResult.skinId + " …"
		                  : "导出失败：" + exportResult.message,
		            ),
		        importResult === null || importResult === undefined
		          ? null
		          : h(
		              "p",
		              { className: importResult.status === "ok" ? "dsh-skins-note" : importResult.status === "running" ? "dsh-skins-note" : "dsh-skins-err", style: { margin: "0 0 8px" } },
		              importResult.status === "ok"
		                ? "已导入 " + importResult.skinId + (importResult.replaced ? "（覆盖了同名皮肤）" : "") + " · " + importResult.files + " 个文件" + (importResult.source ? " · 原视频回到 " + importResult.source : "") + (importResult.warnings?.length > 0 ? " · 注意：" + importResult.warnings.join("；") : "")
		                : importResult.status === "running"
		                  ? "正在导入 " + importResult.name + " … " + importResult.percent + "%"
		                  : "导入失败（" + importResult.name + "）：" + importResult.message,
		            ),
		        // ── cleanup ───────────────────────────────────────────────────────────
		        h("div", { className: "dsh-skins-subhead" }, "缓存清理"),
		        h(
		          "div",
		          { className: "dsh-skins-tools" },
		          h(
		            "button",
		            { type: "button", className: "dsh-skins-btn", disabled: cleanup?.status === "planning" || cleanup?.status === "running", onClick: () => void runCleanup(props.ctx, store, true) },
		            "清理未使用皮肤",
		          ),
		          cleanup?.status === "planned" && cleanup.remove.length > 0
		            ? h(
		                "button",
		                { type: "button", className: "dsh-skins-btn dsh-skins-btn--primary", onClick: () => void runCleanup(props.ctx, store, false) },
		                "确认移入回收站 (" + cleanup.remove.length + " · " + formatBytes(cleanup.totalBytes) + ")",
		              )
		            : null,
		          h("span", { className: "dsh-skins-note", style: { margin: 0 } }, "保留 " + (view.referenced ?? []).length + " 套（当前/收藏/已调参/自动化引用/默认）"),
		        ),
		        cleanup === null || cleanup === undefined
		          ? null
		          : cleanup.status === "planned"
		            ? h(
		                "div",
		                null,
		                h(
		                  "p",
		                  { className: "dsh-skins-note", style: { margin: "8px 0 0" } },
		                  cleanup.remove.length === 0
		                    ? "没有可清理的皮肤：目录里每一套都被引用着。"
		                    : "将移出 " + cleanup.remove.length + " 套（合计 " + formatBytes(cleanup.totalBytes) + "）。先看清单，确认后再移入回收站：",
		                ),
		                cleanup.remove.length === 0
		                  ? null
		                  : h(
		                      "div",
		                      { className: "dsh-skins-cleanlist" },
		                      cleanup.remove.map((row) => h("div", { key: row.skinId, className: "dsh-skins-cleanrow" }, h("span", null, row.skinId), h("span", null, formatBytes(row.bytes)))),
		                    ),
		              )
		            : h(
		                "div",
		                null,
		                h("p", { className: cleanup.status === "done" ? "dsh-skins-note" : "dsh-skins-err", style: { margin: "8px 0 0" } }, cleanup.status === "done" ? "清理完成 · 日志 " + cleanup.logFile : "清理失败：" + cleanup.message),
		                cleanup.log ? h("pre", { className: "dsh-skins-log" }, cleanup.log) : null,
		              ),
		      ),

		      // ---- advanced: UI knobs, recommendation, settings file ----
		      h(
		        Section,
		        { title: "UI 样式微调", note: "实时注入 CSS 变量" },
		        h("p", { className: "dsh-skins-note", style: { margin: "0 0 6px" } }, "圆角与字号写进外壳自己的 `--dsw-radius-*` / `--dsh-content-font-size-*`（以 important 优先级，因为外壳把它们内联在 body 上）；面板透明度作用于插件自己的面板与浮层。"),
		        h(SliderField, {
		          label: "全局圆角",
		          value: knobs.radius,
		          min: UI_KNOB_LIMITS.radius[0],
		          max: UI_KNOB_LIMITS.radius[1],
		          step: 1,
		          unit: "px",
		          onChange: (value) => setUiKnob(store, "radius", value),
		        }),
		        h(SliderField, {
		          label: "UI 字体缩放",
		          value: knobs.fontScale,
		          min: UI_KNOB_LIMITS.fontScale[0],
		          max: UI_KNOB_LIMITS.fontScale[1],
		          step: 5,
		          unit: "%",
		          onChange: (value) => setUiKnob(store, "fontScale", value),
		        }),
		        h(SliderField, {
		          label: "面板背景透明度",
		          value: knobs.panelAlpha,
		          min: UI_KNOB_LIMITS.panelAlpha[0],
		          max: UI_KNOB_LIMITS.panelAlpha[1],
		          step: 2,
		          unit: "%",
		          onChange: (value) => setUiKnob(store, "panelAlpha", value),
		        }),
		        h(
		          "div",
		          { className: "dsh-skins-tools" },
		          h("button", { type: "button", className: "dsh-skins-btn", onClick: () => { for (const key of Object.keys(UI_KNOB_DEFAULTS)) setUiKnob(store, key, UI_KNOB_DEFAULTS[key]); } }, "恢复默认外观"),
		          h("span", { className: "dsh-skins-note", style: { margin: 0 } }, "快捷键 " + (view.switchHotkey?.chord ?? "Ctrl + Shift + PageUp / PageDown") + (view.switchHotkey?.installed === true ? "（已全局监听）" : "（未安装）")),
		        ),
		        view.switchHotkey?.note ? h("p", { className: "dsh-skins-note", style: { margin: "4px 0 0" } }, view.switchHotkey.note) : null,
		      ),

		      h(
		        Section,
		        { title: "智能推荐", note: recommend.enabled === true ? (recommend.autoApply === true ? "按时段自动应用" : "仅提示") : "已关闭" },
		        h(ToggleField, {
		          label: "根据时段自动推荐",
		          checked: recommend.enabled === true,
		          hint: "白天推荐冷色/明亮皮肤，夜间推荐暗色或视频皮肤（" + recommend.start + "–" + recommend.end + "）",
		          onChange: (next) => {
		            setRecommend(store, { enabled: next });
		            if (next === true) evaluateRecommendation(props.ctx, store, "recommend-toggle");
		          },
		        }),
		        recommend.enabled === true
		          ? h(
		              "div",
		              { className: "dsh-skins-tools" },
		              h("span", { className: "dsh-skins-auto-label" }, "时段"),
		              h("input", { className: "dsh-skins-input dsh-skins-number", type: "time", value: recommend.start, "aria-label": "推荐时段开始", onChange: (event) => setRecommend(store, { start: event.target.value }) }),
		              h("span", { className: "dsh-skins-auto-label" }, "→"),
		              h("input", { className: "dsh-skins-input dsh-skins-number", type: "time", value: recommend.end, "aria-label": "推荐时段结束", onChange: (event) => setRecommend(store, { end: event.target.value }) }),
		            )
		          : null,
		        recommend.enabled === true
		          ? h(ToggleField, {
		              label: "自动应用推荐",
		              checked: recommend.autoApply === true,
		              hint: "只在本面板其它规则（项目/时段/跟随系统/轮播）都没有命中时才应用，绝不抢它们的优先级",
		              onChange: (next) => {
		                setRecommend(store, { autoApply: next });
		                if (next === true) evaluateRecommendation(props.ctx, store, "recommend-auto");
		              },
		            })
		          : null,
		        recommend.enabled === true
		          ? h(
		              "div",
		              null,
		              h(
		                "p",
		                { className: "dsh-skins-note", style: { margin: "6px 0 4px" } },
		                "候选池：白天 " + ((recommend.dayPool ?? []).length > 0 ? "自定义 " + recommend.dayPool.length + " 套" : "自动") + " · 夜间 " + ((recommend.nightPool ?? []).length > 0 ? "自定义 " + recommend.nightPool.length + " 套" : "自动"),
		              ),
		              h(
		                "div",
		                { className: "dsh-skins-tools" },
		                h("button", { type: "button", className: "dsh-skins-btn", disabled: noSkin, onClick: () => setRecommend(store, { dayPool: Array.from(new Set((recommend.dayPool ?? []).concat(view.skinId))) }) }, "把当前皮肤加入白天候选"),
		                h("button", { type: "button", className: "dsh-skins-btn", disabled: noSkin, onClick: () => setRecommend(store, { nightPool: Array.from(new Set((recommend.nightPool ?? []).concat(view.skinId))) }) }, "加入夜间候选"),
		                h("button", { type: "button", className: "dsh-skins-btn", onClick: () => setRecommend(store, { dayPool: [], nightPool: [] }) }, "清空候选池"),
		                h("button", { type: "button", className: "dsh-skins-btn", onClick: () => evaluateRecommendation(props.ctx, store, "recommend-manual") }, "立即评估"),
		              ),
		            )
		          : null,
		        view.recommendDecision === null || view.recommendDecision === undefined
		          ? null
		          : h(
		              "p",
		              { className: "dsh-skins-note", style: { margin: "6px 0 0" } },
		              "当前建议：" + skinLabel(skins.find((skin) => skin.skinId === view.recommendDecision.skinId) ?? null) + " · " + view.recommendDecision.detail,
		            ),
		      ),

		      h(
		        Section,
		        { title: "配置导出 / 导入", note: view.settingsFile === null || view.settingsFile === undefined ? "未导出" : "上次导出 " + view.settingsFile.split("/").at(-1) },
		        h("p", { className: "dsh-skins-note", style: { margin: "0 0 8px" } }, "整份面板配置（偏好、排序、标签、规则、推荐、快捷键、UI 微调、自定义 CSS）写成 output/reports/skins-settings.json；导入会覆盖对应项并立即生效。"),
		        h(
		          "div",
		          { className: "dsh-skins-tools" },
		          h("button", { type: "button", className: "dsh-skins-btn", onClick: () => void exportSettings(store) }, "导出 settings.json"),
		          h(
		            "label",
		            { className: "dsh-skins-btn", style: { display: "inline-block" } },
		            "导入 settings.json…",
		            h("input", {
		              type: "file",
		              accept: ".json,application/json",
		              style: { display: "none" },
		              onChange: (event) => {
		                const files = event.target.files;
		                if (files === null || files === undefined || files.length === 0) return;
		                const file = files[0];
		                const reader = new FileReader();
		                reader.addEventListener("load", () => {
		                  let parsed = null;
		                  try {
		                    parsed = JSON.parse(String(reader.result));
		                  } catch (error) {
		                    store.settingsNote = "导入失败：不是有效 JSON（" + String(error && error.message ? error.message : error) + "）";
		                    logOperation(store, "error", store.settingsNote);
		                    publish(store, {});
		                    return;
		                  }
		                  void importSettings(props.ctx, store, parsed);
		                });
		                reader.readAsText(file);
		                event.target.value = "";
		              },
		            }),
		          ),
		          h("button", { type: "button", className: "dsh-skins-btn dsh-skins-btn--danger", onClick: () => void resetSettings(props.ctx, store) }, "恢复默认设置"),
		        ),
		        view.settingsNote ? h("p", { className: "dsh-skins-err", style: { margin: "6px 0 0" } }, view.settingsNote) : null,
		      ),

		      // ---- automation ----
		      h(
		        Section,
		        { title: "自动化", note: view.automationNote ?? "无规则命中" },
		        h("p", { className: "dsh-skins-note", style: { margin: "0 0 8px" } }, "优先级：项目绑定 → 时间段 → 跟随系统 → 轮播（仅在前三者都没命中时生效）。手动切换会保留，直到某条规则的目标发生变化。"),
		        // ── system colour scheme ──────────────────────────────────────────────
		        h(ToggleField, {
		          label: "跟随系统深浅色",
		          checked: auto.system.enabled === true,
		          hint: "系统深色 / 浅色各指定一套皮肤（读的是系统偏好，不受应用内主题固定影响）",
		          onChange: (next) => setAutomation(props.ctx, store, { system: { enabled: next } }),
		        }),
		        auto.system.enabled === true
		          ? h(
		              "div",
		              { className: "dsh-skins-auto-grid" },
		              h("span", { className: "dsh-skins-auto-label" }, "深色"),
		              h(SkinSelect, {
		                skins,
		                label: "系统深色时使用的皮肤",
		                value: auto.system.dark,
		                onChange: (value) => setAutomation(props.ctx, store, { system: { dark: value } }),
		              }),
		              h("span", { className: "dsh-skins-auto-label" }, "浅色"),
		              h(SkinSelect, {
		                skins,
		                label: "系统浅色时使用的皮肤",
		                value: auto.system.light,
		                onChange: (value) => setAutomation(props.ctx, store, { system: { light: value } }),
		              }),
		            )
		          : null,
		        // ── time range ────────────────────────────────────────────────────────
		        h(ToggleField, {
		          label: "时间段切换",
		          checked: auto.time.enabled === true,
		          hint: "支持跨午夜（如 22:00–06:00）；切换发生在分钟边界",
		          onChange: (next) => setAutomation(props.ctx, store, { time: { enabled: next } }),
		        }),
		        auto.time.enabled === true
		          ? h(
		              "div",
		              { className: "dsh-skins-auto-block" },
		              h(
		                "div",
		                { className: "dsh-skins-tools" },
		                h("input", {
		                  className: "dsh-skins-input dsh-skins-time",
		                  type: "time",
		                  value: auto.time.start,
		                  "aria-label": "时段开始",
		                  onChange: (event) => setAutomation(props.ctx, store, { time: { start: event.target.value } }),
		                }),
		                h("span", { className: "dsh-skins-auto-label" }, "–"),
		                h("input", {
		                  className: "dsh-skins-input dsh-skins-time",
		                  type: "time",
		                  value: auto.time.end,
		                  "aria-label": "时段结束",
		                  onChange: (event) => setAutomation(props.ctx, store, { time: { end: event.target.value } }),
		                }),
		              ),
		              h(
		                "div",
		                { className: "dsh-skins-auto-grid" },
		                h("span", { className: "dsh-skins-auto-label" }, "时段内"),
		                h(SkinSelect, {
		                  skins,
		                  label: "时段内使用的皮肤",
		                  value: auto.time.day,
		                  onChange: (value) => setAutomation(props.ctx, store, { time: { day: value } }),
		                }),
		                h("span", { className: "dsh-skins-auto-label" }, "其余"),
		                h(SkinSelect, {
		                  skins,
		                  label: "其余时间使用的皮肤",
		                  value: auto.time.night,
		                  onChange: (value) => setAutomation(props.ctx, store, { time: { night: value } }),
		                }),
		              ),
		            )
		          : null,
		        // ── project binding ───────────────────────────────────────────────────
		        h(ToggleField, {
		          label: "项目绑定",
		          checked: auto.project.enabled === true,
		          hint:
		            view.currentWorkspaceLabel === null
		              ? "切换到绑定项目所在的工作区时自动换肤（当前会话的工作区还未知）"
		              : "当前工作区：" + view.currentWorkspaceLabel,
		          onChange: (next) => setAutomation(props.ctx, store, { project: { enabled: next } }),
		        }),
		        auto.project.enabled === true
		          ? h(
		              "div",
		              { className: "dsh-skins-auto-block" },
		              view.workspaceItems.length === 0
		                ? h(
		                    "p",
		                    { className: "dsh-skins-note", style: { margin: 0 } },
		                    "还没取得工作区列表：面板渲染时才会从工作区快照采集。请从左侧工作区列表切一次会话，或重新打开本面板。也可以手动填入项目路径：",
		                  )
		                : null,
		              view.workspaceItems.map((item) =>
		                h(
		                  "div",
		                  { key: item.key, className: "dsh-skins-auto-grid" },
		                  h("span", { className: "dsh-skins-auto-label", title: item.path }, item.label),
		                  h(SkinSelect, {
		                    skins,
		                    label: item.label + " 绑定的皮肤",
		                    value: auto.project.bindings[item.key] ?? null,
		                    onChange: (value) => {
		                      const bindings = Object.assign({}, auto.project.bindings);
		                      if (value === null) delete bindings[item.key];
		                      else bindings[item.key] = value;
		                      setAutomation(props.ctx, store, { project: { bindings } });
		                    },
		                  }),
		                ),
		              ),
		              h(
		                "div",
		                { className: "dsh-skins-tools" },
		                h("input", {
		                  className: "dsh-skins-input",
		                  type: "text",
		                  placeholder: "或手动填入项目路径，如 D:\\Work\\MyProject",
		                  value: bindPath,
		                  "aria-label": "手动填入项目路径",
		                  style: { flex: "1 1 150px", width: "auto" },
		                  onChange: (event) => setBindPath(event.target.value),
		                }),
		                h(
		                  "button",
		                  {
		                    type: "button",
		                    className: "dsh-skins-btn",
		                    disabled: workspaceKey(bindPath) === null,
		                    onClick: () => {
		                      const key = workspaceKey(bindPath);
		                      if (key === null) return;
		                      const bindings = Object.assign({}, auto.project.bindings, { [key]: view.skinId ?? "" });
		                      setAutomation(props.ctx, store, { project: { bindings } });
		                      setBindPath("");
		                    },
		                  },
		                  "绑定当前皮肤",
		                ),
		              ),
		              h(
		                "p",
		                { className: "dsh-skins-note", style: { margin: "6px 0 0" } },
		                "工作区列表采集于 " + (view.workspaceIndexAt === null ? "（尚未采集）" : view.workspaceIndexAt.slice(11, 19)) + "；绑定按项目路径记录，重新登记工作区也不会失效。",
		              ),
		            )
		          : null,
		        // ── rotation ──────────────────────────────────────────────────────────
		        h(ToggleField, {
		          label: "轮播",
		          checked: auto.rotation.enabled === true,
		          hint: "每隔 N 分钟随机换一套；有规则命中时自动让位",
		          onChange: (next) => setAutomation(props.ctx, store, { rotation: { enabled: next } }),
		        }),
		        auto.rotation.enabled === true
		          ? h(
		              "div",
		              { className: "dsh-skins-tools" },
		              h("span", { className: "dsh-skins-auto-label" }, "每"),
		              h("input", {
		                className: "dsh-skins-input dsh-skins-number",
		                type: "number",
		                min: 1,
		                max: 1440,
		                value: auto.rotation.minutes,
		                "aria-label": "轮播间隔（分钟）",
		                onChange: (event) => setAutomation(props.ctx, store, { rotation: { minutes: clamp(Number(event.target.value), 1, 1440) || 30 } }),
		              }),
		              h("span", { className: "dsh-skins-auto-label" }, "分钟"),
		              h(
		                "button",
		                {
		                  type: "button",
		                  className: "dsh-skins-btn",
		                  "data-on": auto.rotation.favoritesOnly === true ? "true" : "false",
		                  "aria-pressed": auto.rotation.favoritesOnly === true ? "true" : "false",
		                  onClick: () => setAutomation(props.ctx, store, { rotation: { favoritesOnly: auto.rotation.favoritesOnly !== true } }),
		                },
		                "仅收藏",
		              ),
		            )
		          : null,
		        h(
		          "div",
		          { className: "dsh-skins-tools", style: { marginTop: "10px" } },
		          h(
		            "button",
		            { type: "button", className: "dsh-skins-btn", onClick: () => void evaluateAutomation(props.ctx, store, "manual") },
		            "立即应用规则",
		          ),
		          h(
		            "button",
		            { type: "button", className: "dsh-skins-btn", onClick: () => void rotate(props.ctx, store) },
		            "立即轮播一次",
		          ),
		          h("span", { className: "dsh-skins-note", style: { margin: 0 } }, (view.mountedSource === "sidebarRight" ? "会话切换已监听" : "会话切换靠轮询") + " · 定时器 " + (view.automationTimers ?? 0) + " 个"),
		        ),
		        view.automationDecision === null || view.automationDecision === undefined
		          ? null
		          : h(
		              "p",
		              { className: "dsh-skins-note", style: { margin: "8px 0 0" } },
		              "命中：" + view.automationDecision.sourceLabel + " → " + skinLabel(skins.find((skin) => skin.skinId === view.automationDecision.skinId) ?? null) + " · " + view.automationDecision.detail,
		            ),
		      ),

		      // ---- developer options (deliberately the last section) ----
		      h(
		        Section,
		        { title: "开发者选项", note: view.customCssApplied === true ? "CSS 已注入 " + cssCheck.chars + " 字符" : view.focusMode === true ? "专注模式已开启" : "折叠式进阶玩法" },
		        // ── focus mode + eyedropper ──────────────────────────────────────────
		        h(
		          "div",
		          { className: "dsh-skins-tools" },
		          h(
		            "button",
		            {
		              type: "button",
		              className: "dsh-skins-btn",
		              "data-on": view.focusMode === true ? "true" : "false",
		              "aria-pressed": view.focusMode === true ? "true" : "false",
		              title: focusConflicts.length > 0 ? "自定义 CSS 会隐藏/冻结根布局，专注模式已被阻止" : "隐藏侧边栏、聊天区与标题栏，只留背景与这个面板（Esc 退出，快捷键 " + (view.focusHotkey?.chord ?? "Ctrl + Shift + Alt + Space") + "）",
		              onClick: () => void toggleFocusMode(store),
		            },
		            view.focusMode === true ? "退出专注模式" : focusConflicts.length > 0 ? "专注模式（被 CSS 阻止）" : "专注模式（隐藏全部 UI）",
		          ),
		          h(
		            "span",
		            { className: "dsh-skins-note", style: { margin: 0, alignSelf: "center" } },
		            "快捷键 " + (view.focusHotkey?.chord ?? "Ctrl + Shift + Alt + Space") + (view.focusHotkey?.installed === true ? "（全局生效）" : view.focusHotkey === null ? "（未安装）" : "（监听未装上）"),
		          ),
		          h(
		            "button",
		            {
		              type: "button",
		              className: "dsh-skins-btn",
		              "data-on": picking ? "true" : "false",
		              onClick: () => startPicker(store, (hex) => void setAccentOverride(props.ctx, store, hex)),
		            },
		            picking ? "取色中…（Esc 取消）" : "吸管取色",
		          ),
		          view.accentOverride === null || view.accentOverride === undefined
		            ? null
		            : h(
		                "button",
		                { type: "button", className: "dsh-skins-btn", onClick: () => void clearAccentOverride(props.ctx, store) },
		                "清除强调色",
		              ),
		        ),
		        view.accentOverride === null || view.accentOverride === undefined
		          ? h("p", { className: "dsh-skins-note", style: { margin: "6px 0 0" } }, "吸管：点一下按钮，然后在背景任意处点击取色 —— 该颜色会成为全局 UI 强调色，并自动保证可读对比度。")
		          : h(
		              "p",
		              { className: "dsh-skins-note", style: { margin: "6px 0 0" } },
		              "强调色 " + view.accentOverride.color + (view.accentOverride.shifted === true ? "（所选的 " + view.accentOverride.picked + " 对比度不足，保持了色相/饱和度、只调了明度）" : "（原样采用）") + " · 与面板 " + Number(view.accentOverride.against).toFixed(2) + ":1 · 文字 " + Number(view.accentOverride.inkRatio).toFixed(2) + ":1 · 判定依据 " + view.accentOverride.surfaceNote,
		            ),
		        view.focusNote === null || view.focusNote === undefined ? null : h("p", { className: "dsh-skins-note", style: { margin: "6px 0 0" } }, view.focusNote + " · Esc 也可退出"),
		        // The hotkey's own diagnostics: a refusal from the registry is information,
		        // not a failure — the listener works either way — but the user should see it.
		        view.focusHotkey?.conflict
		          ? h("p", { className: "dsh-skins-warn", style: { margin: "6px 0 0" } }, "快捷键注册提示：" + view.focusHotkey.conflict + "。全局监听仍然生效；如果按下没反应，说明该组合被系统或其他软件占用了，换一个组合即可。")
		          : null,
		        view.focusHotkey?.missed?.length > 0
		          ? h("p", { className: "dsh-skins-note", style: { margin: "6px 0 0" } }, "最近看到的三键组合（未匹配 Space）：Ctrl+Shift+Alt+" + view.focusHotkey.missed.join(" / Ctrl+Shift+Alt+"))
		          : null,
		        view.focusRecovered === true
		          ? h("p", { className: "dsh-skins-warn", style: { margin: "6px 0 0" } }, "检测到上次是非正常退出（关闭时专注模式还开着），已自动重置为默认模式；专注模式不会在启动时自动恢复。")
		          : null,
		        // The fool-proofing, surfaced where the user can act on it.
		        focusConflicts.length > 0
		          ? h(
		              "p",
		              { className: "dsh-skins-warn", style: { margin: "6px 0 0" } },
		              "自定义 CSS 里有 " + focusConflicts.length + " 条会隐藏/冻结根布局的规则，专注模式已被阻止（否则连退出按钮都会一起消失）：" + focusConflicts.map((row) => row.selector + " { " + row.declaration + " }").join("；"),
		            )
		          : null,
		        view.pickNote === null || view.pickNote === undefined ? null : h("p", { className: "dsh-skins-err", style: { margin: "6px 0 0" } }, view.pickNote),
		        // ── custom CSS ───────────────────────────────────────────────────────
		        h("div", { className: "dsh-skins-subhead" }, "自定义 CSS 注入"),
		        h("textarea", {
		          className: "dsh-skins-css",
		          value: view.customCss,
		          spellCheck: false,
		          rows: 8,
		          "aria-label": "自定义 CSS",
		          placeholder: "/* 实时注入到整个界面，例如把某个组件的圆角改大 */\n.some-component {\n  border-radius: 14px;\n}",
		          onChange: (event) => setCustomCss(store, event.target.value),
		        }),
		        h(
		          "div",
		          { className: "dsh-skins-tools", style: { marginTop: "6px" } },
		          h(
		            "button",
		            { type: "button", className: "dsh-skins-btn", onClick: () => setCustomCss(store, CUSTOM_CSS_SAMPLE) },
		            "插入示例",
		          ),
		          h("button", { type: "button", className: "dsh-skins-btn", onClick: () => clearCustomCss(store) }, "清空"),
		          h(
		            "span",
		            { className: cssCheck.ok === true ? "dsh-skins-note" : "dsh-skins-err", style: { margin: 0 } },
		            cssCheck.ok === true
		              ? "语法通过 · " + cssCheck.rules + " 条规则 · " + cssCheck.lines + " 行" + (cssCheck.warnings.length > 0 ? " · " + cssCheck.warnings.length + " 条提醒" : "")
		              : cssCheck.errors.length + " 个语法问题：未应用的草稿不会替换上一次可用的样式",
		          ),
		        ),
		        cssCheck.errors.length === 0 && cssCheck.warnings.length === 0
		          ? null
		          : h(
		              "div",
		              { className: "dsh-skins-cssissues" },
		              cssCheck.errors.concat(cssCheck.warnings).map((row, index) =>
		                h("div", { key: index, className: row.kind === "warn" ? "dsh-skins-cssissue dsh-skins-cssissue--warn" : "dsh-skins-cssissue" }, "第 " + row.line + " 行 " + row.column + " 列 · " + row.message),
		              ),
		            ),
		      ),

		      // ---- the bottom log area (deletions, ordering, bulk exports) ----
		      h(
		        Section,
		        { title: "操作日志", note: (view.opLog ?? []).length === 0 ? "暂无记录" : "最近 " + Math.min((view.opLog ?? []).length, 12) + " 条" },
		        // ── runtime block: the resource picture, refreshed on a timer ──────────
		        h(
		          "div",
		          { className: "dsh-skins-runtime" },
		          h("span", { className: "dsh-skins-runtime__title" }, "运行状态"),
		          h(
		            "span",
		            { className: "dsh-skins-runtime__grid" },
		            h("span", null, "视频元素 " + (runtime?.videos ?? 0) + " / " + (runtime?.videoLimit ?? MAX_VIDEO_ELEMENTS)),
		            h("span", null, "缩略图 " + (runtime?.thumbsLoaded ?? 0) + " 已加载 · " + (runtime?.thumbsPending ?? 0) + " 待加载"),
		            h("span", null, "估算内存 ≈ " + (runtime?.estimatedMB ?? 0) + " MB"),
		            h("span", null, "当前皮肤素材 " + (runtime?.playbackMB ?? 0) + " MB"),
		            h(
		              "span",
		              { className: runtime?.paused === true ? "dsh-skins-runtime__paused" : "dsh-skins-runtime__ok" },
		              runtime?.paused === true ? "背景已暂停（" + (runtime?.pauseReason === "blur" ? "窗口失焦" : "窗口不可见") + "）" : runtime?.playing === true ? "背景播放中" : "背景未播放",
		            ),
		          ),
		          h(
		            "button",
		            { type: "button", className: "dsh-skins-btn", onClick: () => tickRuntimeStatus(store) },
		            "刷新",
		          ),
		        ),
		        (view.opLog ?? []).length === 0
		          ? h("p", { className: "dsh-skins-note", style: { margin: 0 } }, "拖拽排序、删除皮肤、批量导出都会记录在这里；删除的完整日志同时写入 output/reports/skins-cleanup-*.log。")
		          : h(
		              "div",
		              { className: "dsh-skins-oplog" },
		              (view.opLog ?? []).slice(0, 12).map((row, index) =>
		                h(
		                  "div",
		                  { key: index, className: "dsh-skins-oplog__row", "data-kind": row.kind },
		                  h("span", { className: "dsh-skins-oplog__time" }, row.at.slice(11, 19)),
		                  h("span", { className: "dsh-skins-oplog__kind" }, row.kind),
		                  h("span", { className: "dsh-skins-oplog__msg" }, row.message),
		                ),
		              ),
		            ),
		      ),
		    ),
		  );
		}

		/** A select over arbitrary `{ value, label }` rows — used for the numeric enums. */
		function SkinSelectLike(props) {
		  return h(
		    "select",
		    {
		      className: "dsh-skins-select",
		      value: props.value,
		      "aria-label": props.label,
		      disabled: props.disabled === true,
		      onChange: (event) => props.onChange(event.target.value),
		    },
		    props.values.map((row) => h("option", { key: row.value, value: row.value }, row.label)),
		  );
		}

		/** A select over the catalog, with an explicit "do nothing" option. */
		function SkinSelect(props) {
		  return h(
		    "select",
		    {
		      className: "dsh-skins-select",
		      value: props.value ?? "",
		      "aria-label": props.label,
		      disabled: props.disabled === true,
		      onChange: (event) => props.onChange(event.target.value === "" ? null : event.target.value),
		    },
		    h("option", { value: "" }, "（不切换）"),
		    props.skins.map((skin) => h("option", { key: skin.skinId, value: skin.skinId }, skinLabel(skin))),
		  );
		}

		/** The start-page card glyph: a framed picture, drawn with the surrounding text color. */
		function panelGlyph(props) {
		  const size = props && Number.isFinite(props.size) ? props.size : 26;
		  return h(
		    "svg",
		    { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true", className: props ? props.className : undefined },
		    h("rect", { x: "3", y: "4.5", width: "18", height: "15", rx: "2.5", stroke: "currentColor", strokeWidth: "1.5" }),
		    h("circle", { cx: "8.5", cy: "9.5", r: "1.5", fill: "currentColor" }),
		    h("path", { d: "M4 16.5l4.5-4.5 3.5 3.5 3-2.5L20 17", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }),
		  );
		}

		/* ------------------------------------------------------------------ *
		 * Random skin, and the two application shortcuts
		 * ------------------------------------------------------------------ */

		/** A random skin other than the one already on screen. */
		function randomOtherSkin(state) {
		  const skins = state.catalog.skins;
		  if (skins.length === 0) return null;
		  const pool = skins.filter((skin) => skin.skinId !== state.skinId);
		  const from = pool.length > 0 ? pool : skins;
		  return from[Math.floor(Math.random() * from.length)] ?? null;
		}

		/** Apply a random skin. Shared by the panel's 随机 button and Ctrl+Shift+R. */
		async function applyRandom(ctx, state, reason) {
		  const skin = randomOtherSkin(state);
		  if (skin === null) return null;
		  return switchTo(ctx, state, skin, reason);
		}

		/** Why the settings page cannot be shown right now, or null when it can. */
		function panelToggleBlockedReason(ctx) {
		  const sidebar = ctx.get("sidebarRight");
		  if (sidebar === undefined || sidebar === null) return "右侧边栏不可用";
		  try {
		    const mounted = sidebar.mounted && typeof sidebar.mounted.getSnapshot === "function" ? sidebar.mounted.getSnapshot() : undefined;
		    if (mounted === undefined) return "请先选择会话（右侧边栏需要会话）";
		  } catch {
		    /* an unreadable observable is not a reason to refuse */
		  }
		  return null;
		}

		/** Open the settings page, or collapse the column when it is already showing it. */
		function togglePanel(ctx) {
		  const sidebar = ctx.get("sidebarRight");
		  if (sidebar === undefined || sidebar === null) return;
		  const active = typeof sidebar.active === "function" ? sidebar.active() : undefined;
		  if (sidebar.isExpanded() === true && active !== undefined && active !== null && active.kind === TAB_KIND) {
		    sidebar.toggleExpanded();
		    return;
		  }
		  sidebar.openTab(TAB_KIND);
		}

		/** One row of the live shortcut catalog, or null when it is unreadable. */
		function shortcutRow(ctx, id) {
		  try {
		    const shortcuts = ctx.get("shortcuts");
		    const catalog = shortcuts === null || shortcuts === undefined ? null : shortcuts.catalog;
		    const rows = catalog && typeof catalog.getSnapshot === "function" ? catalog.getSnapshot() : null;
		    if (!Array.isArray(rows)) return null;
		    return rows.find((entry) => entry !== null && entry !== undefined && entry.id === id) ?? null;
		  } catch {
		    return null;
		  }
		}

		/** The effective keycaps the shortcut reference shows, e.g. `Ctrl+Shift+R`. */
		function shortcutKeysOf(row) {
		  if (row === null) return null;
		  // The catalog's `keys` is a keycap token list that already carries its own
		  // "+" separators (the shipped ShortcutKeys component renders them as chips),
		  // so joining with a separator would double them.
		  if (Array.isArray(row.keys) && row.keys.length > 0) {
		    const joined = row.keys.join("");
		    if (joined.length > 0) return joined;
		  }
		  return typeof row.aria === "string" && row.aria.length > 0 ? row.aria : null;
		}

		/** A short diagnostic for the report: whether the binding is enabled and clean. */
		function shortcutDiagOf(row) {
		  if (row === null) return null;
		  return {
		    keys: Array.isArray(row.keys) ? row.keys : [],
		    issue: row.issue ?? null,
		    conflicts: Array.isArray(row.conflicts) ? row.conflicts.length : 0,
		    modified: row.modified === true,
		  };
		}

		/** The labels the panel shows for a chord the local listener owns. */
		const DOM_SHORTCUT_KEYS = { [COMMAND_TOGGLE]: "Ctrl/Cmd + Shift + B", [COMMAND_RANDOM]: "Ctrl/Cmd + Shift + R" };

		/** Rebuild both hints from the live catalog, honouring which half owns each chord. */
		function refreshShortcutHints(ctx, state) {
		  const hint = (id) => {
		    const row = shortcutRow(ctx, id);
		    if (state.shortcutOwner[id] === "service") return shortcutKeysOf(row);
		    return DOM_SHORTCUT_KEYS[id] ?? null;
		  };
		  state.shortcutKeys = { toggle: hint(COMMAND_TOGGLE), random: hint(COMMAND_RANDOM) };
		  state.shortcutDiag = { toggle: shortcutDiagOf(shortcutRow(ctx, COMMAND_TOGGLE)), random: shortcutDiagOf(shortcutRow(ctx, COMMAND_RANDOM)) };
		  publish(state, {});
		}

		/**
		 * The device profiles a default can be declared for.
		 *
		 * Linux Web is absent because the service admits only a short allow-list there;
		 * an omitted profile is simply unbound rather than rejected.
		 */
		const SHORTCUT_PROFILES = ["desktop:windows", "desktop:macos", "desktop:linux", "web:windows", "web:macos"];
		/**
		 * `Ctrl/Cmd+Shift+B` is a *shipped* default of `sidebar.right.toggle` on the Web
		 * profiles, and the service rejects overlapping defaults even though this
		 * profile's own keybindings.json has that binding cleared. Desktop declares no
		 * such default, so the toggle is registered for the three desktop profiles and
		 * the local listener covers the Web ones — where the chord is the shipped
		 * "collapse the right column" key anyway.
		 */
		const TOGGLE_PROFILES = SHORTCUT_PROFILES.filter((profile) => profile.startsWith("desktop:"));
		/** The regions a binding is active in — the service derives exactly these three from focus. */
		const SHORTCUT_REGIONS = ["page", "editable", "terminal"];

		/** `primary + Shift + <code>` on every profile the service admits for it. */
		function shortcutDefaults(code, profiles) {
		  const defaults = {};
		  for (const profile of profiles) defaults[profile] = { code, modifiers: ["primary", "shift"] };
		  return defaults;
		}

		/**
		 * Register the two chords with the application's shortcut service.
		 *
		 * The service validates hard — a duplicate id, a reserved combination, or a
		 * default that collides with a shipped command throws — so each command is
		 * attempted on its own. One refusal therefore costs only that chord's native
		 * registration, and the panel's own listener keeps it working; `shortcutNote`
		 * records exactly what happened, because "the key works" and "the key is
		 * registered" are different facts and only the second one is visible in the
		 * application's shortcut reference.
		 */
		function registerShortcuts(ctx, state) {
		  const shortcuts = ctx.get("shortcuts");
		  if (shortcuts === undefined || shortcuts === null || typeof shortcuts.register !== "function") {
		    state.shortcutNote = "service-absent";
		    reportShortcutState(state);
		    return null;
		  }
		  const disposers = [];
		  const refusals = [];
		  const attempt = (id, options) => {
		    try {
		      disposers.push(shortcuts.register(options));
		      state.shortcutOwner[id] = "service";
		    } catch (error) {
		      state.shortcutOwner[id] = "dom";
		      refusals.push(id + ": " + String(error && error.message ? error.message : error));
		      console.warn("[dsh-skins] the shortcut service refused " + id + "; the local listener keeps it working", error);
		    }
		  };

		  attempt(COMMAND_TOGGLE, {
		    id: COMMAND_TOGGLE,
		    label: () => "打开 / 关闭「背景设置」面板",
		    aliases: ["background settings", "skins panel", "beijing shezhi"],
		    defaults: shortcutDefaults("KeyB", TOGGLE_PROFILES),
		    regions: SHORTCUT_REGIONS,
		    modals: [],
		    resolve: () => {
		      const reason = panelToggleBlockedReason(ctx);
		      if (reason !== null) return { status: "blocked", reason };
		      return {
		        status: "handled",
		        run: () => {
		          try {
		            togglePanel(ctx);
		          } catch (error) {
		            console.warn("[dsh-skins] could not toggle the settings page", error);
		          }
		        },
		      };
		    },
		  });

		  attempt(COMMAND_RANDOM, {
		    id: COMMAND_RANDOM,
		    label: () => "随机切换一套背景皮肤",
		    aliases: ["random skin", "random background", "suiji pifu"],
		    defaults: shortcutDefaults("KeyR", SHORTCUT_PROFILES),
		    regions: SHORTCUT_REGIONS,
		    modals: [],
		    resolve: () => {
		      if (randomOtherSkin(state) === null) return { status: "blocked", reason: "皮肤目录为空" };
		      return { status: "handled", run: () => void applyRandom(ctx, state, "shortcut-random") };
		    },
		  });

		  const owners = [state.shortcutOwner[COMMAND_TOGGLE], state.shortcutOwner[COMMAND_RANDOM]];
		  state.shortcutMode = owners.every((value) => value === "service") ? "service" : owners.some((value) => value === "service") ? "mixed" : "dom";
		  state.shortcutNote = refusals.length === 0 ? "service-ok" : "service-refused: " + refusals.join(" | ");
		  refreshShortcutHints(ctx, state);
		  reportShortcutState(state);
		  // Effective keys settle with the catalog's next revision, so follow it.
		  try {
		    const catalog = shortcuts.catalog;
		    if (catalog && typeof catalog.subscribe === "function") disposers.push(catalog.subscribe(() => refreshShortcutHints(ctx, state)));
		  } catch {
		    /* a missing catalog only costs the keycap hint */
		  }
		  return () => {
		    for (const dispose of disposers.reverse()) {
		      try {
		        dispose();
		      } catch {
		        /* ignore */
		      }
		    }
		  };
		}

		/**
		 * The same two chords on a plain document listener.
		 *
		 * Modifier chords cannot produce text, so they are safe to read from anywhere,
		 * and the listener runs in the capture phase so a focused control cannot
		 * swallow them first. It stays installed for the life of the fiber but acts
		 * only for the chords the service does not own, which keeps exactly one owner
		 * per chord in every combination of outcomes.
		 */
		function installFallbackKeys(ctx, state) {
		  if (typeof state.disposeFallbackKeys === "function") return state.disposeFallbackKeys;
		  const listener = (event) => {
		    if (event.defaultPrevented || event.repeat) return;
		    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
		    if (event.code === "KeyB" && state.shortcutOwner[COMMAND_TOGGLE] !== "service") {
		      event.preventDefault();
		      try {
		        togglePanel(ctx);
		      } catch (error) {
		        console.warn("[dsh-skins] could not toggle the settings page", error);
		      }
		      return;
		    }
		    if (event.code === "KeyR" && state.shortcutOwner[COMMAND_RANDOM] !== "service") {
		      event.preventDefault();
		      void applyRandom(ctx, state, "shortcut-random");
		    }
		  };
		  document.addEventListener("keydown", listener, true);
		  const dispose = () => {
		    document.removeEventListener("keydown", listener, true);
		    state.disposeFallbackKeys = null;
		  };
		  state.disposeFallbackKeys = dispose;
		  state.shortcutMode = "dom";
		  state.shortcutNote = state.shortcutNote === "waiting-for-service" ? "local-listener" : state.shortcutNote;
		  refreshShortcutHints(ctx, state);
		  reportShortcutState(state);
		  return dispose;
		}

		/* ------------------------------------------------------------------ *
		 * Mounting the right-sidebar page
		 * ------------------------------------------------------------------ */

		/**
		 * Register the tab type and its body with the right sidebar.
		 *
		 * Both registrations sit inside the caller's effect, so unloading the plugin
		 * removes the card and the page with it. The service wait is deliberate: the
		 * sidebar provides `sidebarRightTabs` from its own effect, and `inject` runs
		 * this callback when — and only when — that service exists, which keeps plugin
		 * load order from deciding whether the card shows up.
		 *
		 * @param ctx - the client root context, inside a `slots` + `sidebarRightTabs` injection.
		 * @param state - the runtime state object.
		 * @returns a disposer for the card and the body.
		 */
		function mountPanel(ctx, state) {
		  ensurePanelStyle();
		  const disposers = [];
		  const fail = (error) => {
		    state.panelReady = false;
		    state.panelError = "背景设置页注册失败：" + String(error && error.message ? error.message : error);
		    console.error("[dsh-skins] panel registration failed", error);
		    publish(state, {});
		  };
		  try {
		    disposers.push(
		      ctx.sidebarRightTabs.register({
		        id: PACKAGE_ID,
		        kind: TAB_KIND,
		        priority: "builtin",
		        title: () => PANEL_TITLE,
		        guide: [
		          {
		            id: TAB_KIND,
		            order: GUIDE_ORDER,
		            title: () => PANEL_TITLE,
		            description: () => "皮肤库 · 模糊/透明度 · 上传新素材",
		            icon: panelGlyph,
		          },
		        ],
		      }),
		    );
		    state.panelReady = true;
		    state.panelError = null;
		  } catch (error) {
		    fail(error);
		  }
		  try {
		    disposers.push(
		      ctx.slots.inject("sidebar.right.pane.tab", () =>
		        ctx.slots.register(
		          { name: "sidebar.right.pane.tab", key: PACKAGE_ID },
		          (tabProps) => h(SkinsPanel, Object.assign({}, tabProps, { store: state, ctx })),
		        ),
		      ),
		    );
		  } catch (error) {
		    fail(error);
		  }
		  publish(state, {});
		  return () => {
		    for (const dispose of disposers.reverse()) {
		      try {
		        dispose();
		      } catch {
		        /* an already-disposed slot is not an error on unload */
		      }
		    }
		  };
		}

		/* ------------------------------------------------------------------ *
		 * The bottom-right quick switcher (kept: one click without opening the column)
		 * ------------------------------------------------------------------ */

		function mountSwitcher(ctx, state) {
		  const host = document.createElement("div");
		  host.setAttribute("data-dsh-skins-panel", "");
		  host.style.cssText = [
		    "position:fixed",
		    "right:16px",
		    "bottom:16px",
		    "z-index:60",
		    "display:flex",
		    "gap:8px",
		    "align-items:center",
		    "padding:8px 10px",
		    "border-radius:10px",
		    "font:12px/1.4 'Inter','Segoe UI',system-ui,sans-serif",
		    "color:var(--dsw-alias-label-primary)",
		    "background:var(--dsw-alias-bg-layer-3)",
		    "border:1px solid var(--dsw-alias-border-l2)",
		    "box-shadow:0 8px 24px rgba(0,0,0,0.28)",
		    "backdrop-filter:blur(10px) saturate(120%)",
		  ].join(";");

		  const label = document.createElement("span");
		  label.textContent = "皮肤";

		  const select = document.createElement("select");
		  select.style.cssText =
		    "max-width:230px;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 6px";
		  for (const skin of state.catalog.skins) {
		    const option = document.createElement("option");
		    option.value = skin.skinId;
		    option.textContent = (skin.type === "video" ? "▶ " : "▪ ") + skinLabel(skin);
		    select.append(option);
		  }
		  const none = document.createElement("option");
		  none.value = "";
		  none.textContent = "（回退到内置主题）";
		  select.prepend(none);

		  select.addEventListener("change", () => {
		    const next = select.value === "" ? null : state.catalog.skins.find((skin) => skin.skinId === select.value) ?? null;
		    void switchTo(ctx, state, next, "manual");
		  });

		  // A second door into the same page the start card opens. Absent when the
		  // sidebar service is not there, which is a supported composition too.
		  const open = document.createElement("button");
		  open.type = "button";
		  open.textContent = "面板";
		  open.title = "在右侧边栏打开「背景设置」";
		  open.style.cssText =
		    "font:inherit;cursor:pointer;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:2px 7px";
		  open.addEventListener("click", () => {
		    const sidebar = ctx.get("sidebarRight");
		    if (sidebar === undefined || sidebar === null) return;
		    try {
		      sidebar.openTab(TAB_KIND);
		    } catch (error) {
		      console.warn("[dsh-skins] the right sidebar refused to open the settings page", error);
		    }
		  });

		  const hide = document.createElement("button");
		  hide.type = "button";
		  hide.textContent = "×";
		  hide.title = "隐藏皮肤面板（选择仍会保留）";
		  hide.style.cssText =
		    "font:inherit;cursor:pointer;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:2px 7px";
		  hide.addEventListener("click", () => {
		    host.style.display = "none";
		    try {
		      window.localStorage.setItem(HIDDEN_KEY, "1");
		    } catch {
		      /* ignore */
		    }
		  });

		  host.append(label, select, open, hide);
		  state.panel = host;
		  if (state.hidden !== true) document.body.append(host);
		  // Built before the first application in the initial path, so the value is
		  // reconciled from state rather than assumed here.
		  select.value = state.skinId ?? "";
		}

		/* ------------------------------------------------------------------ *
		 * Entry point
		 * ------------------------------------------------------------------ */

		/**
		 * Client plugin body.
		 * @param ctx - the client root context.
		 */
		function apply(ctx) {
		  const state = {
		    catalog: { skins: [], counts: { total: 0, image: 0, video: 0 } },
		    catalogError: null,
		    skinId: null,
		    disposeTokens: null,
		    style: null,
		    chromeStyle: null,
		    layer: null,
		    video: null,
		    poster: null,
		    scrim: null,
		    panel: null,
		    hidden: false,
		    defaultSkin: null,
		    tweaks: readTweaks(),
		    favorites: readFavorites(),
		    filters: { query: "", type: "all", tags: [], favoriteOnly: false },
		    listeners: new Set(),
		    version: 0,
		    view: null,
		    job: null,
		    hostRevision: null,
		    panelReady: true,
		    panelError: null,
		    shortcutMode: null,
		    shortcutNote: "waiting-for-service",
		    shortcutReported: null,
		    shortcutOwner: { [COMMAND_TOGGLE]: "dom", [COMMAND_RANDOM]: "dom" },
		    shortcutKeys: { toggle: null, random: null },
		    shortcutDiag: { toggle: null, random: null },
		    disposeFallbackKeys: null,
		    // Visual layer (phase 2)
		    tokenSource: "none",
		    liveTokens: null,
		    liveTokensNote: null,
		    liveTokensCheck: null,
		    liveTokensSource: null,
		    livePreview: null,
		    liveTimer: null,
		    parallax: { x: 0, y: 0 },
		    parallaxOn: false,
		    // Video transport + the audio-driven pulse
		    videoPlaying: false,
		    videoMuted: true,
		    videoRate: 1,
		    videoNote: null,
		    videoHasAudio: null,
		    videoSilent: undefined,
		    audioContext: null,
		    audioGraph: null,
		    audioFrame: null,
		    audioLevel: 0,
		    // Automation
		    automation: readAutomation(),
		    automationDisposers: [],
		    automationNote: null,
		    automationDecision: null,
		    automationApplied: null,
		    automationBusy: false,
		    workspaceIndex: readWorkspaceIndex(),
		    currentSessionId: null,
		    currentWorkspaceKey: null,
		    currentWorkspaceLabel: null,
		    currentWorkspaceTitle: null,
		    mountedSource: null,
		    // Assets: the encoder, packs and cleanup
		    assets: readAssetSettings(),
		    ffmpeg: null,
		    assetJob: null,
		    exportResult: null,
		    importResult: null,
		    cleanup: null,
		    // Developer options: injected CSS, focus mode, the eyedropper
		    customCss: readCustomCss(),
		    customStyle: null,
		    customCssCheck: validateCss(""),
		    focusMode: false,
		    focusFullscreen: false,
		    focusProbe: null,
		    focusProbeSettled: null,
		    focusTargets: [],
		    focusLanes: [],
		    focusAnchor: null,
		    focusKey: null,
		    focusNote: null,
		    focusConflicts: [],
		    focusRecovered: false,
		    focusHotkey: null,
		    focusHotkeyNote: null,
		    disposeFocusHotkey: null,
		    disposed: false,
		    // Library management: order, deletion, context menu, batch mode
		    preferences: null,
		    preferencesFile: null,
		    preferencesSavedAt: null,
		    preferencesNote: null,
		    opLog: [],
		    cardPress: null,
		    drag: null,
		    skinMenu: null,
		    deleteDialog: null,
		    batch: { active: false, selected: [] },
		    viewMode: readViewMode(),
		    preview: null,
		    previewSkin: null,
		    // advanced customisation
		    uiKnobs: readUiKnobs(),
		    uiKnobStyle: null,
		    recommend: readRecommend(),
		    recommendDecision: null,
		    switchHotkey: null,
		    disposeSwitches: null,
		    toast: null,
		    settingsFile: null,
		    settingsNote: null,
		    // performance and resource protection
		    bgPaused: false,
		    bgPauseReason: null,
		    bgWasPlaying: false,
		    videoElements: 0,
		    runtime: null,
		    statusTimer: null,
		    layerZIndexBefore: null,
		    layerZIndexAfter: null,
		    picker: null,
		    pickNote: null,
		    accentOverride: null,
		  };
		  publish(state, {});

		  // The local listener goes in first and stays inert once the service accepts
		  // the bindings, so ordering between the two never decides whether the keys work.
		  ctx.effect(() => installFallbackKeys(ctx, state), "dsh-skins: local shortcut fallback");
		  // Window-state guards: a hidden or blurred window stops decoding the background.
		  ctx.effect(() => installBackgroundGuards(state), "dsh-skins: background pause guards");
		  // Ctrl+Shift+PageUp/PageDown: another window-level chord, same single-owner rule.
		  ctx.effect(() => installSwitchHotkeys(ctx, state), "dsh-skins: skin switch hotkeys");
		  // The UI knobs are applied once at boot, not only when the panel is open.
		  applyUiKnobs(state);
		  // The global chord lives in its own effect so its listener is released on unload
		  // exactly like the others.
		  ctx.effect(() => installFocusHotkey(ctx, state), "dsh-skins: global focus-mode hotkey");
		  ctx.inject(["shortcuts"], (shortcutCtx) => {
		    shortcutCtx.effect(() => registerShortcuts(shortcutCtx, state) ?? (() => {}), "dsh-skins: application shortcuts");
		  });
		  // One passive pointer listener for the whole session; it no-ops unless the
		  // current skin has parallax on.
		  ctx.effect(() => installParallax(state), "dsh-skins: background parallax");
		  // Every automation timer and listener is created inside this effect, so plugin
		  // unload releases all of them — there is no timer that outlives the fiber.
		  ctx.effect(() => {
		    startAutomation(ctx, state);
		    return () => stopAutomation(state);
		  }, "dsh-skins: automation timers");
		  // One probe at startup: the panel's asset section can then say whether a
		  // transcode is even possible instead of offering a button that cannot work.
		  void refreshFfmpeg(state);
		  // Leftovers from an interrupted pick or a focus mode that outlived its panel:
		  // both are attributes and overlay nodes, so sweeping them is safe and cheap.
		  // This is also the crash recovery — a flagged run is reset instead of resumed.
		  recoverFocus(state);
		  if (state.customCss.trim().length > 0) applyCustomCss(state);

		  // The panel first: it only needs its own route, so an empty catalog still
		  // shows the upload half instead of an error page.
		  ctx.inject(["slots", "sidebarRightTabs"], (uiCtx) => {
		    uiCtx.effect(() => mountPanel(uiCtx, state), "dsh-skins: background settings page");
		  });

		  ctx.inject(REQUIRED, () => {
		    ctx.effect(() => {
		      let disposed = false;
		      const onMotionChange = () => {
		        // Reduced motion can change while the app is open; re-apply so the video
		        // is hidden (or restored) without a reload.
		        if (state.skinId === null) return;
		        const skin = state.catalog.skins.find((entry) => entry.skinId === state.skinId) ?? null;
		        if (skin !== null) void switchTo(ctx, state, skin, "reduced-motion-change");
		      };
		      try {
		        window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", onMotionChange);
		      } catch {
		        /* older engines: the initial read still applies */
		      }

		      (async () => {
		        await loadCatalog(state);
		        if (disposed) return;

		        try {
		          state.hidden = window.localStorage.getItem(HIDDEN_KEY) === "1";
		        } catch {
		          state.hidden = false;
		        }

		        const prefs = readPrefs();
		        const wanted =
		          (typeof prefs.skinId === "string" && prefs.skinId.length > 0 ? prefs.skinId : null) ??
		          (typeof state.catalog.defaultSkin === "string" ? state.catalog.defaultSkin : null);

		        // The saved order has to be in hand before the library renders, and the
		        // favourites it carries are unioned with the ones already in localStorage.
		        await loadPreferences(state);

		        const skin = wanted === null ? null : state.catalog.skins.find((entry) => entry.skinId === wanted) ?? null;
		        if (wanted !== null && skin === null) {
		          console.warn("[dsh-skins] saved skin is not in the catalog, using the fallback theme:", wanted);
		        }

		        if (skin !== null) {
		          try {
		            await applySkin(ctx, state, skin);
		          } catch (error) {
		            console.error("[dsh-skins] applying the default skin failed", error);
		          }
		        }
		        publish(state, {});

		        // The switcher mounts after the first application so its selected value
		        // can be set from the applied skin rather than guessed.
		        mountSwitcher(ctx, state);

		        // One dry run of the live-colour derivation, so a single page load proves
		        // the measurement path end to end without flipping the switch.
		        await previewLiveTokens(state);
		        // The rules run once the catalog exists: a project or schedule rule that
		        // cannot find its skin is retried rather than marked done.
		        await evaluateAutomation(ctx, state, "boot");
		        // The clock-based suggestion is evaluated last and only ever fills a gap.
		        evaluateRecommendation(ctx, state, "boot");
		        publish(state, {});

		        // Report the initial application too, so one page load is enough to
		        // verify the plugin end to end.
		        await sendReport(state, clientReport(state, "initial", { applied: skin !== null }));
		      })();

		      return () => {
		        disposed = true;
		        // Stops a pending "open the page, then enter focus mode" wait from acting on
		        // a plugin that is already gone.
		        state.disposed = true;
		        try {
		          window.matchMedia("(prefers-reduced-motion: reduce)").removeEventListener("change", onMotionChange);
		        } catch {
		          /* ignore */
		        }
		        // Focus mode first, and before the panel element goes: it hides every
		        // element that is not on the path to this panel, so unmounting while it
		        // is on would leave a window with nothing but artwork and no way back.
		        exitFocusMode(state);
		        stopPicker(state);
		        // A hover preview left running would keep decoding a video with no card.
		        stopHoverPreview(state);
		        stopStatusTimer(state);
		        resetThumbObserver();
		        for (const node of Array.from(document.querySelectorAll("[" + TOAST_ATTRIBUTE + "]"))) node.remove();
		        if (state.uiKnobStyle !== null && state.uiKnobStyle !== undefined) {
		          state.uiKnobStyle.remove();
		          state.uiKnobStyle = null;
		        }
		        document.documentElement.removeAttribute("data-dsh-advanced");
		        // The library's transient UI goes with the panel: a menu or a dialog that
		        // outlived its panel would have no owner left to close it.
		        closeSkinMenu(state);
		        closeDeleteDialog(state);
		        cancelDrag(state);
		        if (state.customStyle !== null && state.customStyle !== undefined) {
		          state.customStyle.remove();
		          state.customStyle = null;
		        }
		        teardownSkin(state);
		        if (state.panel !== null) state.panel.remove();
		        state.listeners.clear();
		      };
		    }, "dsh-skins: artwork layer, token layer and switcher");
		  });
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = PACKAGE_ID;

		return module.exports;
	}
});
