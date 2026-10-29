/**
 * Phase-5 verification: the encoder, skin packs, and cleanup.
 *
 * This machine has **no ffmpeg** (checked: not on PATH, not in the winget/scoop/
 * chocolatey locations, not bundled, and no alternative transcoder). That makes
 * two things testable that otherwise would not be: the *decision* to compress is
 * pure, and the *invocation* can be exercised end-to-end through an injected
 * runner — so the argument shape, the part-file swap, the log wording and the
 * cleanup fallback are all verified without an encoder.
 *
 * The zip container is verified by round-tripping real bytes, including a
 * hand-built deflate entry (what an Explorer-made pack looks like) and a
 * corrupted one (what a truncated download looks like).
 *
 *   node output\_scan\verify_assets.mjs
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

const root = process.cwd();
const HOST = join(root, 'output', 'plugin', 'dsh-skins', 'lib', 'index.js');
const BODY = join(root, 'output', 'plugin', 'dsh-skins', 'src', 'client.body.js');
const hostSource = readFileSync(HOST, 'utf8');
const clientSource = readFileSync(BODY, 'utf8');

const results = [];
const record = (ok, label, detail = '') => {
  results.push({ ok, label, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

/* ── load the host half with the module-only bits stubbed ─────────────────── */
/** Cut from a marker to just before the next banner, on clean comment bounds. */
const sliceHost = (from, to) => {
  const start = hostSource.lastIndexOf('/*', hostSource.indexOf(from));
  const end = hostSource.lastIndexOf('/*', hostSource.indexOf(to));
  if (start === -1 || end === -1 || end <= start) throw new Error(`could not slice ${from} .. ${to}`);
  return hostSource.slice(start, end);
};
const hostSlice = sliceHost('/** Defaults for the asset settings', ' * Routes');
/** The asset code reaches for the plugin revision and the rendition name, which live above the slice. */
const hostPreamble = `
const REVISION = 'test-revision';
const RENDITION_NAME = 'source.mp4';
function resolveInsideWorkspace(candidate) {
  const absolute = join(WORKSPACE, candidate);
  return absolute.startsWith(WORKSPACE + sep) ? absolute : undefined;
}
`;
/** The injected scope: every module-level binding the asset code reads. */
const hostParams = [
  'process',
  'existsSync',
  'readFileSync',
  'writeFileSync',
  'readdirSync',
  'mkdirSync',
  'rmSync',
  'renameSync',
  'statSync',
  'inflateRawSync',
  'join',
  'dirname',
  'basename',
  'sep',
  'WORKSPACE',
];
const hostArgs = (processImpl, existsSyncImpl = existsSync) => [
  processImpl,
  existsSyncImpl,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
  renameSync,
  statSync,
  inflateRawSync,
  join,
  dirname,
  basename,
  sep,
  root,
];
/**
 * Build one isolated instance of the host asset code.
 *
 * `existsSync` is injectable on purpose: the discovery tests must not depend on
 * what happens to be installed on this machine (ffmpeg moved from "absent" to
 * "present at the winget shim" between two runs of this suite).
 */
const makeHost = (processImpl, existsSyncImpl) =>
  new Function(
    ...hostParams,
    `${hostPreamble}${hostSlice}\nreturn { readAssetSettings, ffmpegCandidates, ffmpegCommandName, resolveFfmpeg, compressDecision, buildCompressArgs, buildPosterArgs, compressVideo, extractPoster, crc32, writeZip, readZip, buildPackEntries, importPack, planCleanup, applyCleanup, directorySize, readPreferences, writePreferences, mergePreferences, planExplicitDeletion, preferenceIds, preferenceTags, isSkinId, ASSET_DEFAULTS, TARGET_HEIGHTS, RENDITION_NAME, PREFERENCE_LIMITS };`,
  )(...hostArgs(processImpl, existsSyncImpl));
let api;
try {
  api = makeHost(process);
} catch (error) {
  record(false, 'the host asset code evaluates standalone', String(error.message));
  console.log((error.stack ?? '').split('\n').slice(0, 8).join('\n'));
  process.exit(1);
}

/* ── 1. settings coercion ─────────────────────────────────────────────────── */
const defaults = api.readAssetSettings(undefined);
record(defaults.autoCompress === true && defaults.thresholdMB === 50 && defaults.targetHeight === 1080 && defaults.bitrateMbps === 5, 'the defaults match the brief (50 MB, 1080p, 5 Mbps)', JSON.stringify(defaults));
const coerced = api.readAssetSettings({ thresholdMB: '99999', targetHeight: 999, bitrateMbps: -4, autoCompress: false, includeSource: 'yes' });
record(coerced.thresholdMB === 4096 && coerced.bitrateMbps === 1, 'out-of-range numbers clamp', JSON.stringify(coerced));
record(coerced.targetHeight === 1080, 'an unknown height falls back to 1080p', String(coerced.targetHeight));
record(coerced.autoCompress === false && coerced.includeSource === false, 'a non-boolean switch is not read as on');

