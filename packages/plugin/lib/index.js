/**
 * Host half of the dsh skins plugin.
 *
 * Responsibilities:
 *   1. Read the generated skin directories (`output/skins/<skin_id>/`) and
 *      publish a catalog the browser half can fetch.
 *   2. Stream each skin's assets with correct content types and HTTP Range
 *      support, so a large video skin seeks instead of downloading whole.
 *   3. Accept new source media (streamed to `input_image/` / `input_video/`) and
 *      run the workspace's own skin pipeline over it, reporting every step.
 *   4. Receive the browser half's verification report, which is how a headless
 *      run proves whether a skin actually applied.
 *
 * Everything is resolved inside the workspace: `resolveInsideWorkspace` refuses
 * any path that escapes the project directory, so a catalog entry cannot point
 * the route at an arbitrary file.
 *
 * The desktop profile's `cordis.patch.yml` registers this module by file URL.
 */
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

/** Route prefix this plugin owns. The browser half mirrors the string. */
export const ROUTE = '/dsh-skins';

/**
 * Bumped together with the browser half's `REVISION`. The catalog carries it so
 * the panel can say "this page is talking to a host module from before the last
 * edit" instead of silently missing a route — which is what happens when the
 * Electron app has not been restarted, because this profile has no HMR.
 */
export const REVISION = '2026-09-30.panel-9-advanced';

/**
 * Where the plugin keeps its data.
 *
 * Development runs inside a checkout whose layout this plugin knows
 * (`output/skins`, `output/reports`, `output/_scan`, `input_image`, …). A
 * published install has no checkout, so the same layout lives under a per-user
 * directory instead: `~/.dsh/skins`, or whatever `dataDir` / `workspaceDir`
 * names in the plugin config, or `DSH_SKINS_DATA` in the environment.
 *
 * Keeping the layout identical is deliberate: every path in this file derives
 * from `WORKSPACE`, so pointing that one value at another root moves skins,
 * reports, inputs, exports and the pipeline together.
 */
function defaultRoot() {
  const fromEnv = process.env.DSH_SKINS_DATA;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return resolve(fromEnv);
  // A checkout (or the test sandbox) has `output/skins` beside the plugin's
  // four-hop root; a published install does not and falls back to the user dir.
  try {
    const adjacent = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/[\\/]+$/u, '');
    if (existsSync(join(adjacent, 'output', 'skins'))) return adjacent;
  } catch {
    /* import.meta.url is always resolvable; this is defensive only */
  }
  return join(homedir(), '.dsh', 'skins');
}

let WORKSPACE = defaultRoot();
let SKINS_DIR = join(WORKSPACE, 'output', 'skins');
let REPORTS_DIR = join(WORKSPACE, 'output', 'reports');
let SCAN_DIR = join(WORKSPACE, 'output', '_scan');
let PLANS_DIR = join(WORKSPACE, 'output', 'plans');
let FRAMES_DIR = join(WORKSPACE, 'output', 'analysis', 'frames');
let IMAGE_GROUPS_DIR = join(SCAN_DIR, 'image_groups');
let VIDEO_GROUPS_DIR = join(SCAN_DIR, 'video_groups');
let INPUT_DIRS = { image: join(WORKSPACE, 'input_image'), video: join(WORKSPACE, 'input_video') };
/** Where exported packs land, and where a cleanup quarantines what it cannot recycle. */
let EXPORTS_DIR = join(WORKSPACE, 'output', 'exports');
let TRASH_DIR = join(WORKSPACE, 'output', '_trash');
/**
 * The rendition convention: a compressed playback copy lives *inside* the skin,
 * next to its wallpaper and poster.
 *
 * Deliberately inside the skin: the pipeline scans `input_video/`, so a
 * compressed copy there would be scanned as a second input and mint a second
 * skin. Here it is an asset of the skin it belongs to, the original stays
 * untouched as the input of record, and an exported pack carries it for free.
 */
const RENDITION_NAME = 'source.mp4';

/** The auto-measured group files. `merge_image_analysis` only reads single-letter groups. */
let AUTO_IMAGE_GROUP = join(IMAGE_GROUPS_DIR, 'group_e.json');
let AUTO_VIDEO_GROUP = join(VIDEO_GROUPS_DIR, 'group_v5.json');

/** Re-point every derived directory at `root`, creating the writable ones. */
function configureRoot(root) {
  WORKSPACE = resolve(root).replace(/[\\/]+$/u, '');
  SKINS_DIR = join(WORKSPACE, 'output', 'skins');
  REPORTS_DIR = join(WORKSPACE, 'output', 'reports');
  SCAN_DIR = join(WORKSPACE, 'output', '_scan');
  PLANS_DIR = join(WORKSPACE, 'output', 'plans');
  FRAMES_DIR = join(WORKSPACE, 'output', 'analysis', 'frames');
  IMAGE_GROUPS_DIR = join(SCAN_DIR, 'image_groups');
  VIDEO_GROUPS_DIR = join(SCAN_DIR, 'video_groups');
  INPUT_DIRS = { image: join(WORKSPACE, 'input_image'), video: join(WORKSPACE, 'input_video') };
  EXPORTS_DIR = join(WORKSPACE, 'output', 'exports');
  TRASH_DIR = join(WORKSPACE, 'output', '_trash');
  AUTO_IMAGE_GROUP = join(IMAGE_GROUPS_DIR, 'group_e.json');
  AUTO_VIDEO_GROUP = join(VIDEO_GROUPS_DIR, 'group_v5.json');
  for (const dir of [
    SKINS_DIR,
    REPORTS_DIR,
    EXPORTS_DIR,
    TRASH_DIR,
    PLANS_DIR,
    FRAMES_DIR,
    IMAGE_GROUPS_DIR,
    VIDEO_GROUPS_DIR,
    INPUT_DIRS.image,
    INPUT_DIRS.video,
  ]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* a read-only install can still serve an existing library */
    }
  }
}

const MEDIA_TYPES = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const mediaType = (file) => MEDIA_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';

/** Upload extensions, mapped to the input directory they belong in. */
const UPLOAD_KINDS = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.avif': 'image',
  '.gif': 'image',
  '.bmp': 'image',
  '.tif': 'image',
  '.tiff': 'image',
  '.mp4': 'video',
  '.m4v': 'video',
  '.mov': 'video',
  '.webm': 'video',
  '.mkv': 'video',
};

/** Hard ceiling per upload; the largest shipped source is 623 MB. */
const UPLOAD_LIMIT = 3 * 1024 * 1024 * 1024;

/** Resolve inside the workspace only; anything else is refused. */
function resolveInsideWorkspace(candidate) {
  const absolute = resolve(WORKSPACE, candidate);
  return absolute.startsWith(WORKSPACE + sep) ? absolute : undefined;
}

function respondJson(res, status, value, extraHeaders = {}, head = false) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.byteLength,
    ...extraHeaders,
  });
  if (head) res.end();
  else res.end(body);
}

/**
 * Build the catalog from the generated skin directories.
 *
 * `meta` is the skin's own `skin.json`, so the panel's label and the design
 * summary come from the same file the skin ships. Asset URLs are relative to
 * this route, which keeps the browser half free of path knowledge.
 */
function readCatalog() {
  if (!existsSync(SKINS_DIR)) {
    return { ok: false, error: 'skins-directory-missing', dir: SKINS_DIR, skins: [] };
  }
  const skins = [];
  for (const name of readdirSync(SKINS_DIR)) {
    if (!name.startsWith('img_') && !name.startsWith('video_')) continue;
    const dir = join(SKINS_DIR, name);
    const metaPath = join(dir, 'skin.json');
    const tokensPath = join(dir, 'tokens.json');
    if (!existsSync(metaPath) || !existsSync(tokensPath)) continue;
    let meta;
    let tokens;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      tokens = JSON.parse(readFileSync(tokensPath, 'utf8'));
    } catch {
      continue;
    }
    const asset = (relative) => (existsSync(join(dir, relative)) ? `${ROUTE}/asset/${encodeURIComponent(name)}/${relative.split('/').at(-1)}` : null);
    // A skin may ship its stills in any common format; `thumb` and `poster` fall
    // back to the wallpaper so a one-image skin still renders in the grid and in
    // the video slot. The panel consumes whichever URL resolves.
    const pickAsset = (candidates) => {
      for (const candidate of candidates) {
        if (existsSync(join(dir, candidate))) return `${ROUTE}/asset/${encodeURIComponent(name)}/${candidate.split('/').at(-1)}`;
      }
      return null;
    };
    const WALLPAPERS = ['assets/wallpaper.webp', 'assets/wallpaper.png', 'assets/wallpaper.jpg', 'assets/wallpaper.jpeg', 'assets/wallpaper.avif'];
    const THUMBS = ['assets/thumb.webp', 'assets/thumb.png', 'assets/thumb.jpg', 'assets/thumb.jpeg'];
    const POSTERS = ['assets/poster.webp', 'assets/poster.png', 'assets/poster.jpg', 'assets/poster.jpeg'];
    const wallpaperAsset = pickAsset(WALLPAPERS);
    const isVideo = meta.type === 'video';
    // A compressed rendition lives inside the skin; when it exists it is what the
    // source route serves and what the panel reports as the playing size.
    const renditionPath = join(dir, 'assets', RENDITION_NAME);
    const hasRendition = existsSync(renditionPath);
    skins.push({
      skinId: name,
      name: meta.name,
      nameZh: meta.nameZh,
      type: meta.type,
      source: meta.source?.file ?? null,
      design: meta.design?.summary ?? '',
      styleKeywords: meta.styleKeywords ?? [],
      mood: meta.mood ?? [],
      status: meta.status?.level ?? null,
      anchorScheme: tokens.contrast?.ratios?.['light: ink on base'] !== undefined ? (tokens.colors?.light ? 'light' : 'dark') : 'dark',
      // Both schemes present means the panel can show the polarity it will imply.
      schemes: tokens.colors ? Object.keys(tokens.colors).filter((key) => key === 'light' || key === 'dark') : [],
      presentedTokens: tokens.presentedTokens ?? null,
      colors: tokens.colors
        ? {
            light: { base: tokens.colors.light?.base, accent: tokens.colors.light?.accent, veil: tokens.colors.light?.veilAlpha },
            dark: { base: tokens.colors.dark?.base, accent: tokens.colors.dark?.accent, veil: tokens.colors.dark?.veilAlpha },
          }
        : null,
      contrast: tokens.contrast?.ratios ?? null,
      /**
       * The size of the file this skin actually plays.
       *
       * For a video that is the rendition when one exists, otherwise the original;
       * for an image it is the source. The badge shows this rather than the raw
       * source size, because that is what the user is paying for on disk.
       */
      playback: isVideo
        ? hasRendition
          ? { kind: 'rendition', bytes: statSync(renditionPath).size, originalBytes: meta.source?.bytes ?? null, width: meta.source?.width ?? null, height: meta.source?.height ?? null }
          : { kind: 'original', bytes: meta.source?.bytes ?? null, originalBytes: meta.source?.bytes ?? null, width: meta.source?.width ?? null, height: meta.source?.height ?? null }
        : { kind: 'source', bytes: meta.source?.bytes ?? null, originalBytes: meta.source?.bytes ?? null, width: meta.source?.width ?? null, height: meta.source?.height ?? null },
      sourceBytes: meta.source?.bytes ?? null,
      assets: {
        wallpaper: wallpaperAsset,
        thumb: pickAsset(THUMBS) ?? wallpaperAsset,
        poster: pickAsset(POSTERS) ?? wallpaperAsset,
      },
      video: isVideo
        ? {
            src: `${ROUTE}/source/${encodeURIComponent(name)}`,
            durationSeconds: meta.source?.durationSeconds ?? null,
            poster: pickAsset(POSTERS) ?? wallpaperAsset,
            scrim: {
              top: null,
              middle: null,
              bottom: null,
            },
            /** The compressed playback copy, when one exists inside the skin. */
            rendition: hasRendition ? `assets/${RENDITION_NAME}` : null,
            renditionBytes: hasRendition ? statSync(renditionPath).size : null,
            sourceBytes: meta.source?.bytes ?? null,
          }
        : null,
    });
  }
  skins.sort((a, b) => (a.type === b.type ? a.skinId.localeCompare(b.skinId) : a.type === 'image' ? -1 : 1));
  return {
    ok: true,
    revision: REVISION,
    generatedAt: new Date().toISOString(),
    workspace: WORKSPACE,
    counts: {
      total: skins.length,
      image: skins.filter((skin) => skin.type === 'image').length,
      video: skins.filter((skin) => skin.type === 'video').length,
    },
    skins,
  };
}

