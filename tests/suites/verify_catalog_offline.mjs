/**
 * Simulate the host half's catalog build outside dsh.
 *
 * This is a path and shape check, not a substitute for the live route: it runs
 * the same logic against the same directories so a broken path or a malformed
 * skin.json is caught before restarting the app.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The hop count is relative to the *script's* location, so it is overridden
// here rather than computed: this check lives in output/_scan/, while the real
// module lives in output/plugin/dsh-skins/lib/ and uses four hops.
const WORKSPACE = process.env.DSH_SKINS_WORKSPACE
  ?? fileURLToPath(new URL('../../../../', import.meta.url));
const SKINS_DIR = join(WORKSPACE, 'output', 'skins');
const ROUTE = '/dsh-skins';
const PLUGIN_DIR = join(WORKSPACE, 'output', 'plugin', 'dsh-skins');

console.log('workspace   :', WORKSPACE);
console.log('plugin dir  :', PLUGIN_DIR);
console.log('skins dir   :', SKINS_DIR);
console.log('skins exists:', existsSync(SKINS_DIR));

/** The real module resolves its own directory; assert the two agree. */
{
  const realLib = fileURLToPath(new URL('../../../../', new URL('file:///' + PLUGIN_DIR.replace(/\\/gu, '/') + '/lib/index.js')));
  console.log('module 4-hop:', realLib);
  if (resolve(realLib) !== resolve(WORKSPACE)) {
    console.error('FAILED: the module\'s hop count does not land on this workspace');
    process.exit(1);
  }
}

const resolveInsideWorkspace = (candidate) => {
  const absolute = resolve(WORKSPACE, candidate);
  return absolute.startsWith(WORKSPACE + sep) ? absolute : undefined;
};

const problems = [];
const skins = [];
for (const name of readdirSync(SKINS_DIR)) {
  if (!name.startsWith('img_') && !name.startsWith('video_')) continue;
  const dir = join(SKINS_DIR, name);
  const metaPath = join(dir, 'skin.json');
  const tokensPath = join(dir, 'tokens.json');
  if (!existsSync(metaPath) || !existsSync(tokensPath)) {
    problems.push(`${name}: missing skin.json or tokens.json`);
    continue;
  }
  let meta;
  let tokens;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    tokens = JSON.parse(readFileSync(tokensPath, 'utf8'));
  } catch (error) {
    problems.push(`${name}: unreadable json (${error.message})`);
    continue;
  }
  if (tokens.presentedTokens === undefined) problems.push(`${name}: tokens.json has no presentedTokens`);
  else {
    for (const [token, pair] of Object.entries(tokens.presentedTokens)) {
      if (typeof pair?.light !== 'string' || typeof pair?.dark !== 'string') {
        problems.push(`${name}: ${token} is not a {light,dark} string pair`);
      }
    }
  }
  const assetExists = (relative) => existsSync(join(dir, relative));
  const anyOf = (candidates) => candidates.some(assetExists);
  const hasWallpaper = anyOf(['assets/wallpaper.webp', 'assets/wallpaper.png', 'assets/wallpaper.jpg', 'assets/wallpaper.jpeg', 'assets/wallpaper.avif']);
  if (meta.type === 'image' && !hasWallpaper) problems.push(`${name}: no wallpaper (webp/png/jpg/avif)`);
  if (meta.type === 'video') {
    if (!anyOf(['assets/poster.webp', 'assets/poster.png', 'assets/poster.jpg', 'assets/poster.jpeg'])) problems.push(`${name}: no poster (webp/png/jpg)`);
    const source = resolveInsideWorkspace(meta.source?.file ?? '');
    if (source === undefined || !existsSync(source)) problems.push(`${name}: video source does not resolve`);
  }
  const thumb = meta.type === 'image' ? anyOf(['assets/thumb.webp', 'assets/thumb.png', 'assets/thumb.jpg', 'assets/thumb.jpeg']) || hasWallpaper : true;
  if (!thumb) problems.push(`${name}: no thumbnail`);
  skins.push({
    skinId: name,
    name: meta.name,
    type: meta.type,
    scheme: tokens.contrast?.ratios?.['light: ink on base'] !== undefined ? 'both' : '?',
    tokenCount: Object.keys(tokens.presentedTokens ?? {}).length,
    bytes: statSync(metaPath).size,
  });
}

console.log(`\nskins: ${skins.length} (image ${skins.filter((s) => s.type === 'image').length}, video ${skins.filter((s) => s.type === 'video').length})`);
for (const skin of skins.slice(0, 6)) {
  console.log(`  ${skin.skinId}  ${skin.type}  tokens=${skin.tokenCount}`);
}
console.log(`  … ${Math.max(0, skins.length - 6)} more`);

// Exercise the route shapes the browser half calls, against whatever the fixture
// provides. The public repository ships no artwork, so the ids are discovered
// from the generated fixture instead of hard-coded from a private library.
const imageId = skins.find((skin) => skin.type === 'image')?.skinId;
const videoId = skins.find((skin) => skin.type === 'video')?.skinId;
const probes = [
  { path: `${ROUTE}/catalog`, kind: 'json' },
  { path: `${ROUTE}/chrome.css`, kind: 'file' },
];
if (imageId !== undefined) {
  probes.push({ path: `${ROUTE}/doc/${imageId}/theme.css`, kind: 'file' });
  probes.push({ path: `${ROUTE}/asset/${imageId}/wallpaper.webp`, kind: 'file' });
}
if (videoId !== undefined) {
  probes.push({ path: `${ROUTE}/asset/${videoId}/poster.webp`, kind: 'file' });
  probes.push({ path: `${ROUTE}/source/${videoId}`, kind: 'source' });
}
console.log('\nroute resolution:');
for (const probe of probes) {
  let file;
  if (probe.kind === 'json') file = join(WORKSPACE, 'output', 'skins');
  else if (probe.path === `${ROUTE}/chrome.css`) file = resolveInsideWorkspace(join('output', 'plugin', 'dsh-skins', 'chrome.css'));
  else if (probe.path.startsWith(`${ROUTE}/doc/`)) {
    const rest = probe.path.slice(`${ROUTE}/doc/`.length);
    const slash = rest.lastIndexOf('/');
    file = resolveInsideWorkspace(join('output', 'skins', rest.slice(0, slash), rest.slice(slash + 1)));
  } else if (probe.path.startsWith(`${ROUTE}/asset/`)) {
    const rest = probe.path.slice(`${ROUTE}/asset/`.length);
    const slash = rest.lastIndexOf('/');
    file = resolveInsideWorkspace(join('output', 'skins', rest.slice(0, slash), 'assets', rest.slice(slash + 1)));
  } else {
    const id = probe.path.slice(`${ROUTE}/source/`.length);
    const meta = JSON.parse(readFileSync(join(WORKSPACE, 'output', 'skins', id, 'skin.json'), 'utf8'));
    file = resolveInsideWorkspace(meta.source.file);
  }
  const ok = file !== undefined && existsSync(file);
  const size = ok && statSync(file).isFile() ? statSync(file).size : 0;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${probe.path}${ok ? ` -> ${size} bytes` : ' (unresolved)'}`);
  if (!ok) problems.push(`route did not resolve: ${probe.path}`);
}

console.log(`\nproblems: ${problems.length}`);
for (const problem of problems) console.log(`  ! ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
void extname;
