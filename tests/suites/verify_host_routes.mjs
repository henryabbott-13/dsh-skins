/**
 * Load the plugin's real host half and exercise its registered route handler
 * against fake req/res objects.
 *
 * This is the closest thing to the live route that can run without restarting
 * dsh: it imports the actual module file, lets its `apply` register the route
 * into a stub web server, then drives every route shape the browser half uses —
 * including a Range request on a video skin.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

// tests/run.mjs builds a sandbox and points SKINS_PLUGIN_DIR at the plugin copy
// under test; without it, resolve relative to this repository.
const PLUGIN = process.env.SKINS_PLUGIN_DIR !== undefined && process.env.SKINS_PLUGIN_DIR !== ''
  ? join(process.env.SKINS_PLUGIN_DIR, 'lib', 'index.js')
  : fileURLToPath(new URL('../../packages/plugin/lib/index.js', import.meta.url));
const module_ = await import(pathToFileURL(PLUGIN).href);
console.log('exports:', Object.keys(module_).sort().join(','));
console.log('ROUTE  :', module_.ROUTE);

let captured = null;
const effects = [];
const ctx = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  inject: (services, callback) => {
    console.log('inject requested:', JSON.stringify(services));
    callback({
      effect: (factory, label) => {
        effects.push(label);
        const disposer = factory();
        void disposer;
      },
      webServer: {
        register: (route) => {
          captured = route;
          console.log(`registered route: kind=${route.kind} path=${route.path}`);
          return () => {};
        },
      },
    });
  },
};

module_.apply(ctx, { defaultSkin: 'img_26-stairs1-psd_135d0ce0' });
if (captured === null) {
  console.error('FAILED: apply() did not register a route');
  process.exit(1);
}

/**
 * Minimal res stand-in that records status, headers and body, and behaves
 * enough like a writable stream for `Readable.pipe()`.
 */
function makeRes() {
  const record = { status: 0, headers: {}, chunks: [], ended: false };
  const listeners = new Map();
  const emit = (event) => {
    for (const handler of listeners.get(event) ?? []) handler();
  };
  return {
    record,
    writeHead(status, headers) {
      record.status = status;
      Object.assign(record.headers, headers ?? {});
    },
    write(chunk) {
      if (chunk !== undefined) record.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) record.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      record.ended = true;
      emit('finish');
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return this;
    },
    once(event, handler) {
      const wrapper = () => {
        this.removeListener(event, wrapper);
        handler();
      };
      return this.on(event, wrapper);
    },
    removeListener(event, handler) {
      const list = listeners.get(event) ?? [];
      listeners.set(event, list.filter((entry) => entry !== handler));
      return this;
    },
    emit,
    destroy() {
      emit('close');
    },
  };
}

async function drive(path, { method = 'GET', headers = {}, body = undefined } = {}) {
  const res = makeRes();
  const listeners = {};
  const req = {
    method,
    url: path,
    headers,
    on(event, handler) {
      listeners[event] = handler;
      return this;
    },
    destroy() {},
  };
  const done = captured.handler(req, res);
  if (method === 'POST') {
    if (typeof listeners.data === 'function' && body !== undefined) listeners.data(Buffer.from(JSON.stringify(body)));
    if (typeof listeners.end === 'function') listeners.end();
  }
  await done;
  // A streamed file pipes after writeHead; give it a moment to finish.
  await new Promise((settle) => setTimeout(settle, 400));
  return res.record;
}

const catalog = await drive(`${module_.ROUTE}/catalog`);
const parsed = JSON.parse(Buffer.concat(catalog.chunks).toString('utf8'));
console.log(`\ncatalog      : ${catalog.status} ok=${parsed.ok} total=${parsed.counts?.total} image=${parsed.counts?.image} video=${parsed.counts?.video} defaultSkin=${parsed.defaultSkin}`);
if (parsed.skins?.length > 0) {
  const first = parsed.skins[0];
  console.log(`  first skin : ${first.skinId} ${first.type} tokens=${first.presentedTokens ? Object.keys(first.presentedTokens).length : 0}`);
  console.log(`  wallpaper  : ${first.assets.wallpaper}`);
}

// Ids come from the fixture's own catalog: the public repository ships no
// artwork, so naming a specific skin here would only work on the author's disk.
const imageId = parsed.skins?.find((skin) => skin.type === 'image')?.skinId;
const videoId = parsed.skins?.find((skin) => skin.type === 'video')?.skinId;

const checks = [
  ['chrome.css', await drive(`${module_.ROUTE}/chrome.css`)],
];
if (imageId !== undefined) {
  checks.push(
    ['theme.css', await drive(`${module_.ROUTE}/doc/${imageId}/theme.css`)],
    ['wallpaper', await drive(`${module_.ROUTE}/asset/${imageId}/wallpaper.webp`)],
  );
}
if (videoId !== undefined) {
  checks.push(
    ['poster', await drive(`${module_.ROUTE}/asset/${videoId}/poster.webp`)],
    ['video source (range)', await drive(`${module_.ROUTE}/source/${videoId}`, { headers: { range: 'bytes=0-1023' } })],
    ['video source (full head)', await drive(`${module_.ROUTE}/source/${videoId}`, { method: 'HEAD' })],
  );
}
checks.push(
  ['escape attempt', await drive(`${module_.ROUTE}/asset/..%2f..%2fpackage.json/x.webp`)],
  ['unknown path', await drive(`${module_.ROUTE}/nope`)],
  ['report POST', await drive(`${module_.ROUTE}/report`, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin' },
    body: { reason: 'offline-verification', applied: true, skinId: imageId, note: 'written by verify_host_routes.mjs' },
  })],
  ['cross-site refused', await drive(`${module_.ROUTE}/catalog`, { headers: { 'sec-fetch-site': 'cross-site' } })],
);

console.log('\nroute results:');
const problems = [];
for (const [label, record] of checks) {
  const length = record.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const expected = {
    'chrome.css': 200,
    'theme.css': 200,
    wallpaper: 200,
    poster: 200,
    'video source (range)': 206,
    'video source (full head)': 200,
    'escape attempt': 400,
    'unknown path': 404,
    'report POST': 200,
    'cross-site refused': 403,
  }[label];
  const ok = record.status === expected;
  if (!ok) problems.push(`${label}: expected ${expected}, got ${record.status}`);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label.padEnd(24)} status=${record.status} bytes=${length}${record.headers['content-range'] ? ` range=${record.headers['content-range']}` : ''}${record.headers['content-type'] ? ` type=${record.headers['content-type']}` : ''}`);
}

console.log(`\neffects registered: ${effects.length} (${effects.join('; ')})`);
console.log(`problems: ${problems.length}`);
for (const problem of problems) console.log(`  ! ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
void join;