/** Parse a single-range `Range` header the way the working reference does. */
function parseRange(header, size) {
  if (typeof header !== 'string' || !header.toLowerCase().startsWith('bytes=')) return null;
  const first = header.slice(6).split(',')[0].trim();
  const [rawStart, rawEnd] = first.split('-');
  let start;
  let end;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' || rawEnd === undefined ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= size || start > end) return { unsatisfiable: true };
  return { start, end: Math.min(end, size - 1) };
}

/** Stream a file with Range support; missing files answer 404, never a throw. */
function streamFile(file, req, res) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    respondJson(res, 404, { ok: false, error: 'missing', file: file.slice(WORKSPACE.length + 1) });
    return;
  }
  const stat = statSync(file);
  const head = req.method === 'HEAD';
  const range = parseRange(req.headers.range, stat.size);
  if (range !== null && range.unsatisfiable === true) {
    res.writeHead(416, { 'content-range': `bytes */${stat.size}`, 'cache-control': 'no-store' });
    res.end();
    return;
  }
  const start = range === null ? 0 : range.start;
  const end = range === null ? stat.size - 1 : range.end;
  const status = range === null ? 200 : 206;
  const headers = {
    'content-type': mediaType(file),
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'content-length': end - start + 1,
    // No CORP/COEP header here on purpose: `cross-origin-resource-policy:
    // same-origin` would block the renderer from reading its own media in the
    // Electron shell, and cross-site reads are already refused by the
    // `sec-fetch-site` check in the route handler.
  };
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(status, headers);
  if (head) {
    res.end();
    return;
  }
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/** Read a JSON request body with a hard cap. */
function readBody(req, limit = 262144) {
  return new Promise((settle) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        settle(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        settle(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        settle(undefined);
      }
    });
    req.on('error', () => settle(undefined));
  });
}

/**
 * Stream a request body straight into a file.
 *
 * Raw bodies rather than multipart on purpose: the sources reach hundreds of
 * megabytes, and a parser would either buffer them or need a dependency. The
 * name travels in a header instead, validated here.
 *
 * @returns `{ ok, bytes }`, or `{ ok: false, status, error }`.
 */
function writeStreamToFile(req, file, limit) {
  return new Promise((settle) => {
    let bytes = 0;
    let settled = false;
    const fail = (status, error, detail) => {
      if (settled) return;
      settled = true;
      try {
        req.destroy();
      } catch {
        /* already gone */
      }
      try {
        rmSync(file, { force: true });
      } catch {
        /* partial file may already be gone */
      }
      settle({ ok: false, status, error, detail });
    };
    let out;
    try {
      out = createWriteStream(file, { flags: 'wx' });
    } catch (error) {
      settle({ ok: false, status: 500, error: 'open-failed', detail: String(error?.message ?? error) });
      return;
    }
    out.on('error', (error) => {
      if (settled) return;
      settled = true;
      const exists = error?.code === 'EEXIST';
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      settle({ ok: false, status: exists ? 409 : 500, error: exists ? 'file-exists' : 'write-failed', detail: String(error?.message ?? error) });
    });
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        fail(413, 'too-large', `the body exceeded ${limit} bytes`);
        try {
          out.destroy();
        } catch {
          /* ignore */
        }
      }
    });
    req.on('error', () => fail(499, 'client-aborted'));
    req.on('aborted', () => fail(499, 'client-aborted'));
    req.pipe(out);
    out.on('close', () => {
      if (settled) return;
      settled = true;
      settle({ ok: true, bytes });
    });
  });
}

/* ------------------------------------------------------------------ *
 * The generation pipeline
 * ------------------------------------------------------------------ */

