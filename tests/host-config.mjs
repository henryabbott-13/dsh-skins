/**
 * Host-config contract: a published install has no checkout.
 *
 * This drives the real host module with `dataDir` pointing at a temporary root
 * and asserts the three things a public install depends on:
 *
 *   1. the catalog is read from that root (not from a checkout beside the module);
 *   2. a configured `defaultSkin` that is not on disk falls back to the first
 *      skin (or null), instead of leaving the panel pointing at nothing;
 *   3. asking for generation without a pipeline fails with a message that names
 *      the missing pieces, rather than a spawn error.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

const root = mkdtempSync(join(tmpdir(), 'dsh-skins-host-'));
const skinId = 'img_probe_0000abcd';
const skinDir = join(root, 'output', 'skins', skinId);
mkdirSync(join(skinDir, 'assets'), { recursive: true });
writeFileSync(join(skinDir, 'skin.json'), JSON.stringify({ skinId, name: 'Probe', type: 'image', assets: { wallpaper: 'assets/wallpaper.png', thumb: 'assets/wallpaper.png', poster: 'assets/wallpaper.png' } }));
writeFileSync(join(skinDir, 'tokens.json'), JSON.stringify({ presentedTokens: { '--dsw-alias-bg-base': { light: '#ffffff', dark: '#000000' } } }));
writeFileSync(join(skinDir, 'theme.css'), `[data-skin="${skinId}"] { color: inherit; }\n`);
writeFileSync(join(skinDir, 'assets', 'wallpaper.png'), Buffer.from('89504e470d0a1a0a', 'hex'));

const module_ = await import(new URL('../packages/plugin/lib/index.js', import.meta.url).href);

let captured = null;
const stub = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  inject: (services, callback) => {
    callback({
      effect: (factory) => factory(),
      webServer: { register: (route) => { captured = route; return () => {}; } },
    });
  },
};
module_.apply(stub, { dataDir: root, defaultSkin: 'img_missing_00000000' });
check(captured !== null, 'the host registers its prefix route');

function makeRes() {
  const record = { status: 0, headers: {}, chunks: [] };
  return {
    record,
    writeHead(status, headers) { record.status = status; Object.assign(record.headers, headers ?? {}); },
    write(chunk) { if (chunk !== undefined) record.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
    end(chunk) { if (chunk !== undefined) record.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); },
    on() { return this; }, once() { return this; }, removeListener() { return this; }, emit() {}, destroy() {},
  };
}

async function drive(path, { method = 'GET', body = undefined } = {}) {
  const res = makeRes();
  const listeners = {};
  const req = {
    method,
    url: path,
    headers: {},
    on(event, handler) { listeners[event] = handler; return this; },
    destroy() {},
  };
  const done = captured.handler(req, res);
  if (method === 'POST' && body !== undefined) {
    if (typeof listeners.data === 'function') listeners.data(Buffer.from(JSON.stringify(body)));
    if (typeof listeners.end === 'function') listeners.end();
  }
  await done;
  await new Promise((settle) => setTimeout(settle, 300));
  return res.record;
}

const catalog = JSON.parse(Buffer.concat((await drive(`${module_.ROUTE}/catalog`)).chunks).toString('utf8'));
check(catalog.ok === true && catalog.counts?.total === 1, 'the catalog comes from dataDir', JSON.stringify(catalog.counts));
check(catalog.defaultSkin === skinId, 'a missing default falls back to the first skin', String(catalog.defaultSkin));

const started = JSON.parse(Buffer.concat((await drive(`${module_.ROUTE}/generate`, { method: 'POST', body: { records: {} } })).chunks).toString('utf8'));
check(started.ok === true, 'the generation request is accepted');
let job = null;
for (let attempt = 0; attempt < 20; attempt += 1) {
  await new Promise((settle) => setTimeout(settle, 150));
  job = JSON.parse(Buffer.concat((await drive(`${module_.ROUTE}/job`)).chunks).toString('utf8')).job;
  if (job.running !== true) break;
}
check(job !== null && job.status === 'failed', 'a job without a pipeline fails', job?.status ?? 'running');
check(typeof job?.message === 'string' && job.message.includes('pipeline is not installed'), 'the failure names the missing pipeline', job?.message ?? '');

rmSync(root, { recursive: true, force: true });

const failed = results.filter((row) => !row.ok);
console.log(`\nchecks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  for (const row of failed) console.log(`FAILED ${row.label} ${row.detail}`);
  process.exitCode = 1;
}