/* ── 2. ffmpeg discovery is per platform and override-first ───────────────── */
const withPlatform = (platform, env) => {
  const fakeProcess = { platform, env: Object.assign({}, env) };
  return new Function(
    ...hostParams,
    `${hostPreamble}${hostSlice}\nreturn { ffmpegCandidates, ffmpegCommandName, resolveFfmpeg };`,
  )(...hostArgs(fakeProcess));
};
const winEnv = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: 'C:\\Users\\u', ProgramData: 'C:\\ProgramData' };
const win = withPlatform('win32', winEnv);
const winCandidates = win.ffmpegCandidates({}, winEnv);
record(winCandidates.some((path) => path.includes('WinGet') && path.endsWith('ffmpeg.exe')), 'Windows: the winget shim is probed', winCandidates[0]);
record(winCandidates.some((path) => path.includes('scoop')) && winCandidates.some((path) => path.includes('chocolatey')), 'Windows: scoop and chocolatey are probed');
record(win.ffmpegCommandName() === 'ffmpeg.exe', 'Windows: the PATH lookup uses ffmpeg.exe', win.ffmpegCommandName());
const mac = withPlatform('darwin', { HOME: '/Users/u' });
record(mac.ffmpegCandidates({}, { HOME: '/Users/u' }).includes('/opt/homebrew/bin/ffmpeg'), 'macOS: Homebrew is probed');
record(mac.ffmpegCommandName() === 'ffmpeg', 'macOS: the PATH lookup uses the bare name');
const linux = withPlatform('linux', { HOME: '/home/u' });
record(linux.ffmpegCandidates({}, { HOME: '/home/u' }).includes('/usr/bin/ffmpeg'), 'Linux: /usr/bin is probed');
const overridden = win.ffmpegCandidates({ ffmpegPath: 'D:\\tools\\ffmpeg.exe' }, Object.assign({ DSH_FFMPEG: 'D:\\env\\ffmpeg.exe', FFMPEG_PATH: 'D:\\env2\\ffmpeg.exe' }, winEnv));
record(overridden[0] === 'D:\\tools\\ffmpeg.exe' && overridden[1] === 'D:\\env\\ffmpeg.exe' && overridden[2] === 'D:\\env2\\ffmpeg.exe', 'the configured path and both env vars outrank the guesses', overridden.slice(0, 3).join(' | '));

const probeCalls = [];
/** A host whose filesystem has nothing at any candidate: only the PATH lookup can answer. */
const bareHost = makeHost(process, () => false);
const notFound = await bareHost.resolveFfmpeg({}, async (command, args) => {
  probeCalls.push([command, args.join(' ')]);
  return { code: null, output: '', error: 'spawn ENOENT' };
});
record(notFound.path === null && notFound.tried.length >= 2, 'a machine without an encoder resolves to nothing rather than throwing', `${notFound.tried.length} tried, error ${notFound.error}`);
record(probeCalls.every(([, args]) => args === '-version'), 'the probe only ever asks for -version', JSON.stringify(probeCalls.at(-1)));
const foundOnPath = await bareHost.resolveFfmpeg({}, async () => ({ code: 0, output: 'ffmpeg version 7.1\nbuilt with…' }));
record(foundOnPath.source === 'path' && /ffmpeg(\.exe)?$/u.test(foundOnPath.path), 'with nothing installed, a PATH hit is reported as such', `${foundOnPath.path} (${foundOnPath.source})`);
record(foundOnPath.version === 'ffmpeg version 7.1', 'the first version line is kept', foundOnPath.version);
/** A host with a file at every candidate: the first location wins before any PATH lookup. */
const everywhereHost = makeHost(process, () => true);
const atLocation = await everywhereHost.resolveFfmpeg({}, async () => ({ code: 0, output: 'ffmpeg version 9\n' }));
const firstCandidate = everywhereHost.ffmpegCandidates({}, { LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, ProgramData: process.env.ProgramData })[0];
record(atLocation.source === 'location' && atLocation.path === firstCandidate, 'an installed encoder is found at its location before the PATH lookup', `${atLocation.path} (${atLocation.source})`);
const configured = await everywhereHost.resolveFfmpeg({ ffmpegPath: process.execPath }, async (command) => ({ code: command === process.execPath ? 0 : 1, output: 'configured encoder\n' }));
record(configured.path === process.execPath && configured.source === 'configured', 'an explicitly configured path wins and is labelled', `${configured.source}`);
/** A candidate that exists but refuses to run must not be reported as usable. */
const brokenHost = makeHost(process, () => true);
const broken = await brokenHost.resolveFfmpeg({}, async () => ({ code: 1, output: '' }));
record(broken.path === null, 'a candidate that exists but exits non-zero is not accepted', String(broken.error));
// Environment fact, reported rather than asserted so a clean machine stays green.
const liveCandidate = api.ffmpegCandidates({}, process.env).find((candidate) => existsSync(candidate));
console.log(`INFO this machine: ${liveCandidate === undefined ? 'no ffmpeg at any known location (the winget install line is the fix)' : `ffmpeg present at ${liveCandidate}`}`);