/** The shell shim the app ships is the most reliable Node: it is the app's own. */
function nodeRunner(config) {
  if (typeof config?.nodeBin === 'string' && config.nodeBin.length > 0) return { command: config.nodeBin, prefix: [], env: {} };
  const own = process.env.DSH_DESKTOP_NODE_EXECUTABLE;
  if (typeof own === 'string' && own.length > 0) {
    return { command: own, prefix: ['--expose-internals'], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return { command: 'node', prefix: [], env: {} };
}

/** Wait for a promise with a deadline; resolves `{ timedOut: true }` on expiry. */
function withTimeout(promise, ms) {
  return new Promise((settle) => {
    const timer = setTimeout(() => settle({ timedOut: true }), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        settle({ timedOut: false, value });
      },
      (error) => {
        clearTimeout(timer);
        settle({ timedOut: false, error });
      },
    );
  });
}

/** Candidate Chromium builds for the video frame extractor. */
const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

const firstExisting = (candidates) => candidates.find((candidate) => existsSync(candidate)) ?? null;

/** Merge records into an auto group file, keeping anything already measured there. */
function mergeGroupFile(file, group, makeRecord) {
  let existing = { group, records: [] };
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.records)) existing = parsed;
    } catch {
      /* a corrupt auto group is replaced rather than trusted */
    }
  }
  const rows = new Map();
  for (const record of existing.records) {
    const key = record?.file ?? record?.skinId;
    if (typeof key === 'string') rows.set(key, record);
  }
  let changed = 0;
  for (const [key, value] of makeRecord) {
    rows.set(key, value);
    changed += 1;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ group, records: Array.from(rows.values()), note: 'Auto-measured by the dsh-skins background settings panel: pixel statistics and palette only, no visual judgement.' }, null, 2)}\n`, 'utf8');
  return changed;
}

/**
 * Run one external process and collect its output.
 *
 * `code` is null when the process could not start at all (a missing binary), which
 * is a different fact from a non-zero exit and is what the encoder probe reports.
 * No shell is involved, so arguments with spaces or quotes travel intact — which
 * is also what makes the invocation identical on every platform.
 *
 * @returns `{ code, output, error }`.
 */
function runProcess(command, args, options = {}) {
  const { cwd = WORKSPACE, env = {}, timeoutMs = 60000, maxOutput = 40000 } = options;
  return new Promise((settle) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      settle({ code: null, output: '', error: String(error?.message ?? error) });
      return;
    }
    let output = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      output += `\n[timeout after ${Math.round(timeoutMs / 1000)}s]\n`;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    const collect = (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > maxOutput) output = output.slice(-maxOutput);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      settle({ code: null, output: `${output}\n[spawn failed: ${String(error?.message ?? error)}]\n`, error: String(error?.message ?? error) });
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      settle({ code, output });
    });
  });
}

/** Run one pipeline script through the app's own Node. */
function runScript(runner, script, args, timeoutMs) {
  return runProcess(runner.command, [...runner.prefix, join(SCAN_DIR, script), ...args], {
    env: runner.env,
    timeoutMs,
  });
}

/**
 * Start a job that turns newly uploaded media into skins.
 *
 * The workspace has no orchestrator script, so this is one: the steps below are
 * exactly the documented order (scan -> ids -> analysis groups -> build), and
 * the auto-measured analysis record is the one thing this plugin adds, because
 * the original analysis pass was a model step and nothing in the repo produces
 * it.
 */
function startJob(ctx, config, state, records, settings = ASSET_DEFAULTS) {
  const runner = nodeRunner(config);
  const log = (line) => {
    state.job.log = `${state.job.log}${line}\n`;
    if (state.job.log.length > 40000) state.job.log = state.job.log.slice(-40000);
  };
  const step = async (id, title, script, args, timeoutMs, optional = false) => {
    const entry = { id, title, status: 'running', code: null, ms: 0 };
    state.job.steps.push(entry);
    log(`\n=== ${title} (node ${script}) ===`);
    const started = Date.now();
    const result = await runScript(runner, script, args, timeoutMs);
    entry.ms = Date.now() - started;
    entry.code = result.code;
    entry.status = result.code === 0 ? 'ok' : optional ? 'skipped' : 'failed';
    log(result.output.trimEnd());
    if (result.code !== 0 && !optional) {
      state.job.status = 'failed';
      state.job.message = `${title} exited with code ${result.code}`;
      throw new Error(state.job.message);
    }
  };

  (async () => {
    try {
      // The generation pipeline is a separate, optional piece (the toolkit or a
      // workspace copy of it). Say so plainly instead of failing on a spawn.
      const requiredScripts = ['inventory.mjs', 'make_ids.mjs', 'build_all_skins.mjs'];
      const missingScripts = requiredScripts.filter((script) => !existsSync(join(SCAN_DIR, script)));
      if (missingScripts.length > 0) {
        throw new Error(
          `generation pipeline is not installed: ${missingScripts.join(', ')} missing under ${SCAN_DIR}. ` +
            'Install @henryabbott-13/dsh-skins-toolkit and point config.scanDir at it, or upload skins as packs instead.',
        );
      }
      const before = new Set(existsSync(SKINS_DIR) ? readdirSync(SKINS_DIR) : []);
      log(`node: ${runner.command} ${runner.prefix.join(' ')}`.trimEnd());
      log(`workspace: ${WORKSPACE}`);

      await step('inventory', '扫描输入目录', 'inventory.mjs', [], 15 * 60 * 1000);
      await step('ids', '计算皮肤 id', 'make_ids.mjs', [], 5 * 60 * 1000);

      // Videos need decoded frames. Prefer the workspace's own extractor in a
      // headless browser; when no browser is installed the client-measured
      // poster (already on disk) is what the build falls back to.
      const ids = JSON.parse(readFileSync(join(PLANS_DIR, 'skin_ids.json'), 'utf8'));
      const videoIds = ids.records.filter((record) => record.kind === 'video');
      const framesMissing = videoIds.filter((record) => {
        const stem = record.name.replace(/\.[^.]+$/u, '').replace(/[^\w.-]+/gu, '_');
        const reportPath = join(FRAMES_DIR, `${stem}.frames.json`);
        if (!existsSync(reportPath)) return true;
        try {
          return JSON.parse(readFileSync(reportPath, 'utf8')).ok !== true;
        } catch {
          return true;
        }
      });
      if (framesMissing.length > 0) {
        const browser = firstExisting(BROWSER_CANDIDATES);
        if (browser === null) {
          log(`\n=== 视频抽帧跳过：未找到 Edge/Chrome，${framesMissing.length} 个视频没有帧报告 ===`);
          state.job.steps.push({ id: 'frames', title: '视频抽帧', status: 'skipped', code: null, ms: 0, note: 'no browser found' });
        } else {
          const entry = { id: 'frames', title: '视频抽帧（无头浏览器）', status: 'running', code: null, ms: 0 };
          state.job.steps.push(entry);
          const started = Date.now();
          const profile = join(SCAN_DIR, 'edge-cdp');
          const launch = await launchBrowser(browser, profile, log);
          try {
            for (const record of framesMissing) {
              log(`--- ${record.name} ---`);
              const result = await runScript(
                runner,
                'video_frames.mjs',
                ['--port', '9333', '--one', record.name, '--out', 'output/analysis/frames', '--frames', '3', '--width', '1280', '--poster-width', '480'],
                5 * 60 * 1000,
              );
              log(result.output.trimEnd());
              if (result.code !== 0) log(`[${record.name}] video_frames exited ${result.code}; the build will degrade to the panel-measured poster`);
            }
            entry.status = 'ok';
          } finally {
            await stopBrowser(launch?.pid);
            entry.ms = Date.now() - started;
          }
          await step('frame-map', '整理帧索引', 'make_frame_map.mjs', [], 5 * 60 * 1000, true);
        }
      }

      // Auto-measured design records. Written only for inputs that have none,
      // so a real vision pass is never overwritten.
      const imageRecords = new Map();
      const videoRecords = new Map();
      for (const [name, record] of Object.entries(records ?? {})) {
        const scan = ids.records.find((row) => row.name === name);
        if (scan === undefined) {
          log(`[analysis] 忽略 ${name}：不在输入清单里`);
          continue;
        }
        if (scan.kind === 'image') imageRecords.set(name, { file: name, ...record });
        else videoRecords.set(scan.skinId, { skinId: scan.skinId, video: name, ...record });
      }
      if (imageRecords.size > 0) {
        const written = mergeGroupFile(AUTO_IMAGE_GROUP, 'E', imageRecords);
        log(`\n=== 写入 ${written} 条图片实测记录 -> output/_scan/image_groups/group_e.json ===`);
      }
      if (videoRecords.size > 0) {
        const written = mergeGroupFile(AUTO_VIDEO_GROUP, 'V5', videoRecords);
        log(`\n=== 写入 ${written} 条视频实测记录 -> output/_scan/video_groups/group_v5.json ===`);
      }

      await step('analysis-images', '合并图片分析', 'merge_image_analysis.mjs', [], 5 * 60 * 1000);
      if (videoRecords.size > 0 || framesMissing.length > 0) {
        await step('analysis-videos', '整理视频分析（回退层）', 'make_video_analysis.mjs', [], 5 * 60 * 1000, true);
        await step('analysis-videos-final', '合并视频实测分析', 'consolidate_video_analysis.mjs', [], 5 * 60 * 1000, true);
      }
      await step('build', '生成皮肤', 'build_all_skins.mjs', [], 30 * 60 * 1000);

      // Automatic compression, for the videos *this* run introduced. It runs
      // between the build and the index so a failed encode is visible in the step
      // list and never blocks the skin itself: the skin plays the original until
      // a rendition exists.
      const uploadedVideoIds = [];
      for (const name of Object.keys(records ?? {})) {
        const scan = ids.records.find((row) => row.name === name);
        if (scan !== undefined && scan.kind === 'video') uploadedVideoIds.push(scan.skinId);
      }
      if (settings.autoCompress !== true) {
        log('\n=== 自动压缩：设置里已关闭 ===');
        state.job.steps.push({ id: 'compress', title: '大视频自动压缩', status: 'skipped', code: null, ms: 0, note: 'disabled' });
      } else if (uploadedVideoIds.length === 0) {
        log('\n=== 自动压缩：本次没有新增视频，跳过 ===');
        state.job.steps.push({ id: 'compress', title: '大视频自动压缩', status: 'skipped', code: null, ms: 0, note: 'no-new-video' });
      } else {
        const entry = { id: 'compress', title: '大视频自动压缩', status: 'running', code: null, ms: 0, note: null };
        state.job.steps.push(entry);
        const startedCompress = Date.now();
        const found = await resolveFfmpeg(config, runProcess);
        state.ffmpeg = { at: Date.now(), found };
        if (found.path === null) {
          entry.status = 'skipped';
          entry.note = 'ffmpeg-not-found';
          log(`\n=== 自动压缩跳过：ffmpeg 未找到（已尝试 ${found.tried.length} 处）===`);
          for (const candidate of found.tried) log(`  - ${candidate}`);
          log('Windows 安装：winget install --id Gyan.FFmpeg -e');
          log('装好后重跑一次「只生成新皮肤」即可，原视频一直保留在 input_video/。');
          state.job.message = '完成（大视频未压缩：未找到 ffmpeg）';
        } else {
          log(`\n=== 自动压缩：${found.path}${found.version === undefined ? '' : ` · ${found.version}`} ===`);
          const sizes = readScanSizes();
          const rows = [];
          for (const skinId of uploadedVideoIds) {
            rows.push(await compressOne({ skinId, settings, ffmpeg: found, sizes, run: runProcess, append: log }));
          }
          state.job.compress = rows;
          const failed = rows.filter((row) => row.status === 'failed').length;
          entry.status = failed === rows.length && rows.length > 0 ? 'failed' : 'ok';
          if (failed > 0) entry.note = `${failed} 个失败`;
        }
        entry.ms = Date.now() - startedCompress;
      }

      await step('index', '重建索引', 'build_index.mjs', [], 5 * 60 * 1000, true);

      const after = existsSync(SKINS_DIR) ? readdirSync(SKINS_DIR) : [];
      state.job.newSkins = after.filter((name) => !before.has(name));
      state.job.status = 'succeeded';
      state.job.message = state.job.newSkins.length > 0 ? `新增 ${state.job.newSkins.length} 套皮肤` : '完成，但没有新皮肤目录';
      log(`\n=== done: ${state.job.message} ===`);
    } catch (error) {
      state.job.status = 'failed';
      state.job.message = state.job.message ?? String(error?.message ?? error);
      log(`\n[failed] ${state.job.message}`);
    } finally {
      state.job.endedAt = new Date().toISOString();
      state.job.running = false;
    }
  })();
}

/** Launch the frame extractor's browser and wait for its debug endpoint. */
async function launchBrowser(executable, profile, log) {
  const port = 9333;
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* a locked profile from a previous run is not fatal */
  }
  mkdirSync(profile, { recursive: true });
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,560',
    '--app=data:text/html,<html><body>capture</body></html>',
  ];
  const child = spawn(executable, args, { detached: false, windowsHide: true, stdio: 'ignore' });
  child.on('error', (error) => log(`[browser] launch failed: ${String(error?.message ?? error)}`));
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((settle) => setTimeout(settle, 250));
    const probe = await withTimeout(fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.ok), 2000);
    if (probe.timedOut === false && probe.value === true) {
      log(`[browser] ready on port ${port} (${executable})`);
      return child;
    }
  }
  log('[browser] the debug endpoint never answered; frame extraction will be skipped');
  await stopBrowser(child.pid);
  return null;
}

/** Kill the extractor's browser and its children; never throws. */
function stopBrowser(pid) {
  if (!Number.isFinite(pid)) return Promise.resolve();
  return new Promise((settle) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => settle());
    killer.on('close', () => settle());
  });
}

/* ------------------------------------------------------------------ *
 * Assets: the encoder, skin packs, and cleanup
 * ------------------------------------------------------------------ */

/** Defaults for the asset settings; the panel sends its own with every request. */
const ASSET_DEFAULTS = { autoCompress: true, thresholdMB: 50, targetHeight: 1080, bitrateMbps: 5, includeSource: false };
/** The heights the panel offers. */
const TARGET_HEIGHTS = [720, 1080, 1440];
/** Refuse a pack larger than this: the container is built in memory. */
const PACK_LIMIT = 2 * 1024 * 1024 * 1024;

/** Coerce whatever the panel sent into a usable settings object. */
function readAssetSettings(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const bounded = (value, fallback, lo, hi) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(hi, Math.max(lo, parsed)) : fallback;
  };
  return {
    autoCompress: source.autoCompress !== false,
    thresholdMB: bounded(source.thresholdMB, ASSET_DEFAULTS.thresholdMB, 1, 4096),
    targetHeight: TARGET_HEIGHTS.includes(Number(source.targetHeight)) ? Number(source.targetHeight) : ASSET_DEFAULTS.targetHeight,
    bitrateMbps: bounded(source.bitrateMbps, ASSET_DEFAULTS.bitrateMbps, 1, 40),
    includeSource: source.includeSource === true,
  };
}

/**
 * Where an encoder might live, most specific first.
 *
 * The configured path and the two conventional environment variables win, then
 * the install locations the mainstream package managers use on each platform,
 * and finally a bare PATH lookup — which is the one portable way to ask "is it
 * installed", because `spawn` resolves the name through the OS.
 */
function ffmpegCandidates(config, env = process.env) {
  const explicit = [config?.ffmpegPath, env.DSH_FFMPEG, env.FFMPEG_PATH].filter((value) => typeof value === 'string' && value.length > 0);
  const home = env.USERPROFILE ?? env.HOME ?? '';
  let common;
  if (process.platform === 'win32') {
    common = [
      join(env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
      join(env.LOCALAPPDATA ?? '', 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      join(home, 'scoop', 'shims', 'ffmpeg.exe'),
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
      join(env.ProgramData ?? '', 'chocolatey', 'bin', 'ffmpeg.exe'),
    ];
  } else if (process.platform === 'darwin') {
    common = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
  } else {
    common = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/snap/bin/ffmpeg'];
  }
  return [...explicit, ...common];
}

/** The bare name a PATH lookup needs on this platform. */
const ffmpegCommandName = () => (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

/**
 * Find a usable encoder and read its version.
 *
 * @returns `{ path, version, source }`, or `{ path: null, tried, error }` — never
 *   a throw, because "no encoder" is an expected state on a fresh machine and the
 *   caller has to be able to say so in the panel.
 */
async function resolveFfmpeg(config, run, env = process.env) {
  const tried = [];
  for (const candidate of ffmpegCandidates(config, env)) {
    tried.push(candidate);
    if (!existsSync(candidate)) continue;
    const probe = await run(candidate, ['-version'], 15000);
    if (probe.code === 0) {
      const version = String(probe.output ?? '').split('\n')[0].trim();
      return { path: candidate, version, source: candidate === config?.ffmpegPath ? 'configured' : 'location' };
    }
  }
  const name = ffmpegCommandName();
  tried.push(name);
  const probe = await run(name, ['-version'], 15000);
  if (probe.code === 0) {
    const version = String(probe.output ?? '').split('\n')[0].trim();
    return { path: name, version, source: 'path' };
  }
  return { path: null, tried, error: probe.error ?? (probe.code === null ? 'spawn-failed' : `exit-${probe.code}`) };
}

/**
 * Whether an upload is worth re-encoding — and when it is not, why not.
 *
 * A pure decision so the panel, the job log and the tests all agree on it.
 */
function compressDecision({ bytes, settings, renditionExists }) {
  if (settings.autoCompress !== true) return { compress: false, reason: '自动压缩已关闭' };
  if (renditionExists === true) return { compress: false, reason: '已有压缩版本' };
  const megabytes = bytes / 1048576;
  if (!(megabytes > settings.thresholdMB)) return { compress: false, reason: `${megabytes.toFixed(1)} MB 未超过 ${settings.thresholdMB} MB` };
  return { compress: true, reason: `${megabytes.toFixed(1)} MB > ${settings.thresholdMB} MB` };
}

/**
 * The encoder command line.
 *
 * `scale` is only added when the source is genuinely larger than the target, so
 * a 720p upload is re-encoded at its own size instead of being blown up — which
 * is also what keeps this free of comma-bearing filter expressions (no shell is
 * involved, so a filter string would have to be quoted for ffmpeg's own parser).
 */
function buildCompressArgs({ input, output, height, bitrateMbps, scale }) {
  const args = ['-hide_banner', '-nostdin', '-y', '-i', input];
  if (scale === true) args.push('-vf', `scale=-2:${height}`);
  args.push(
    '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
    '-maxrate', `${bitrateMbps}M`, '-bufsize', `${bitrateMbps * 2}M`,
    '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '128k',
    '-map_metadata', '-1',
    // The container is stated outright instead of being inferred from the name:
    // the encode targets a temporary file, and ffmpeg will not choose a muxer for
    // an extension it does not recognise.
    '-f', 'mp4',
    output,
  );
  return args;
}

/** One frame, scaled to the poster width the pipeline uses. */
function buildPosterArgs({ input, output, atSeconds }) {
  return ['-hide_banner', '-nostdin', '-y', '-ss', String(Math.max(0, atSeconds)), '-i', input, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '3', output];
}

/**
 * Transcode one video into a skin's rendition.
 *
 * `run` is injected so the whole path — argument shape, output handling, log
 * lines — is testable without an encoder on the machine, which is exactly the
 * situation this workspace is in.
 *
 * @returns `{ ok, args, bytes, scaled }` or `{ ok: false, error, code, output }`.
 */
async function compressVideo({ binary, input, output, height, bitrateMbps, sourceWidth, sourceHeight, run, timeoutMs = 30 * 60 * 1000 }) {
  const knowsSize = Number.isFinite(sourceWidth) && Number.isFinite(sourceHeight) && sourceWidth > 0 && sourceHeight > 0;
  const scale = !knowsSize || sourceHeight > height || sourceWidth > 1920;
  // Encode beside the target and swap only on success. The source route prefers
  // this path, so a failed or interrupted re-encode must never replace a
  // rendition that was already playing. The temporary name keeps the real
  // extension — `source.part.mp4`, never `source.mp4.part` — because ffmpeg picks
  // its muxer from the extension and refuses a name it cannot place. (Learned the
  // hard way: every real transcode failed with "Unable to choose an output format
  // for '…source.mp4.part'" until this was fixed.)
  const part = /(\.[^./\\]+)$/u.test(output) ? output.replace(/(\.[^./\\]+)$/u, '.part$1') : `${output}.part.mp4`;
  const args = buildCompressArgs({ input, output: part, height, bitrateMbps, scale });
  mkdirSync(dirname(output), { recursive: true });
  rmSync(part, { force: true });
  const result = await run(binary ?? 'ffmpeg', args, timeoutMs);
  if (result.code !== 0 || !existsSync(part)) {
    try {
      rmSync(part, { force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, args, code: result.code, output: String(result.output ?? '').slice(-2000), error: result.error ?? 'encode-failed' };
  }
  try {
    renameSync(part, output);
  } catch (error) {
    rmSync(part, { force: true });
    return { ok: false, args, error: 'rename-failed', detail: String(error?.message ?? error) };
  }
  return { ok: true, args, bytes: statSync(output).size, scaled: scale };
}

/** Extract one poster frame from a rendition. */
async function extractPoster({ binary, input, output, atSeconds, run }) {
  const args = buildPosterArgs({ input, output, atSeconds });
  mkdirSync(dirname(output), { recursive: true });
  const result = await run(binary, args, 120000);
  if (result.code !== 0 || !existsSync(output)) {
    try {
      rmSync(output, { force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, args, error: result.error ?? 'poster-failed', code: result.code };
  }
  return { ok: true, args, bytes: statSync(output).size };
}

/**
 * Compress one skin, writing the rendition inside it.
 *
 * Shared by the standalone asset job and by the pipeline job's compress step, so
 * the decision, the argument shape and the log wording cannot drift apart.
 *
 * @returns one result row: `{ skinId, status, reason|bytes|error }`.
 */
async function compressOne({ skinId, settings, ffmpeg, sizes, run, append }) {
  const skinDir = join(SKINS_DIR, skinId);
  const metaPath = join(skinDir, 'skin.json');
  if (!existsSync(metaPath)) {
    append(`跳过 ${skinId}：没有 skin.json`);
    return { skinId, status: 'skipped', reason: 'no-skin.json' };
  }
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch (error) {
    append(`跳过 ${skinId}：skin.json 读不出来（${String(error?.message ?? error)}）`);
    return { skinId, status: 'skipped', reason: 'skin-json-unreadable' };
  }
  if (meta.type !== 'video') {
    append(`跳过 ${skinId}：不是视频皮肤`);
    return { skinId, status: 'skipped', reason: 'not-a-video-skin' };
  }
  const sourceRel = meta.source?.file;
  const source = typeof sourceRel === 'string' ? resolveInsideWorkspace(sourceRel) : undefined;
  if (source === undefined || !existsSync(source)) {
    append(`跳过 ${skinId}：原视频不存在（${String(sourceRel)}）`);
    return { skinId, status: 'skipped', reason: 'source-missing' };
  }
  const rendition = join(skinDir, 'assets', RENDITION_NAME);
  const bytes = statSync(source).size;
  const decision = compressDecision({ bytes, settings, renditionExists: existsSync(rendition) });
  if (decision.compress !== true) {
    append(`跳过 ${skinId}：${decision.reason}`);
    return { skinId, status: 'skipped', reason: decision.reason };
  }
  const scan = sizes.get(skinId) ?? {};
  append(`压缩 ${skinId}（${decision.reason}）→ ${settings.targetHeight}p / ${settings.bitrateMbps} Mbps …`);
  const started = Date.now();
  const result = await compressVideo({
    binary: ffmpeg.path,
    input: source,
    output: rendition,
    height: settings.targetHeight,
    bitrateMbps: settings.bitrateMbps,
    sourceWidth: scan.width,
    sourceHeight: scan.height,
    run,
  });
  if (result.ok !== true) {
    append(`失败 ${skinId}：${result.error}（exit ${result.code}）`);
    for (const line of String(result.output ?? '').trim().split('\n').slice(-6)) append(`  ${line}`);
    return { skinId, status: 'failed', error: result.error, code: result.code };
  }
  const saved = bytes - result.bytes;
  append(
    `完成 ${skinId}：${(bytes / 1048576).toFixed(1)} MB → ${(result.bytes / 1048576).toFixed(1)} MB` +
      `（省 ${(saved / 1048576).toFixed(1)} MB）· ${((Date.now() - started) / 1000).toFixed(0)}s` +
      (result.scaled === true ? '' : ' · 源不高于目标，未放大'),
  );
  // A poster for a skin that has no frame report yet, so a video skin introduced
  // by an import still gets one. An existing report is never overwritten: it is
  // evidence of the original decode, and the pipeline reads it for the design.
  const stem = String(sourceRel).replace(/\.[^.]+$/u, '').replace(/[^\w.-]+/gu, '_');
  const reportPath = join(FRAMES_DIR, `${stem}.frames.json`);
  if (!existsSync(reportPath)) {
    const posterPath = join(FRAMES_DIR, `${stem}.poster.jpg`);
    const duration = Number(meta.source?.durationSeconds ?? 0);
    const atSeconds = duration > 0 ? Math.min(Math.max(duration * 0.1, 0.5), 6) : 1;
    const poster = await extractPoster({ binary: ffmpeg.path, input: rendition, output: posterPath, atSeconds, run });
    if (poster.ok === true) {
      const relative = posterPath.slice(WORKSPACE.length + 1).replaceAll('\\', '/');
      writeFileSync(
        reportPath,
        `${JSON.stringify(
          {
            video: basename(String(sourceRel)),
            ok: true,
            method: 'ffmpeg poster, extracted from the compressed rendition',
            source: { width: scan.width ?? 0, height: scan.height ?? 0, duration },
            times: [atSeconds],
            frames: [],
            poster: { path: relative, bytes: poster.bytes, width: 480, height: 0, atSeconds },
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      append(`  poster: output/analysis/frames/${stem}.poster.jpg（${(poster.bytes / 1024).toFixed(0)} KB @${atSeconds.toFixed(1)}s）`);
    } else {
      append(`  poster 提取失败（${poster.error}）：沿用已有海报或面板实测帧`);
    }
  }
  return { skinId, status: 'ok', bytes: result.bytes, saved, rendition: `assets/${RENDITION_NAME}` };
}