/* ── 3. the decision to compress ──────────────────────────────────────────── */
const settings = Object.assign({}, api.ASSET_DEFAULTS);
const mb = 1024 * 1024;
record(api.compressDecision({ bytes: 200 * mb, settings, renditionExists: false }).compress === true, 'a 200 MB video over a 50 MB threshold is compressed');
record(api.compressDecision({ bytes: 200 * mb, settings, renditionExists: true }).compress === false, 'an existing rendition is never re-encoded unasked');
record(api.compressDecision({ bytes: 10 * mb, settings, renditionExists: false }).compress === false, 'a small video is left alone');
record(api.compressDecision({ bytes: 50 * mb, settings, renditionExists: false }).compress === false, 'exactly at the threshold is *not* compressed (strictly greater)', api.compressDecision({ bytes: 50 * mb, settings, renditionExists: false }).reason);
record(api.compressDecision({ bytes: 200 * mb, settings: Object.assign({}, settings, { autoCompress: false }), renditionExists: false }).compress === false, 'the switch turns it off entirely');
record(api.compressDecision({ bytes: 10 * mb, settings, renditionExists: false }).reason.includes('MB'), 'the reason quotes the sizes, so the log is useful', api.compressDecision({ bytes: 10 * mb, settings, renditionExists: false }).reason);