/** The video sizes the pipeline already measured, so the encoder knows when not to scale. */
function readScanSizes() {
  const sizes = new Map();
  try {
    for (const record of JSON.parse(readFileSync(join(PLANS_DIR, 'skin_ids.json'), 'utf8')).records) sizes.set(record.skinId, record);
  } catch {
    /* the plan is advisory: the file itself is the authority */
  }
  return sizes;
}

/**
 * The standalone compression job.
 *
 * One skin at a time on purpose: a transcode takes every core it is given, so a
 * second one would slow both down and make the progress log unreadable.
 */
function startCompressJob({ state, skinIds, settings, ffmpeg, log }) {
  const job = state.assetJob;
  const append = (line) => {
    job.log = `${job.log}${line}\n`;
    if (job.log.length > 40000) job.log = job.log.slice(-40000);
  };
  const sizes = readScanSizes();
  (async () => {
    try {
      if (ffmpeg.path === null) {
        job.status = 'failed';
        job.message = 'ffmpeg 未找到：无法压缩';
        append(`ffmpeg 未找到（${ffmpeg.error ?? 'unknown'}）。已尝试 ${ffmpeg.tried.length} 处：`);
        for (const candidate of ffmpeg.tried) append(`  - ${candidate}`);
        append('Windows 安装：winget install --id Gyan.FFmpeg -e');
        append('装好后重新打开面板即可（探测结果缓存 60 秒）');
        return;
      }
      append(`编码器：${ffmpeg.path}${ffmpeg.version === undefined ? '' : ` · ${ffmpeg.version}`}`);
      append(`设置：${settings.targetHeight}p · ${settings.bitrateMbps} Mbps · 阈值 ${settings.thresholdMB} MB · 自动压缩 ${settings.autoCompress ? '开' : '关'}`);
      append(`目标 ${skinIds.length} 套皮肤`);
      for (const skinId of skinIds) {
        const row = await compressOne({ skinId, settings, ffmpeg, sizes, run: runProcess, append });
        job.results.push(row);
      }
      const ok = job.results.filter((row) => row.status === 'ok').length;
      const skipped = job.results.filter((row) => row.status === 'skipped').length;
      const failed = job.results.filter((row) => row.status === 'failed').length;
      job.status = failed > 0 && ok === 0 ? 'failed' : 'succeeded';
      job.message = `压缩完成：成功 ${ok} · 跳过 ${skipped} · 失败 ${failed}`;
      append(job.message);
      log?.info?.(`compress job: ${job.message}`);
    } catch (error) {
      job.status = 'failed';
      job.message = String(error?.message ?? error);
      append(`[failed] ${job.message}`);
    } finally {
      job.endedAt = new Date().toISOString();
      job.running = false;
    }
  })();
}

/* ---- the zip container ---------------------------------------------------- *
 * A Store-method writer and a reader that also accepts deflate, so a pack the
 * user re-zipped with Explorer or 7-Zip still imports. Media is already
 * compressed, so storing costs nothing in practice and removes a dependency.
 * ------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** Build a zip from `{ name, data }` entries. */
function writeZip(entries, when = new Date()) {
  const local = [];
  const central = [];
  let offset = 0;
  const dosTime = ((when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2)) & 0xffff;
  const dosDate = (((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()) & 0xffff;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(0, 8); // stored
    head.writeUInt16LE(dosTime, 10);
    head.writeUInt16LE(dosDate, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, name, data);
    central.push({ name, crc, size: data.length, offset });
    offset += head.length + name.length + data.length;
  }
  const directory = [];
  let directorySize = 0;
  for (const row of central) {
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(dosTime, 12);
    head.writeUInt16LE(dosDate, 14);
    head.writeUInt32LE(row.crc, 16);
    head.writeUInt32LE(row.size, 20);
    head.writeUInt32LE(row.size, 24);
    head.writeUInt16LE(row.name.length, 28);
    head.writeUInt32LE(0, 30); // extra + comment lengths
    head.writeUInt16LE(0, 34);
    head.writeUInt16LE(0, 36);
    head.writeUInt32LE(0, 38);
    head.writeUInt32LE(row.offset, 42);
    directory.push(head, row.name);
    directorySize += head.length + row.name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...local, ...directory, end]);
}

/** Read a zip, verifying every entry's CRC before it is written anywhere. */
function readZip(buffer) {
  let end = -1;
  const floor = Math.max(0, buffer.length - 22 - 0xffff);
  for (let at = buffer.length - 22; at >= floor; at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end === -1) return { ok: false, error: 'not-a-zip' };
  const count = buffer.readUInt16LE(end + 10);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) return { ok: false, error: 'zip64-not-supported' };
  const entries = [];
  let at = directoryOffset;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) return { ok: false, error: 'central-header-mismatch', at };
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const rawSize = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) return { ok: false, error: 'local-header-mismatch', name };
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(start, start + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw);
      } catch (error) {
        return { ok: false, error: 'inflate-failed', name, detail: String(error?.message ?? error) };
      }
    } else return { ok: false, error: 'unsupported-method', name, method };
    if (data.length !== rawSize) return { ok: false, error: 'size-mismatch', name };
    if (crc32(data) !== crc) return { ok: false, error: 'crc-mismatch', name };
    total += data.length;
    entries.push({ name, data, bytes: data.length });
  }
  return { ok: true, entries, total };
}

/* ---- user preferences: order, favourites, tags ---------------------------- *
 * Kept on disk rather than in the browser because the user asked for it to survive
 * a restart *and* a cleared renderer profile, and because a stored order is
 * meaningless without the skins it refers to.
 * ------------------------------------------------------------------------- */

const PREFERENCES_NAME = 'skins-preferences.json';
/** Sanity caps: the file is user-editable, so nothing in it is trusted. */
const PREFERENCE_LIMITS = { list: 5000, tags: 500, tagLength: 24, tagsPerSkin: 24 };

const preferencesFile = () => join(REPORTS_DIR, PREFERENCES_NAME);
const isSkinId = (value) => typeof value === 'string' && /^(img|video)_[\w.-]+$/u.test(value);

/** Keep only well-formed skin ids, in order, without duplicates. */
function preferenceIds(value, limit = PREFERENCE_LIMITS.list) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const one of value) {
    if (!isSkinId(one) || seen.has(one)) continue;
    seen.add(one);
    out.push(one);
    if (out.length >= limit) break;
  }
  return out;
}

/** Tag names are free text, so they are trimmed and bounded rather than matched. */
function preferenceTags(value) {
  const out = {};
  if (value === null || typeof value !== 'object') return out;
  for (const [skinId, list] of Object.entries(value)) {
    if (!isSkinId(skinId)) continue;
    if (!Array.isArray(list)) continue;
    const tags = [];
    for (const one of list) {
      if (typeof one !== 'string') continue;
      const tag = one.trim().slice(0, PREFERENCE_LIMITS.tagLength);
      if (tag.length === 0 || tags.includes(tag)) continue;
      tags.push(tag);
      if (tags.length >= PREFERENCE_LIMITS.tagsPerSkin) break;
    }
    if (tags.length > 0) out[skinId] = tags;
    if (Object.keys(out).length >= PREFERENCE_LIMITS.tags) break;
  }
  return out;
}

/**
 * Merge a patch over the stored preferences.
 *
 * Field by field, and additive on purpose: the panel saves the order, the
 * favourites and the tags independently, and a partial write must never erase one
 * of the others. A field that is absent keeps what is on disk; a field that is
 * present replaces it.
 */
function mergePreferences(base, patch) {
  const stored = base !== null && typeof base === 'object' ? base : {};
  const source = patch !== null && typeof patch === 'object' ? patch : {};
  const pick = (value, fallback, limit) => (value === undefined ? preferenceIds(fallback, limit) : preferenceIds(value, limit));
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    order: pick(source.order, stored.order, PREFERENCE_LIMITS.list),
    favorites: pick(source.favorites, stored.favorites, PREFERENCE_LIMITS.list),
    hidden: pick(source.hidden, stored.hidden, PREFERENCE_LIMITS.list),
    tags: source.tags === undefined ? preferenceTags(stored.tags) : preferenceTags(source.tags),
  };
}

function readPreferences(file) {
  try {
    if (!existsSync(file)) return mergePreferences(null, {});
    return mergePreferences(JSON.parse(readFileSync(file, 'utf8')), {});
  } catch (error) {
    // A corrupt file must not take the panel down: start clean and say so.
    return Object.assign(mergePreferences(null, {}), { note: `无法读取 ${basename(file)}：${String(error?.message ?? error)}` });
  }
}

/** Write via a temporary file, so an interrupted save cannot truncate the order. */
function writePreferences(file, preferences) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
  return preferences;
}

/**
 * The plan for an *explicit* deletion.
 *
 * Deliberately not filtered by the keep set: the user picked these skins in the
 * panel and confirmed a dialog that named them, so this is not the "clean up what
 * nothing references" path — that one keeps its keep-set semantics.
 */
function planExplicitDeletion(skinsDir, skinIds) {
  const remove = [];
  const missing = [];
  for (const skinId of preferenceIds(skinIds)) {
    const dir = join(skinsDir, skinId);
    if (!existsSync(dir)) {
      missing.push(skinId);
      continue;
    }
    let bytes = 0;
    try {
      bytes = directorySize(dir);
    } catch {
      bytes = 0;
    }
    remove.push({ skinId, bytes });
  }
  remove.sort((a, b) => b.bytes - a.bytes);
  return { remove, missing, kept: [], totalBytes: remove.reduce((sum, row) => sum + row.bytes, 0) };
}

/** Total size of a directory tree, used by the cleanup report. */
function directorySize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    try {
      total += entry.isDirectory() ? directorySize(full) : statSync(full).size;
    } catch {
      /* a file that vanished mid-scan counts as nothing */
    }
  }
  return total;
}