/* ── 4. the command line ──────────────────────────────────────────────────── */
const scaled = api.buildCompressArgs({ input: 'in.mp4', output: 'out.mp4', height: 1080, bitrateMbps: 5, scale: true });
const unscaled = api.buildCompressArgs({ input: 'in.mp4', output: 'out.mp4', height: 1080, bitrateMbps: 5, scale: false });
record(scaled.includes('-vf') && scaled[scaled.indexOf('-vf') + 1] === 'scale=-2:1080', 'the scale filter fits the target height with an even width', 'scale=-2:1080');
record(!unscaled.includes('-vf'), 'a source that is already small enough is not scaled');
record(scaled.at(-1) === 'out.mp4', 'the output path is the last argument');
record(scaled.includes('-nostdin') && scaled.includes('-hide_banner'), 'the encoder cannot block on stdin inside the app');
record(scaled.includes('-movflags') && scaled.includes('+faststart'), 'faststart is set, so the rendition streams instead of needing a seek to the tail');
record(scaled.includes('-c:v') && scaled.includes('libx264') && scaled.includes('-crf') && scaled.includes('23'), 'H.264 with a quality target');
record(scaled.includes('-maxrate') && scaled.includes('5M') && scaled.includes('-bufsize') && scaled.includes('10M'), 'the bitrate ceiling follows the setting', scaled[scaled.indexOf('-maxrate') + 1]);
record(scaled.includes('-map') && scaled.includes('0:a?'), 'audio is mapped optionally, so a silent video still encodes');
record(scaled.includes('-pix_fmt') && scaled.includes('yuv420p'), 'pixel format is set for compatibility');
// Regression guard for a bug a real run caught: ffmpeg chooses its muxer from the
// output extension, and the encode targets a temporary name.
record(scaled.includes('-f') && scaled[scaled.indexOf('-f') + 1] === 'mp4', 'the container is stated outright, not inferred from the file name');
const risky = scaled.filter((arg) => /[",']/u.test(arg));
record(risky.length === 0, 'no argument carries a quote or comma, so no shell or filter parser can reinterpret it', JSON.stringify(risky));
const poster = api.buildPosterArgs({ input: 'in.mp4', output: 'poster.jpg', atSeconds: 2.5 });
record(poster.includes('-ss') && poster[poster.indexOf('-ss') + 1] === '2.5' && poster.includes('-frames:v'), 'the poster command takes one frame at the requested time');
record(poster.includes('scale=480:-2') && poster.at(-1) === 'poster.jpg', 'the poster is scaled to the pipeline width and written last');

/* ── 5. the transcode, through an injected runner ─────────────────────────── */
const sandbox = join(root, 'output', '_scan', '.asset-probe');
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
const source = join(sandbox, 'big.mp4');
writeFileSync(source, Buffer.alloc(2048, 7));
const rendition = join(sandbox, 'skin', 'assets', api.RENDITION_NAME);

const okRun = async (command, args) => {
  // Stand in for the encoder: write what it would have written, to the path it
  // was told to write, and report success.
  const target = args.at(-1);
  writeFileSync(target, Buffer.alloc(512, 9));
  return { code: 0, output: 'frame=100\n' };
};
const success = await api.compressVideo({ binary: 'ffmpeg', input: source, output: rendition, height: 1080, bitrateMbps: 5, sourceWidth: 3840, sourceHeight: 2160, run: okRun });
record(success.ok === true && success.bytes === 512 && success.scaled === true, 'a 4K source transcodes to the target height', JSON.stringify({ ok: success.ok, bytes: success.bytes, scaled: success.scaled }));
record(existsSync(rendition) && !existsSync(`${rendition}.part`), 'the swap leaves exactly the finished rendition and no part file');
record(success.args.at(-1) === `${rendition.replace(/\.mp4$/u, '.part.mp4')}`, 'the encode targets a part file that keeps the container extension', success.args.at(-1));
record(!success.args.at(-1).endsWith('.mp4.part'), 'and never the bare `.mp4.part` suffix that ffmpeg cannot place (every real transcode failed on it)');
const small = await api.compressVideo({ binary: 'ffmpeg', input: source, output: join(sandbox, 'small.mp4'), height: 1080, bitrateMbps: 5, sourceWidth: 1280, sourceHeight: 720, run: okRun });
record(small.scaled === false, 'a 720p source is not upscaled');
const unknown = await api.compressVideo({ binary: 'ffmpeg', input: source, output: join(sandbox, 'unknown.mp4'), height: 1080, bitrateMbps: 5, run: okRun });
record(unknown.scaled === true, 'with no measured size the scale filter is kept (conservative)');

// A failing re-encode must leave the rendition that was already playing intact.
const failing = async () => ({ code: 1, output: 'Error: encoder exploded\n' });
const before = readFileSync(rendition);
const failure = await api.compressVideo({ binary: 'ffmpeg', input: source, output: rendition, height: 1080, bitrateMbps: 5, sourceWidth: 3840, sourceHeight: 2160, run: failing });
record(failure.ok === false && failure.error === 'encode-failed', 'a failed encode reports failure', failure.error);
record(existsSync(rendition) && readFileSync(rendition).equals(before), 'a failed re-encode leaves the existing rendition byte-identical', String(statSync(rendition).size));
record(!existsSync(`${rendition}.part`), 'and cleans up its part file');
const posterOut = join(sandbox, 'poster.jpg');
const posterResult = await api.extractPoster({ binary: 'ffmpeg', input: rendition, output: posterOut, atSeconds: 1, run: okRun });
record(posterResult.ok === true && existsSync(posterOut), 'the poster extraction writes its frame');
const posterFail = await api.extractPoster({ binary: 'ffmpeg', input: rendition, output: join(sandbox, 'nope.jpg'), atSeconds: 1, run: failing });
record(posterFail.ok === false && !existsSync(join(sandbox, 'nope.jpg')), 'a failed poster extraction leaves nothing behind');

/* ── 6. the zip container ─────────────────────────────────────────────────── */
const payload = [Buffer.from('{"skinId":"img_probe_00000000"}\n', 'utf8'), Buffer.from([0, 1, 2, 250, 251, 252]), Buffer.alloc(4096, 42)];
const zip = api.writeZip([
  { name: 'pack.json', data: payload[0] },
  { name: 'assets/binary.webp', data: payload[1] },
  { name: 'assets/big.bin', data: payload[2] },
]);
record(zip.subarray(0, 4).toString('binary') === 'PK\x03\x04', 'the container starts with a local file header');
record(zip.readUInt32LE(zip.length - 22) === 0x06054b50, 'and ends with an end-of-central-directory record');
const back = api.readZip(zip);
record(back.ok === true && back.entries.length === 3, 'the reader finds every entry', String(back.entries?.length));
record(back.entries.every((entry, index) => entry.data.equals(payload[index])), 'every entry round-trips byte-for-byte');
record(back.entries[1].name === 'assets/binary.webp', 'entry names keep their path separators', back.entries[1].name);
record(api.crc32(Buffer.from('123456789')) === 0xcbf43926, 'the CRC matches the standard check value', api.crc32(Buffer.from('123456789')).toString(16));

// A deflate entry: what a pack re-zipped by Explorer or 7-Zip looks like.
const deflated = deflateRawSync(payload[2]);
const nameBuf = Buffer.from('assets/big.bin', 'utf8');
const local = Buffer.alloc(30);
local.writeUInt32LE(0x04034b50, 0);
local.writeUInt16LE(20, 4);
local.writeUInt16LE(0, 6);
local.writeUInt16LE(8, 8);
local.writeUInt32LE(api.crc32(payload[2]), 14);
local.writeUInt32LE(deflated.length, 18);
local.writeUInt32LE(payload[2].length, 22);
local.writeUInt16LE(nameBuf.length, 26);
const central = Buffer.alloc(46);
central.writeUInt32LE(0x02014b50, 0);
central.writeUInt16LE(20, 4);
central.writeUInt16LE(20, 6);
central.writeUInt16LE(0, 8);
central.writeUInt16LE(8, 10);
central.writeUInt32LE(api.crc32(payload[2]), 16);
central.writeUInt32LE(deflated.length, 20);
central.writeUInt32LE(payload[2].length, 24);
central.writeUInt16LE(nameBuf.length, 28);
central.writeUInt32LE(0, 42);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(1, 8);
eocd.writeUInt16LE(1, 10);
eocd.writeUInt32LE(central.length + nameBuf.length, 12);
eocd.writeUInt32LE(local.length + nameBuf.length + deflated.length, 16);
const deflateZip = Buffer.concat([local, nameBuf, deflated, central, nameBuf, eocd]);
const inflated = api.readZip(deflateZip);
record(inflated.ok === true && inflated.entries[0].data.equals(payload[2]), 'a deflate entry (an externally re-zipped pack) still reads', inflated.error ?? 'ok');
const corrupted = Buffer.from(zip);
corrupted[40] ^= 0xff;
record(api.readZip(corrupted).error === 'crc-mismatch', 'a corrupted entry is refused by CRC, not silently imported', api.readZip(corrupted).error);
record(api.readZip(Buffer.from('not a zip at all')).error === 'not-a-zip', 'a non-zip upload is refused');
record(api.readZip(zip.subarray(0, 40)).error === 'not-a-zip', 'a truncated download is refused');

/* ── 7. packs: export a real skin, import it back ─────────────────────────── */
const skinsDir = join(root, 'output', 'skins');
const realSkin = readdirSync(skinsDir).filter((name) => name.startsWith('img_')).sort()[0];
const built = api.buildPackEntries(join(skinsDir, realSkin), realSkin, { includeSource: false, settings: defaults, automation: null, uiVersion: 'probe' });
record(built.entries[0].name === 'pack.json', 'the manifest is the first entry');
record(built.manifest.format === 'dsh-skin-pack/1' && built.manifest.skinId === realSkin, 'the manifest names the format and the skin', built.manifest.format);
record(built.entries.some((entry) => entry.name === 'tokens.json') && built.entries.some((entry) => entry.name === 'theme.css'), 'the pack carries the token layer and the stylesheet');
record(built.entries.some((entry) => entry.name.startsWith('assets/')), 'and the artwork', built.entries.filter((entry) => entry.name.startsWith('assets/')).map((entry) => entry.name).join(', '));
record(built.manifest.source.included === false, 'the original video is left out by default');

const targetRoot = join(sandbox, 'imported');
mkdirSync(targetRoot, { recursive: true });
const imported = api.importPack(api.writeZip(built.entries), { targetRoot, overwrite: true, sourceDir: join(sandbox, 'inputs') });
record(imported.ok === true && imported.skinId === realSkin, 'a real skin round-trips through the container', JSON.stringify({ ok: imported.ok, skinId: imported.skinId, files: imported.files }));
const originalFiles = readdirSync(join(skinsDir, realSkin, 'assets')).sort();
const importedFiles = readdirSync(join(targetRoot, realSkin, 'assets')).sort();
record(originalFiles.join(',') === importedFiles.join(','), 'the imported skin has the same assets', importedFiles.join(', '));
const identical = originalFiles.every((name) => readFileSync(join(skinsDir, realSkin, 'assets', name)).equals(readFileSync(join(targetRoot, realSkin, 'assets', name))));
record(identical, 'and every asset is byte-identical');
record(readFileSync(join(targetRoot, realSkin, 'tokens.json')).equals(readFileSync(join(skinsDir, realSkin, 'tokens.json'))), 'the token layer is byte-identical too');
const again = api.importPack(api.writeZip(built.entries), { targetRoot, overwrite: true, sourceDir: join(sandbox, 'inputs') });
record(again.ok === true && again.replaced === true, 're-importing over an existing skin replaces it');
const noOverwrite = api.importPack(api.writeZip(built.entries), { targetRoot, overwrite: false, sourceDir: join(sandbox, 'inputs') });
record(noOverwrite.ok === false && noOverwrite.error === 'skin-exists', 'without overwrite an existing skin is protected', noOverwrite.error);

// A pack that tries to escape the skins directory must be refused whole.
const traversal = [
  { name: 'skin.json', data: Buffer.from(JSON.stringify({ skinId: 'img_evil_00000000' }), 'utf8') },
  { name: 'tokens.json', data: Buffer.from('{}', 'utf8') },
  { name: '../../escape.txt', data: Buffer.from('nope', 'utf8') },
];
const escaped = api.importPack(api.writeZip(traversal), { targetRoot, overwrite: true, sourceDir: join(sandbox, 'inputs') });
record(escaped.ok === false && escaped.error === 'unsafe-entry', 'a traversal entry refuses the whole pack', `${escaped.error} ${escaped.name}`);
record(!existsSync(join(targetRoot, 'img_evil_00000000')), 'and nothing of it is written');
const badId = api.importPack(api.writeZip([{ name: 'skin.json', data: Buffer.from('{"skinId":"../../etc"}' , 'utf8') }, { name: 'tokens.json', data: Buffer.from('{}', 'utf8') }]), { targetRoot, overwrite: true, sourceDir: join(sandbox, 'inputs') });
record(badId.ok === false && badId.error === 'invalid-skin-id', 'an invalid skin id is refused', badId.error);
const noTokens = api.importPack(api.writeZip([{ name: 'skin.json', data: Buffer.from('{"skinId":"img_x_00000000"}', 'utf8') }]), { targetRoot, overwrite: true, sourceDir: join(sandbox, 'inputs') });
record(noTokens.ok === false && noTokens.error === 'pack-has-no-tokens-json', 'a pack without the token layer is refused');
const withSource = api.buildPackEntries(join(skinsDir, realSkin), realSkin, { includeSource: true, settings: Object.assign({}, defaults, { includeSource: true }), automation: null, uiVersion: 'probe' });
record(withSource.manifest.source.included === false || withSource.entries.some((entry) => entry.name.startsWith('source/')) , 'asking for the original either includes it or reports that it is gone');

/* ── 8. cleanup ───────────────────────────────────────────────────────────── */
const cleanRoot = join(sandbox, 'skins');
for (const name of ['img_a_11111111', 'img_b_22222222', 'video_c_33333333']) {
  mkdirSync(join(cleanRoot, name, 'assets'), { recursive: true });
  writeFileSync(join(cleanRoot, name, 'skin.json'), '{}');
  writeFileSync(join(cleanRoot, name, 'assets', 'wallpaper.webp'), Buffer.alloc(name === 'img_b_22222222' ? 900 : 100, 1));
}
writeFileSync(join(cleanRoot, 'status.json'), '{}');
const plan = api.planCleanup(cleanRoot, ['img_a_11111111']);
record(plan.remove.length === 2 && plan.kept.length === 1, 'only unreferenced skin folders are planned for removal', JSON.stringify(plan.remove.map((row) => row.skinId)));
record(plan.remove[0].skinId === 'img_b_22222222', 'the plan is ordered by size, biggest first', plan.remove[0].skinId);
record(!plan.remove.some((row) => row.skinId === 'status.json'), 'files that are not skin folders are ignored');
record(plan.totalBytes === 1004, 'the plan reports the space it would free (assets + the 2-byte skin.json each)', String(plan.totalBytes));
record(api.planCleanup(cleanRoot, ['img_a_11111111', 'img_b_22222222', 'video_c_33333333']).remove.length === 0, 'keeping everything plans nothing');
record(api.planCleanup(join(sandbox, 'missing-dir'), []).remove.length === 0, 'a missing skins directory plans nothing instead of throwing');

const trashRoot = join(sandbox, 'trash');
const recycled = [];
const fakeRecycle = async (command, args) => {
  recycled.push(command);
  // Stand in for the Recycle Bin: the folder really goes away. The script is the
  // last argument (`powershell -NoProfile -NonInteractive -Command <script>`).
  const script = args.find((arg) => arg.includes('DeleteDirectory')) ?? '';
  const match = /DeleteDirectory\('([^']+)'/u.exec(script);
  if (match === null) throw new Error(`no path in the recycle script: ${script.slice(0, 120)}`);
  rmSync(match[1], { recursive: true, force: true });
  return { code: 0, output: '' };
};
const applied = await api.applyCleanup(plan, { skinsDir: cleanRoot, trashDir: trashRoot, run: fakeRecycle, when: 'run-1' });
record(applied.moved.length === 2 && applied.moved.every((row) => row.how === 'recycle-bin'), 'on Windows the folders are sent to the Recycle Bin', recycled[0] ?? '');
record(recycled.every((command) => command === 'powershell.exe'), 'through one powershell invocation per folder', String(recycled.length));
record(existsSync(join(cleanRoot, 'img_a_11111111')) && !existsSync(join(cleanRoot, 'img_b_22222222')), 'the kept folder stays and the others are gone');
record(applied.lines.length === 2 && applied.lines.every((line) => line.includes('回收站')), 'the log says where each folder went', applied.lines[0]);

// A recycle that is refused must quarantine instead of deleting.
mkdirSync(join(cleanRoot, 'img_d_44444444'), { recursive: true });
writeFileSync(join(cleanRoot, 'img_d_44444444', 'skin.json'), '{}');
const plan2 = { remove: [{ skinId: 'img_d_44444444', bytes: 2 }], kept: [], totalBytes: 2 };
const refused = await api.applyCleanup(plan2, { skinsDir: cleanRoot, trashDir: trashRoot, run: async () => ({ code: 1, output: 'Access denied\n' }), when: 'run-2' });
record(refused.moved[0].how === 'quarantine', 'a refused Recycle Bin falls back to the quarantine directory', refused.moved[0].how);
record(existsSync(join(trashRoot, 'run-2', 'img_d_44444444', 'skin.json')), 'and the folder is really there, recoverable');
record(refused.lines.some((line) => line.includes('回收站不可用')), 'the log records why it fell back', refused.lines.join(' | ').slice(0, 120));
// A folder that vanished after the plan was made is reported, not "deleted".
const stale = await api.applyCleanup({ remove: [{ skinId: 'img_gone_55555555', bytes: 10 }], kept: [], totalBytes: 10 }, { skinsDir: cleanRoot, trashDir: trashRoot, run: async () => ({ code: 1, output: '' }), when: 'run-3' });
record(stale.moved[0].how === 'missing' && stale.lines[0].includes('已不在'), 'a folder that is already gone is reported as missing, not as deleted', stale.lines[0]);

/* ── 8b. preferences on disk, and explicit deletion ───────────────────────── */

{
  const dir = join(sandbox, 'prefs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'skins-preferences.json');
  record(api.isSkinId('img_a_1') === true && api.isSkinId('../x') === false && api.isSkinId('nope') === false, 'only well-formed skin ids are accepted');
  const ids = api.preferenceIds(['img_a_1', 'img_a_1', 'bad', 'video_b_2', 7, null]);
  record(ids.join(',') === 'img_a_1,video_b_2', 'ids are filtered, deduplicated and kept in order', ids.join(','));
  const tags = api.preferenceTags({ img_a_1: ['  夜景 ', '夜景', '', 'x'.repeat(80)], '../bad': ['y'], video_b_2: 'not-a-list' });
  record(Object.keys(tags).join(',') === 'img_a_1', 'tags are keyed by valid skin ids only', Object.keys(tags).join(','));
  record(tags.img_a_1.length === 2 && tags.img_a_1[0] === '夜景' && tags.img_a_1[1].length === api.PREFERENCE_LIMITS.tagLength, 'tag names are trimmed, deduplicated and length-bounded', JSON.stringify(tags.img_a_1.map((one) => one.length)));

  const empty = api.readPreferences(file);
  record(empty.order.length === 0 && empty.favorites.length === 0 && Object.keys(empty.tags).length === 0, 'a missing file reads as empty defaults');
  api.writePreferences(file, api.mergePreferences(null, { order: ['img_a_1', 'video_b_2'], favorites: ['img_a_1'], tags: { img_a_1: ['夜景'] } }));
  record(existsSync(file) && !existsSync(`${file}.tmp`), 'writing goes through a temporary file and leaves no debris', String(existsSync(`${file}.tmp`)));
  const roundTrip = api.readPreferences(file);
  record(roundTrip.order.join(',') === 'img_a_1,video_b_2' && roundTrip.tags.img_a_1.join(',') === '夜景', 'what was written reads back', JSON.stringify(roundTrip.order));
  record(typeof roundTrip.updatedAt === 'string' && roundTrip.version === 1, 'the file carries a version and a timestamp', roundTrip.updatedAt);

  // The merge is field by field: a partial save must not erase the other fields.
  const partial = api.mergePreferences(roundTrip, { order: ['video_b_2'] });
  record(partial.order.join(',') === 'video_b_2', 'a patch replaces the field it names', partial.order.join(','));
  record(partial.favorites.join(',') === 'img_a_1' && partial.tags.img_a_1.join(',') === '夜景', 'and leaves the fields it does not name untouched', `${partial.favorites.join(',')} / ${Object.keys(partial.tags).join(',')}`);
  const cleared = api.mergePreferences(roundTrip, { tags: {} });
  record(Object.keys(cleared.tags).length === 0 && cleared.order.length === 2, 'an explicit empty tags object clears them without touching the order');
  writeFileSync(file, '{ this is not json', 'utf8');
  const broken = api.readPreferences(file);
  record(broken.order.length === 0 && typeof broken.note === 'string', 'a corrupt file degrades to defaults and says so', String(broken.note).slice(0, 40));

  // Explicit deletion: exactly the named skins, keep set ignored.
  const cleanRoot2 = join(sandbox, 'skins-explicit');
  for (const name of ['img_a_11111111', 'img_b_22222222', 'img_c_33333333']) {
    mkdirSync(join(cleanRoot2, name, 'assets'), { recursive: true });
    writeFileSync(join(cleanRoot2, name, 'skin.json'), '{}');
    writeFileSync(join(cleanRoot2, name, 'assets', 'wallpaper.webp'), Buffer.alloc(500, 3));
  }
  const explicitPlan = api.planExplicitDeletion(cleanRoot2, ['img_b_22222222', 'img_missing_00000000', 'not-an-id']);
  record(explicitPlan.remove.length === 1 && explicitPlan.remove[0].skinId === 'img_b_22222222', 'the explicit plan contains exactly the named skin that exists', JSON.stringify(explicitPlan.remove.map((row) => row.skinId)));
  record(explicitPlan.missing.join(',') === 'img_missing_00000000', 'and reports the requested ids that are not on disk', explicitPlan.missing.join(','));
  record(explicitPlan.totalBytes === 502, 'with the size it will free', String(explicitPlan.totalBytes));
  const keptPlan = api.planCleanup(cleanRoot2, ['img_a_11111111', 'img_b_22222222', 'img_c_33333333']);
  record(keptPlan.remove.length === 0 && explicitPlan.remove.length === 1, 'the keep-set path and the explicit path are genuinely different', `${keptPlan.remove.length} vs ${explicitPlan.remove.length}`);
}

/* ── 9. the client side: which skins are referenced ───────────────────────── */
const clientSlice = clientSource.slice(clientSource.indexOf('/** Route prefix owned by the host half.'), clientSource.lastIndexOf('/*', clientSource.indexOf(' * A tiny subscribable view model')));
const clientApi = new Function(
  'window',
  'react',
  `${clientSlice}\nfunction publish(){}\nreturn { referencedSkins, isTuned, readAssetSettings, ASSET_DEFAULTS, DEFAULT_TWEAKS };`,
)({ localStorage: { getItem: () => null, setItem: () => {} }, matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) }, { createElement: () => null });
const referState = {
  skinId: 's-current',
  favorites: ['s-fav', 's-current'],
  // `s-defaults` holds a record whose values are all the defaults: moving a slider
  // writes an entry even when it lands back on the default, so this must NOT
  // protect the skin or the cleanup could never free anything.
  tweaks: { 's-tuned': { blur: 6 }, 's-fav': {}, 's-defaults': Object.assign({}, clientApi.DEFAULT_TWEAKS) },
  automation: {
    system: { enabled: true, dark: 's-sys-dark', light: null },
    time: { enabled: true, start: '08:00', end: '18:00', day: 's-day', night: null },
    project: { enabled: true, bindings: { 'e:/x/p7': 's-project', 'e:/x/p8': null } },
    rotation: { enabled: true, minutes: 30, favoritesOnly: false },
  },
  catalog: { defaultSkin: 's-default', skins: [] },
};
const referenced = clientApi.referencedSkins(referState).sort();
record(
  referenced.join(',') === ['s-current', 's-day', 's-default', 's-fav', 's-project', 's-sys-dark', 's-tuned'].sort().join(','),
  'the keep set covers current, tuned, favourites, every binding and the configured default',
  referenced.join(', '),
);
record(clientApi.isTuned({ blur: 6 }) === true && clientApi.isTuned({}) === false, 'a knob record counts only while it differs from the defaults');
record(clientApi.isTuned(Object.assign({}, clientApi.DEFAULT_TWEAKS)) === false, 'an all-default record is not a reference', String(clientApi.isTuned(Object.assign({}, clientApi.DEFAULT_TWEAKS))));
record(!referenced.includes('s-defaults'), 'and the skin it belongs to stays cleanable');
record(!referenced.includes('s-rotation-only'), 'rotation alone does not make a skin referenced (the catalog is re-read from disk, so it cannot be picked)');
record(clientApi.referencedSkins({ skinId: null, favorites: [], tweaks: {}, automation: null, catalog: {} }).length === 0, 'an empty state references nothing');
record(clientApi.readAssetSettings().thresholdMB === 50, 'the client defaults match the host defaults', String(clientApi.readAssetSettings().thresholdMB));

/* ── 10. wiring ───────────────────────────────────────────────────────────── */
const sourceRoute = hostSource.slice(hostSource.indexOf("if (url.pathname.startsWith(`${ROUTE}/source/`))"), hostSource.indexOf('if (url.pathname === `${ROUTE}/report`'));
record(sourceRoute.includes('existsSync(rendition)') && sourceRoute.indexOf('streamFile(rendition') < sourceRoute.indexOf('resolveInsideWorkspace(source)'), 'the source route serves the rendition before the original', '');
record(hostSource.includes('rendition: hasRendition ?'), 'the catalog tells the panel whether a rendition exists');
record(/id: 'compress'[\s\S]{0,80}title: '大视频自动压缩'/u.test(hostSource), 'the pipeline job has a compress step');
record(hostSource.includes('winget install --id Gyan.FFmpeg -e'), 'the not-found path prints an install command instead of failing silently');
record(hostSource.indexOf('await step(\'build\'') < hostSource.indexOf("id: 'compress'") && hostSource.indexOf("id: 'compress'") < hostSource.indexOf("await step('index'"), 'compression runs after the build and before the index');
record(clientSource.includes('dsh-skins-card__pack') && clientSource.includes('onExport'), 'every card carries an export affordance');
record(clientSource.includes('CLEANUP_URL') && clientSource.includes('dryRun') && clientSource.includes('确认移入回收站'), 'cleanup is planned first and only then confirmed');
record(clientSource.includes('winget install --id Gyan.FFmpeg -e'), 'the panel repeats the install command where the user will read it');

/* ── 11. optional live check against the real encoder ─────────────────────── *
 * The rest of this suite runs the transcode through an injected runner, because
 * the agent's own sandbox may refuse a piped `spawn` (EPERM) while the Electron
 * app is unconfined. `--live` closes that gap for a human in a normal terminal:
 *
 *   node output\_scan\verify_assets.mjs --live
 * -------------------------------------------------------------------------- */
if (process.argv.includes('--live')) {
  const { spawn } = await import('node:child_process');
  const liveRun = (command, args, timeoutMs = 120000) =>
    new Promise((settle) => {
      let child;
      try {
        child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        settle({ code: null, output: '', error: String(error?.message ?? error) });
        return;
      }
      let output = '';
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      child.stdout?.on('data', (chunk) => {
        output += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk) => {
        output += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        settle({ code: null, output, error: String(error?.message ?? error) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        settle({ code, output });
      });
    });
  const live = await api.resolveFfmpeg({}, liveRun);
  if (live.path === null) {
    const blocked = /EPERM|EACCES/u.test(String(live.error ?? ''));
    console.log(`INFO --live: no encoder usable from here (${live.error})${blocked ? ' — that is a sandbox refusing a piped spawn, not a missing encoder: run this in a normal terminal' : ''} — the live checks were skipped`);
  } else {
    console.log(`INFO --live: using ${live.path} · ${live.version}`);
    const dir = join(sandbox, 'live');
    mkdirSync(dir, { recursive: true });
    const fixture = join(dir, 'fixture.mp4');
    const made = await liveRun(
      live.path,
      ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-shortest', fixture],
      240000,
    );
    if (made.code !== 0 || !existsSync(fixture)) {
      console.log(`INFO --live: could not build a fixture (${made.error ?? `exit ${made.code}`}).`);
      console.log(`     ${/EPERM|EACCES/u.test(String(made.error ?? '')) ? 'That is the sandbox refusing a piped spawn — run this in a normal terminal.' : String(made.output ?? '').trim().split('\n').slice(-2).join(' ')}`);
    } else {
      const out = join(dir, 'rendition.mp4');
      const result = await api.compressVideo({ binary: live.path, input: fixture, output: out, height: 1080, bitrateMbps: 5, sourceWidth: 3840, sourceHeight: 2160, run: liveRun, timeoutMs: 300000 });
      record(result.ok === true && existsSync(out), '--live: a real 4K clip transcodes into a rendition', JSON.stringify({ ok: result.ok, error: result.error ?? result.detail ?? null }));
      if (result.ok === true) {
        const before = statSync(fixture).size;
        const after = statSync(out).size;
        record(after < before, '--live: the rendition is smaller than the source', `${(before / 1048576).toFixed(2)} MB → ${(after / 1048576).toFixed(2)} MB`);
        record(result.scaled === true, '--live: a 4K source is scaled down to the target height');
        const poster = await api.extractPoster({ binary: live.path, input: out, output: join(dir, 'poster.jpg'), atSeconds: 1, run: liveRun });
        record(poster.ok === true && statSync(join(dir, 'poster.jpg')).size > 1000, '--live: a poster frame is extracted from the rendition', `${poster.ok === true ? statSync(join(dir, 'poster.jpg')).size : 0} bytes`);
      }
    }
  }
}

rmSync(sandbox, { recursive: true, force: true });
const failed = results.filter((row) => !row.ok);
console.log(`\nchecks: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  for (const row of failed) console.log(`FAILED ${row.label} ${row.detail}`);
  process.exitCode = 1;
}