/** The files a pack carries for one skin. */
function buildPackEntries(skinDir, skinId, { includeSource, settings, automation, uiVersion }) {
  const entries = [];
  const add = (name, file) => {
    if (existsSync(file)) entries.push({ name, data: readFileSync(file) });
  };
  for (const name of ['skin.json', 'tokens.json', 'theme.css', 'preview.html', 'README.md']) add(name, join(skinDir, name));
  const assets = join(skinDir, 'assets');
  if (existsSync(assets)) {
    for (const name of readdirSync(assets).sort()) add(`assets/${name}`, join(assets, name));
  }
  let meta = null;
  try {
    meta = JSON.parse(readFileSync(join(skinDir, 'skin.json'), 'utf8'));
  } catch {
    meta = null;
  }
  let source = null;
  if (includeSource === true && typeof meta?.source?.file === 'string') {
    const file = resolveInsideWorkspace(meta.source.file);
    if (file !== undefined && existsSync(file)) {
      source = `source/${basename(meta.source.file)}`;
      add(source, file);
    }
  }
  const manifest = {
    format: 'dsh-skin-pack/1',
    exportedAt: new Date().toISOString(),
    skinId,
    appRevision: REVISION,
    uiVersion: uiVersion ?? null,
    source: { file: meta?.source?.file ?? null, included: source !== null, bytes: meta?.source?.bytes ?? null },
    rendition: existsSync(join(assets, RENDITION_NAME)) ? `assets/${RENDITION_NAME}` : null,
    settings,
    automation,
  };
  entries.unshift({ name: 'pack.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') });
  const bytes = entries.reduce((sum, entry) => sum + entry.data.length, 0);
  return { entries, manifest, bytes };
}

/** Unpack one pack into `targetRoot/<skinId>`, validating everything first. */
function importPack(buffer, { targetRoot, overwrite, sourceDir = INPUT_DIRS.video }) {
  const zip = readZip(buffer);
  if (zip.ok !== true) return { ok: false, error: zip.error, detail: zip.detail ?? null };
  const skinEntry = zip.entries.find((entry) => entry.name === 'skin.json');
  if (skinEntry === undefined) return { ok: false, error: 'pack-has-no-skin-json', entries: zip.entries.map((entry) => entry.name).slice(0, 12) };
  let meta;
  try {
    meta = JSON.parse(skinEntry.data.toString('utf8'));
  } catch (error) {
    return { ok: false, error: 'skin-json-unreadable', detail: String(error?.message ?? error) };
  }
  const skinId = typeof meta.skinId === 'string' && /^(img|video)_[\w.-]+$/u.test(meta.skinId) ? meta.skinId : null;
  if (skinId === null) return { ok: false, error: 'invalid-skin-id', detail: String(meta?.skinId) };
  if (zip.total > PACK_LIMIT) return { ok: false, error: 'pack-too-large', detail: `${zip.total} bytes` };
  // Validate every entry before writing anything, so an unsafe pack cannot leave
  // a half-extracted skin behind.
  const writes = [];
  let sourceEntry = null;
  for (const entry of zip.entries) {
    if (entry.name === 'pack.json') continue;
    const name = entry.name.replaceAll('\\', '/');
    if (name.startsWith('/') || /^[a-z]:/iu.test(name) || name.split('/').includes('..')) return { ok: false, error: 'unsafe-entry', name: entry.name };
    if (name.startsWith('source/')) {
      sourceEntry = { name: basename(name), data: entry.data };
      continue;
    }
    writes.push({ name, data: entry.data });
  }
  if (writes.some((entry) => entry.name === 'tokens.json') !== true) return { ok: false, error: 'pack-has-no-tokens-json' };
  const dir = join(targetRoot, skinId);
  const replaced = existsSync(dir);
  if (replaced && overwrite !== true) return { ok: false, error: 'skin-exists', skinId };
  const warnings = [];
  if (!writes.some((entry) => entry.name.startsWith('assets/'))) warnings.push('包里没有 assets/（壁纸/海报缺失，皮肤会显示为无预览）');
  const staging = `${dir}.importing`;
  rmSync(staging, { recursive: true, force: true });
  try {
    mkdirSync(join(staging, 'assets'), { recursive: true });
    for (const file of writes) {
      const dest = join(staging, file.name);
      if (!dest.startsWith(staging + sep)) return { ok: false, error: 'entry-escapes-skin', name: file.name };
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.data);
    }
    // Swap only once the whole pack is on disk, so a failed import cannot destroy
    // the skin it was replacing.
    if (replaced) rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: 'unpack-failed', detail: String(error?.message ?? error) };
  }
  let restoredSource = null;
  if (sourceEntry !== null) {
    mkdirSync(sourceDir, { recursive: true });
    const dest = join(sourceDir, sourceEntry.name);
    if (existsSync(dest)) warnings.push(`原视频 input_video/${sourceEntry.name} 已存在，未覆盖`);
    else {
      writeFileSync(dest, sourceEntry.data);
      restoredSource = `input_video/${sourceEntry.name}`;
    }
  }
  let manifest = null;
  const manifestEntry = zip.entries.find((entry) => entry.name === 'pack.json');
  if (manifestEntry !== undefined) {
    try {
      manifest = JSON.parse(manifestEntry.data.toString('utf8'));
    } catch {
      manifest = null;
    }
  }
  return { ok: true, skinId, replaced, files: writes.length, bytes: zip.total, source: restoredSource, warnings, manifest };
}

/**
 * Which skin directories nothing references. Pure, so the decision is testable.
 *
 * `keep` is computed by the panel, because only the *client* knows what the user
 * is using: the current skin, the favourites, the automation bindings, and every
 * skin whose knobs were touched live in browser storage, not on disk.
 */
function planCleanup(skinsDir, keep) {
  const keepSet = new Set((Array.isArray(keep) ? keep : []).map(String));
  const all = existsSync(skinsDir) ? readdirSync(skinsDir).filter((name) => /^(img|video)_/.test(name)) : [];
  const remove = [];
  const kept = [];
  for (const name of all) {
    if (keepSet.has(name)) {
      kept.push(name);
      continue;
    }
    let bytes = 0;
    try {
      bytes = directorySize(join(skinsDir, name));
    } catch {
      bytes = 0;
    }
    remove.push({ skinId: name, bytes });
  }
  remove.sort((a, b) => b.bytes - a.bytes);
  return { remove, kept: kept.sort(), totalBytes: remove.reduce((sum, row) => sum + row.bytes, 0) };
}

/**
 * Move the planned directories out of the skins tree.
 *
 * The Windows Recycle Bin is used when it can be, so a mistake is restorable
 * from Explorer. Any failure — or any other platform — falls back to a
 * quarantine directory inside the workspace rather than deleting, and the log
 * records which of the two actually happened for every folder.
 */
async function applyCleanup(plan, { skinsDir, trashDir, run, when, platform = process.platform }) {
  const lines = [];
  const quarantine = join(trashDir, when);
  const moved = [];
  for (const row of plan.remove) {
    const from = join(skinsDir, row.skinId);
    // A plan can be acted on after something else removed the folder; claiming
    // "deleted" for a folder that was never there would be a false log line.
    if (!existsSync(from)) {
      moved.push(Object.assign({}, row, { how: 'missing' }));
      lines.push(`  ${row.skinId}  已不在目录中（计划生成之后被移除？），跳过`);
      continue;
    }
    let how = null;
    // Platform is a parameter, not a global read: the Recycle Bin branch is the
    // one behaviour that cannot be exercised on a Linux runner otherwise.
    if (platform === 'win32') {
      const target = from.replace(/'/gu, "''");
      const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${target}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
      const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 60000);
      if (result.code === 0 && !existsSync(from)) how = 'recycle-bin';
      else {
        const detail = String(result.output ?? result.error ?? '').trim().split('\n').pop() ?? '';
        lines.push(`  ${row.skinId}: 回收站不可用${detail === '' ? '' : `（${detail.slice(0, 120)}）`}，改用隔离目录`);
      }
    }
    if (how === null) {
      mkdirSync(quarantine, { recursive: true });
      try {
        renameSync(from, join(quarantine, row.skinId));
        how = 'quarantine';
      } catch {
        rmSync(from, { recursive: true, force: true });
        how = 'deleted';
      }
    }
    const where = how === 'recycle-bin' ? '回收站' : how === 'quarantine' ? `隔离目录 output/_trash/${when}/` : '已删除（无法移动）';    moved.push(Object.assign({}, row, { how }));
    lines.push(`  ${row.skinId}  ${(row.bytes / 1048576).toFixed(1)} MB  →  ${where}`);
  }
  return { moved, lines };
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

export function apply(ctx, config) {
  const log = ctx.logger ? ctx.logger('dsh-skins') : console;
  // A published install has no checkout: the profile config names the data
  // directory (`dataDir`, or `workspaceDir` for a development tree) and every
  // derived path moves with it. Without either, `defaultRoot()` decided already.
  const configuredRoot = typeof config?.dataDir === 'string' && config.dataDir.length > 0
    ? config.dataDir
    : typeof config?.workspaceDir === 'string' && config.workspaceDir.length > 0
      ? config.workspaceDir
      : null;
  if (configuredRoot !== null) configureRoot(configuredRoot);
  // An advanced install may keep the generation pipeline outside the data root.
  // It still has to follow the same layout (plans, frames and input dirs are
  // shared), so only the script/group directories move.
  if (typeof config?.scanDir === 'string' && config.scanDir.length > 0) {
    SCAN_DIR = resolve(config.scanDir);
    IMAGE_GROUPS_DIR = join(SCAN_DIR, 'image_groups');
    VIDEO_GROUPS_DIR = join(SCAN_DIR, 'video_groups');
    AUTO_IMAGE_GROUP = join(IMAGE_GROUPS_DIR, 'group_e.json');
    AUTO_VIDEO_GROUP = join(VIDEO_GROUPS_DIR, 'group_v5.json');
  }
  const defaultSkin = typeof config?.defaultSkin === 'string' && config.defaultSkin.length > 0 ? config.defaultSkin : null;
  const state = {
    job: {
      id: null,
      status: 'idle',
      running: false,
      startedAt: null,
      endedAt: null,
      steps: [],
      log: '',
      newSkins: [],
      message: null,
    },
    /** The encoder probe, cached for a minute so a missing ffmpeg is not re-spawned per request. */
    ffmpeg: null,
    /** The standalone compression job, separate from the pipeline job. */
    assetJob: {
      id: null,
      kind: null,
      status: 'idle',
      running: false,
      startedAt: null,
      endedAt: null,
      log: '',
      results: [],
      message: null,
    },
  };

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          const url = new URL(req.url ?? ROUTE, 'http://127.0.0.1');
          const head = req.method === 'HEAD';
          if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
            respondJson(res, 405, { ok: false, error: 'method-not-allowed' }, { allow: 'GET, HEAD, POST' });
            return;
          }
          // Cross-site reads of workspace media are refused; the app is same-origin.
          if (req.headers['sec-fetch-site'] === 'cross-site') {
            respondJson(res, 403, { ok: false, error: 'cross-site' });
            return;
          }

          if (url.pathname === `${ROUTE}/version`) {
            respondJson(res, 200, {
              ok: true,
              revision: REVISION,
              workspace: WORKSPACE,
              node: nodeRunner(config).command,
              job: { status: state.job.status, running: state.job.running },
            });
            return;
          }

          if (url.pathname === `${ROUTE}/catalog`) {
            const catalog = readCatalog();
            // A configured default that is no longer on disk (or never shipped)
            // must not leave the panel pointing at a missing skin: fall back to
            // the first library entry, or to null for an empty library.
            const preferred =
              defaultSkin !== null && Array.isArray(catalog.skins) && catalog.skins.some((skin) => skin.skinId === defaultSkin)
                ? defaultSkin
                : (Array.isArray(catalog.skins) ? catalog.skins[0]?.skinId ?? null : null);
            respondJson(res, catalog.ok === true ? 200 : 500, { ...catalog, defaultSkin: preferred }, {}, head);
            return;
          }

          if (url.pathname === `${ROUTE}/job`) {
            respondJson(res, 200, { ok: true, job: state.job }, {}, head);
            return;
          }

          if (url.pathname === `${ROUTE}/upload` && req.method === 'POST') {
            const raw = req.headers['x-dsh-skin-filename'];
            if (typeof raw !== 'string' || raw.length === 0) {
              respondJson(res, 400, { ok: false, error: 'filename-header-required' });
              return;
            }
            let decoded;
            try {
              decoded = decodeURIComponent(raw);
            } catch {
              respondJson(res, 400, { ok: false, error: 'filename-header-invalid' });
              return;
            }
            // One flat name inside the workspace, with the extension deciding
            // the directory: never a caller-chosen path.
            const safe = basename(decoded).replace(/[^\w.\-()\u4e00-\u9fff ]+/gu, '_').slice(-120);
            const extension = extname(safe).toLowerCase();
            const kind = UPLOAD_KINDS[extension];
            if (kind === undefined) {
              respondJson(res, 415, { ok: false, error: 'unsupported-extension', extension, allowed: Object.keys(UPLOAD_KINDS) });
              return;
            }
            const dir = INPUT_DIRS[kind];
            mkdirSync(dir, { recursive: true });
            const file = join(dir, safe);
            if (existsSync(file) && url.searchParams.get('overwrite') !== '1') {
              respondJson(res, 409, { ok: false, error: 'file-exists', file: `input_${kind}/${safe}` });
              return;
            }
            if (url.searchParams.get('overwrite') === '1') rmSync(file, { force: true });
            const written = await writeStreamToFile(req, file, UPLOAD_LIMIT);
            if (written.ok !== true) {
              respondJson(res, written.status ?? 500, { ok: false, error: written.error, detail: written.detail ?? null });
              return;
            }
            log.info(`uploaded input_${kind}/${safe} (${written.bytes} bytes)`);
            respondJson(res, 200, { ok: true, kind, file: `input_${kind}/${safe}`, name: safe, bytes: written.bytes });
            return;
          }

          // A poster frame measured in the browser, for a video the headless
          // extractor could not process. Written in the same report shape
          // `make_frame_map.mjs` reads, so the build treats it as a real frame.
          if (url.pathname.startsWith(`${ROUTE}/frames/`) && req.method === 'POST') {
            let videoName;
            try {
              videoName = decodeURIComponent(url.pathname.slice(`${ROUTE}/frames/`.length));
            } catch {
              respondJson(res, 400, { ok: false, error: 'video-name-invalid' });
              return;
            }
            const safeVideo = basename(videoName);
            const stem = safeVideo.replace(/\.[^.]+$/u, '').replace(/[^\w.-]+/gu, '_');
            const atSeconds = Number(req.headers['x-dsh-poster-at']);
            const width = Number(req.headers['x-dsh-video-width']);
            const height = Number(req.headers['x-dsh-video-height']);
            const duration = Number(req.headers['x-dsh-video-duration']);
            if (!Number.isFinite(atSeconds) || !Number.isFinite(width) || !Number.isFinite(height)) {
              respondJson(res, 400, { ok: false, error: 'poster-headers-required' });
              return;
            }
            mkdirSync(FRAMES_DIR, { recursive: true });
            const reportPath = join(FRAMES_DIR, `${stem}.frames.json`);
            const posterPath = join(FRAMES_DIR, `${stem}.poster.jpg`);
            const reportExists = existsSync(reportPath) && (() => {
              try {
                return JSON.parse(readFileSync(reportPath, 'utf8')).ok === true;
              } catch {
                return false;
              }
            })();
            if (reportExists) {
              respondJson(res, 200, { ok: true, skipped: 'a decoded-frame report already exists', report: `output/analysis/frames/${stem}.frames.json` });
              return;
            }
            const written = await writeStreamToFile(req, posterPath, 32 * 1024 * 1024);
            if (written.ok !== true) {
              respondJson(res, written.status ?? 500, { ok: false, error: written.error, detail: written.detail ?? null });
              return;
            }
            const relative = posterPath.slice(WORKSPACE.length + 1).replaceAll('\\', '/');
            writeFileSync(
              reportPath,
              `${JSON.stringify({
                video: safeVideo,
                ok: true,
                method: 'panel-measured poster (the headless frame extractor was unavailable)',
                source: { width, height, duration: Number.isFinite(duration) ? duration : 0 },
                times: [atSeconds],
                frames: [],
                poster: { path: relative, bytes: written.bytes, width, height, atSeconds },
              }, null, 2)}\n`,
              'utf8',
            );
            log.info(`wrote poster report for ${safeVideo} at ${atSeconds}s (${written.bytes} bytes)`);
            respondJson(res, 200, { ok: true, report: `output/analysis/frames/${stem}.frames.json`, poster: relative, bytes: written.bytes });
            return;
          }

          if (url.pathname === `${ROUTE}/generate` && req.method === 'POST') {
            if (state.job.running === true) {
              respondJson(res, 409, { ok: false, error: 'job-already-running', job: state.job });
              return;
            }
            const body = await readBody(req, 2 * 1024 * 1024);
            if (body === undefined) {
              respondJson(res, 400, { ok: false, error: 'invalid-body' });
              return;
            }
            state.job = {
              id: `job-${Date.now().toString(36)}`,
              status: 'running',
              running: true,
              startedAt: new Date().toISOString(),
              endedAt: null,
              steps: [],
              log: '',
              newSkins: [],
              message: null,
            };
            log.info(`${state.job.id}: generation requested`);
            startJob(ctx, config, state, body?.records ?? {}, readAssetSettings(body?.settings));
            respondJson(res, 200, { ok: true, job: state.job });
            return;
          }

          if (url.pathname === `${ROUTE}/ffmpeg`) {
            // Probed lazily and cached for a minute: a fresh machine has no
            // encoder, and the panel must be able to say so without a restart.
            const now = Date.now();
            if (state.ffmpeg === null || now - state.ffmpeg.at > 60000) {
              const found = await resolveFfmpeg(config, runProcess);
              state.ffmpeg = { at: now, found };
              log.info(found.path === null ? `ffmpeg not found (tried ${found.tried.length} locations)` : `ffmpeg: ${found.path}`);
            }
            respondJson(res, 200, { ok: true, available: state.ffmpeg.found.path !== null, ...state.ffmpeg.found, defaults: ASSET_DEFAULTS, targetHeights: TARGET_HEIGHTS }, {}, head);
            return;
          }

          if (url.pathname === `${ROUTE}/asset-job`) {
            respondJson(res, 200, { ok: true, job: state.assetJob }, {}, head);
            return;
          }

          if (url.pathname === `${ROUTE}/compress` && req.method === 'POST') {
            if (state.assetJob.running === true) {
              respondJson(res, 409, { ok: false, error: 'asset-job-running', job: state.assetJob });
              return;
            }
            const body = await readBody(req, 2 * 1024 * 1024);
            if (body === undefined) {
              respondJson(res, 400, { ok: false, error: 'invalid-body' });
              return;
            }
            const settings = readAssetSettings(body.settings);
            const requested = Array.isArray(body.skinIds) && body.skinIds.length > 0 ? body.skinIds.map(String) : null;
            if (requested === null) {
              respondJson(res, 400, { ok: false, error: 'skin-ids-required' });
              return;
            }
            const found = await resolveFfmpeg(config, runProcess);
            state.ffmpeg = { at: Date.now(), found };
            state.assetJob = {
              id: `assets-${Date.now().toString(36)}`,
              kind: 'compress',
              status: 'running',
              running: true,
              startedAt: new Date().toISOString(),
              endedAt: null,
              log: '',
              results: [],
              message: null,
            };
            startCompressJob({ config, state, skinIds: requested, settings, ffmpeg: found, log });
            respondJson(res, 200, { ok: true, job: state.assetJob, ffmpeg: { available: found.path !== null, path: found.path, version: found.version ?? null } });
            return;
          }

          if (url.pathname === `${ROUTE}/export` && req.method === 'POST') {
            const body = await readBody(req, 2 * 1024 * 1024);
            if (body === undefined) {
              respondJson(res, 400, { ok: false, error: 'invalid-body' });
              return;
            }
            const skinId = typeof body.skinId === 'string' ? body.skinId : '';
            if (!/^(img|video)_[\w.-]+$/u.test(skinId)) {
              respondJson(res, 400, { ok: false, error: 'invalid-skin-id', skinId });
              return;
            }
            const skinDir = join(SKINS_DIR, skinId);
            if (!existsSync(join(skinDir, 'skin.json'))) {
              respondJson(res, 404, { ok: false, error: 'unknown-skin', skinId });
              return;
            }
            const settings = readAssetSettings(body.settings);
            const built = buildPackEntries(skinDir, skinId, {
              includeSource: settings.includeSource,
              settings,
              automation: body.automation ?? null,
              uiVersion: typeof body.uiVersion === 'string' ? body.uiVersion : null,
            });
            if (built.bytes > PACK_LIMIT) {
              respondJson(res, 413, { ok: false, error: 'pack-too-large', bytes: built.bytes, detail: '关掉「包含原始视频」再导出' });
              return;
            }
            mkdirSync(EXPORTS_DIR, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
            const file = join(EXPORTS_DIR, `${skinId}-${stamp}.zip`);
            const zip = writeZip(built.entries);
            writeFileSync(file, zip);
            const relative = file.slice(WORKSPACE.length + 1).replaceAll('\\', '/');
            log.info(`exported ${relative} (${zip.length} bytes, ${built.entries.length} entries)`);
            respondJson(res, 200, {
              ok: true,
              skinId,
              file: relative,
              bytes: zip.length,
              entries: built.entries.map((entry) => entry.name),
              manifest: built.manifest,
            });
            return;
          }

          if (url.pathname === `${ROUTE}/import` && req.method === 'POST') {
            const name = typeof req.headers['x-dsh-skin-pack'] === 'string' ? decodeURIComponent(req.headers['x-dsh-skin-pack']) : 'pack.zip';
            const staging = join(SCAN_DIR, `.import-${Date.now().toString(36)}.zip`);
            const written = await writeStreamToFile(req, staging, 2 * 1024 * 1024 * 1024);
            if (written.ok !== true) {
              respondJson(res, written.status ?? 500, { ok: false, error: written.error, detail: written.detail ?? null });
              return;
            }
            let result;
            try {
              result = importPack(readFileSync(staging), { targetRoot: SKINS_DIR, overwrite: url.searchParams.get('overwrite') !== '0' });
            } catch (error) {
              result = { ok: false, error: 'import-failed', detail: String(error?.message ?? error) };
            } finally {
              rmSync(staging, { force: true });
            }
            if (result.ok !== true) {
              respondJson(res, 400, { pack: name, ...result });
              return;
            }
            log.info(`imported ${result.skinId} from ${name} (${result.files} files)`);
            respondJson(res, 200, { ok: true, pack: name, ...result });
            return;
          }

          if (url.pathname === `${ROUTE}/settings`) {
            // One file for the whole panel configuration, so export and import are the
            // same operation in both directions.
            const file = join(REPORTS_DIR, 'skins-settings.json');
            const relative = file.slice(WORKSPACE.length + 1).replaceAll('\\', '/');
            if (req.method === 'GET') {
              let stored = null;
              try {
                stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
              } catch (error) {
                stored = { note: `无法解析 ${basename(file)}：${String(error?.message ?? error)}` };
              }
              respondJson(res, 200, { ok: true, file: relative, exists: existsSync(file), settings: stored }, {}, head);
              return;
            }
            if (req.method === 'POST') {
              const body = await readBody(req, 8 * 1024 * 1024);
              if (body === undefined || body === null || typeof body !== 'object') {
                respondJson(res, 400, { ok: false, error: 'invalid-body' });
                return;
              }
              const settings = Object.assign({}, body, { exportedAt: new Date().toISOString(), appRevision: REVISION });
              mkdirSync(REPORTS_DIR, { recursive: true });
              const temp = `${file}.tmp`;
              writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
              renameSync(temp, file);
              log.info(`settings written: ${basename(file)}`);
              respondJson(res, 200, { ok: true, file: relative, settings });
              return;
            }
            respondJson(res, 405, { ok: false, error: 'method-not-allowed' });
            return;
          }

          if (url.pathname === `${ROUTE}/preferences`) {
            const file = preferencesFile();
            const relative = file.slice(WORKSPACE.length + 1).replaceAll('\\', '/');
            if (req.method === 'GET') {
              respondJson(res, 200, { ok: true, file: relative, preferences: readPreferences(file) }, {}, head);
              return;
            }
            if (req.method === 'POST') {
              const body = await readBody(req, 4 * 1024 * 1024);
              if (body === undefined) {
                respondJson(res, 400, { ok: false, error: 'invalid-body' });
                return;
              }
              const merged = mergePreferences(readPreferences(file), body);
              writePreferences(file, merged);
              log.info(`preferences: order=${merged.order.length} favorites=${merged.favorites.length} tagged=${Object.keys(merged.tags).length}`);
              respondJson(res, 200, { ok: true, file: relative, preferences: merged });
              return;
            }
            respondJson(res, 405, { ok: false, error: 'method-not-allowed' });
            return;
          }

          if (url.pathname === `${ROUTE}/cleanup` && req.method === 'POST') {
            const body = await readBody(req, 2 * 1024 * 1024);
            if (body === undefined) {
              respondJson(res, 400, { ok: false, error: 'invalid-body' });
              return;
            }
            const keep = Array.isArray(body.keep) ? body.keep.map(String) : [];
            // Two intents over one mechanism: an explicit deletion names the skins the
            // user confirmed in a dialog (the keep set does not apply), while an omitted
            // list means "clean up whatever nothing references".
            const explicit = Array.isArray(body.skinIds) ? preferenceIds(body.skinIds) : null;
            const explicitRun = explicit !== null && explicit.length > 0;
            const plan = explicitRun ? planExplicitDeletion(SKINS_DIR, explicit) : planCleanup(SKINS_DIR, keep);
            if (body.dryRun === true) {
              respondJson(res, 200, { ok: true, dryRun: true, explicit: explicitRun, requested: explicit?.length ?? 0, keep: keep.length, remove: plan.remove, missing: plan.missing ?? [], kept: plan.kept.length, totalBytes: plan.totalBytes });
              return;
            }
            const when = new Date().toISOString().replace(/[:.]/gu, '-');
            const applied = await applyCleanup(plan, { skinsDir: SKINS_DIR, trashDir: TRASH_DIR, run: runProcess, when });
            const header = [
              `dsh-skins cleanup ${new Date().toISOString()}`,
              `skins dir: ${SKINS_DIR}`,
              explicitRun ? `mode: explicit deletion requested by the panel (${explicit.length} id(s))` : `mode: unreferenced cleanup`,
              ...(explicitRun ? [] : [`kept (${plan.kept.length}): ${plan.kept.join(', ') || '(none)'}`]),
              `removed (${applied.moved.length}), total ${(plan.totalBytes / 1048576).toFixed(1)} MB`,
              ...((plan.missing ?? []).length > 0 ? [`requested but not on disk: ${plan.missing.join(', ')}`] : []),
            ].join('\n');
            const text = `${header}\n${applied.lines.join('\n')}\n`;
            mkdirSync(REPORTS_DIR, { recursive: true });
            const logFile = join(REPORTS_DIR, `skins-cleanup-${when}.log`);
            writeFileSync(logFile, text, 'utf8');
            log.info(`${explicitRun ? 'deleted' : 'cleanup'}: ${applied.moved.length} folder(s), log ${basename(logFile)}`);
            respondJson(res, 200, {
              ok: true,
              dryRun: false,
              explicit: explicitRun,
              removed: applied.moved,
              missing: plan.missing ?? [],
              kept: plan.kept,
              totalBytes: plan.totalBytes,
              logFile: logFile.slice(WORKSPACE.length + 1).replaceAll('\\', '/'),
              log: text,
            });
            return;
          }

          if (url.pathname === `${ROUTE}/asset/`) {
            respondJson(res, 400, { ok: false, error: 'asset-path-required' });
            return;
          }
          if (url.pathname.startsWith(`${ROUTE}/asset/`)) {
            const rest = decodeURIComponent(url.pathname.slice(`${ROUTE}/asset/`.length));
            const slash = rest.lastIndexOf('/');
            if (slash === -1) {
              respondJson(res, 400, { ok: false, error: 'asset-name-required' });
              return;
            }
            const skinId = rest.slice(0, slash);
            const assetName = rest.slice(slash + 1);
            if (!/^[\w.-]+$/u.test(assetName) || skinId.includes('/') || skinId.includes('..')) {
              respondJson(res, 400, { ok: false, error: 'invalid-asset-name' });
              return;
            }
            const file = resolveInsideWorkspace(join('output', 'skins', skinId, 'assets', assetName));
            if (file === undefined) {
              respondJson(res, 403, { ok: false, error: 'outside-workspace' });
              return;
            }
            streamFile(file, req, res);
            return;
          }

          if (url.pathname === `${ROUTE}/chrome.css`) {
            // The plugin's own shell-chrome adjustments, served from the plugin
            // directory rather than from a skin, so every skin shares one copy.
            const file = resolveInsideWorkspace(join('output', 'plugin', 'dsh-skins', 'chrome.css'));
            if (file === undefined) {
              respondJson(res, 500, { ok: false, error: 'chrome-css-unresolvable' });
              return;
            }
            streamFile(file, req, res);
            return;
          }

          if (url.pathname.startsWith(`${ROUTE}/doc/`)) {
            // Text documents a skin ships (theme.css). Separate from /asset/ so
            // the browser half can fetch them as text and inject them itself.
            const rest = decodeURIComponent(url.pathname.slice(`${ROUTE}/doc/`.length));
            const slash = rest.lastIndexOf('/');
            if (slash === -1) {
              respondJson(res, 400, { ok: false, error: 'doc-name-required' });
              return;
            }
            const skinId = rest.slice(0, slash);
            const docName = rest.slice(slash + 1);
            if (!/^[\w.-]+$/u.test(docName) || !/^[\w.-]+$/u.test(skinId)) {
              respondJson(res, 400, { ok: false, error: 'invalid-doc-name' });
              return;
            }
            const file = resolveInsideWorkspace(join('output', 'skins', skinId, docName));
            if (file === undefined) {
              respondJson(res, 403, { ok: false, error: 'outside-workspace' });
              return;
            }
            streamFile(file, req, res);
            return;
          }

          if (url.pathname.startsWith(`${ROUTE}/source/`)) {
            const skinId = decodeURIComponent(url.pathname.slice(`${ROUTE}/source/`.length));
            if (!/^[\w.-]+$/u.test(skinId)) {
              respondJson(res, 400, { ok: false, error: 'invalid-skin-id' });
              return;
            }
            const skinDir = join(SKINS_DIR, skinId);
            const metaPath = join(skinDir, 'skin.json');
            if (!existsSync(metaPath)) {
              respondJson(res, 404, { ok: false, error: 'unknown-skin', skinId });
              return;
            }
            // The rendition wins when it exists: it is the same footage at a
            // playback size, and the original is kept untouched as the input of
            // record. The panel reports which one is being served.
            const rendition = join(skinDir, 'assets', RENDITION_NAME);
            if (existsSync(rendition)) {
              streamFile(rendition, req, res);
              return;
            }
            let source;
            try {
              source = JSON.parse(readFileSync(metaPath, 'utf8')).source?.file;
            } catch {
              source = undefined;
            }
            if (typeof source !== 'string') {
              respondJson(res, 500, { ok: false, error: 'skin-has-no-source', skinId });
              return;
            }
            const file = resolveInsideWorkspace(source);
            if (file === undefined) {
              respondJson(res, 403, { ok: false, error: 'outside-workspace' });
              return;
            }
            streamFile(file, req, res);
            return;
          }

          if (url.pathname === `${ROUTE}/report` && req.method === 'POST') {
            const body = await readBody(req);
            if (body === undefined) {
              respondJson(res, 400, { ok: false, error: 'invalid-body' });
              return;
            }
            try {
              writeFileSync(join(REPORTS_DIR, 'skins-client-report.json'), `${JSON.stringify({ receivedAt: new Date().toISOString(), ...body }, null, 2)}\n`, 'utf8');
              respondJson(res, 200, { ok: true, written: 'output/reports/skins-client-report.json' });
            } catch (error) {
              respondJson(res, 500, { ok: false, error: 'write-failed', detail: String(error?.message ?? error) });
            }
            return;
          }

          respondJson(res, 404, { ok: false, error: 'not-found', path: url.pathname });
        },
      }),
      'dsh-skins: catalog, asset, upload and generation routes',
    );
    log.info(`routes mounted at ${ROUTE} (workspace ${WORKSPACE}, revision ${REVISION})`);
  });
}
