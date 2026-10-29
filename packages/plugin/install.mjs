/**
 * Register the dsh-skins plugin in a dsh profile.
 *
 * Why a Node script and not a .ps1: this machine forbids running PowerShell
 * script files ("在此系统上禁止运行脚本"), so an install step written as a
 * script file could not be run at all. Node is unaffected.
 *
 * What it does, in order:
 *   1. Locates the profile directory (`--profile`, else `DSH_PROFILE_DIR`, else
 *      `~/.dsh/profiles/desktop`).
 *   2. Reads `cordis.patch.yml` and reports exactly what it will change.
 *   3. Backs the file up to a timestamped sibling before writing anything.
 *   4. Inserts or updates the plugin's `insert` row, preserving every other
 *      line of the file (including comments) verbatim.
 *   5. Verifies the result by re-reading it.
 *
 * `--dry-run` performs every step except the write.
 *
 * It refuses to touch anything outside the profile directory and never edits a
 * dsh-shipped file: `cordis.patch.yml` is the profile's own user patch layer.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const has = (name) => argv.includes(`--${name}`);

const DRY_RUN = has('dry-run');
const REVERT = has('revert');

/** The plugin's own entry, as a file URL (the loader accepts absolute paths too). */
const PLUGIN_ENTRY = pathToFileURL(join(HERE, 'lib', 'index.js')).href;

/** The row id; stable so re-running the installer updates instead of duplicating. */
const ROW_ID = 'ui-dsh-skins';

/** Default skin: an image skin with wide margins on both panels. */
const DEFAULT_SKIN = flag('default-skin', 'img_26-stairs1-psd_135d0ce0');

function profileDirectory() {
  const explicit = flag('profile', null);
  if (explicit !== null) return resolve(explicit);
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR.length > 0) {
    return resolve(process.env.DSH_PROFILE_DIR);
  }
  const name = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.length > 0 ? process.env.DSH_PROFILE : 'desktop';
  return join(homedir(), '.dsh', 'profiles', name);
}

/**
 * Cache-busting revision for the loader row.
 *
 * The Loader compares only the row's `name` string; an unchanged name reuses the
 * previous module instance, and Node caches ESM by full URL. So every edit to
 * either half of the plugin has to change this number or the running app keeps
 * serving the old module. It is a constant here rather than a manual edit
 * because the installer is the only thing that writes the row.
 */
const PLUGIN_REVISION = '3';

/**
 * Render the plugin's patch row.
 *
 * `config.defaultSkin` is read by the host half and forwarded in the catalog, so
 * the default survives a cleared localStorage and is visible in one place.
 */
function renderRow() {
  return [
    `- insert:`,
    `    - id: ${ROW_ID}`,
    `      name: '${PLUGIN_ENTRY}?v=${PLUGIN_REVISION}'`,
    `      config:`,
    `        defaultSkin: ${DEFAULT_SKIN}`,
  ];
}

/**
 * Insert or replace this plugin's row block in the patch document.
 *
 * The file is a top-level YAML sequence. The plugin's own block is recognised by
 * its row id, so an existing install is updated in place and everything else —
 * other rows, comments, blank lines — is preserved byte for byte.
 */
function upsertRow(text) {
  const lines = text.split(/\r?\n/);
  const row = renderRow();
  const idLine = lines.findIndex((line) => line.trim() === `- id: ${ROW_ID}`);
  if (idLine !== -1) {
    // Walk back to the `- insert:` that owns this id, then forward to the end of
    // the block: the next top-level `- ` that is not part of our own row.
    let start = idLine;
    while (start > 0 && !/^- insert:\s*$/u.test(lines[start])) start -= 1;
    let end = idLine + 1;
    while (end < lines.length && !/^- /u.test(lines[end])) end += 1;
    return { text: [...lines.slice(0, start), ...row, ...lines.slice(end)].join('\n'), mode: 'updated', start, end };
  }
  const trimmed = text.replace(/\s+$/u, '');
  const body = trimmed.length === 0 || trimmed === '[]' ? [] : trimmed.split(/\r?\n/);
  const next = [...body, ...row].join('\n');
  return { text: `${next}\n`, mode: 'inserted', start: body.length, end: body.length };
}

const profileDir = profileDirectory();
const patchPath = join(profileDir, 'cordis.patch.yml');

console.log('dsh-skins installer');
console.log('  profile dir :', profileDir);
console.log('  patch file  :', patchPath);
console.log('  plugin entry:', PLUGIN_ENTRY);
console.log('  default skin:', DEFAULT_SKIN);
console.log('  mode        :', DRY_RUN ? 'dry run (no writes)' : 'write');

if (!existsSync(profileDir)) {
  console.error(`\nFAILED: the profile directory does not exist: ${profileDir}`);
  process.exit(1);
}
if (!existsSync(join(HERE, 'lib', 'index.js'))) {
  console.error(`\nFAILED: the plugin host half is missing: ${join(HERE, 'lib', 'index.js')}`);
  process.exit(1);
}
if (!existsSync(join(HERE, 'lib', 'client.js'))) {
  console.error('\nFAILED: the plugin browser half is missing. Run `node build.mjs` first.');
  process.exit(1);
}

const existed = existsSync(patchPath);
const original = existed ? readFileSync(patchPath, 'utf8') : '';
console.log(`\npatch file exists: ${existed}${existed ? ` (${original.length} bytes)` : ''}`);

/**
 * `--revert` removes this plugin's row and nothing else.
 *
 * It is the inverse of the install path and reuses the same block detection, so
 * a revert leaves every other row and comment exactly as it found them.
 */
if (REVERT) {
  const lines = original.split(/\r?\n/);
  const idLine = lines.findIndex((line) => line.trim() === `- id: ${ROW_ID}`);
  if (idLine === -1) {
    console.log(`revert: no row for ${ROW_ID}; nothing to do.`);
    process.exit(0);
  }
  let start = idLine;
  while (start > 0 && !/^- insert:\s*$/u.test(lines[start])) start -= 1;
  let end = idLine + 1;
  while (end < lines.length && !/^- /u.test(lines[end])) end += 1;
  // Also drop a trailing blank line the row may have introduced.
  const next = [...lines.slice(0, start), ...lines.slice(end)];
  while (next.length > 0 && next.at(-1).trim() === '') next.pop();
  if (DRY_RUN) {
    console.log('\ndry run: the following block would be removed:');
    console.log(lines.slice(start, end).map((line) => `  ${line}`).join('\n'));
    process.exit(0);
  }
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const backupPath = `${patchPath}.bak-skins-revert-${stamp}`;
  copyFileSync(patchPath, backupPath);
  writeFileSync(patchPath, `${next.join('\n')}\n`, 'utf8');
  const written = readFileSync(patchPath, 'utf8');
  console.log(`backup written: ${backupPath}`);
  console.log(`verification: ${written.includes(ROW_ID) ? 'FAILED (row still present)' : 'OK (row removed)'}`);
  process.exit(written.includes(ROW_ID) ? 1 : 0);
}

const result = upsertRow(original);
console.log(`planned change: ${result.mode}`);

// Show the exact block being written, and what it replaces when updating.
console.log('\n--- row to write -------------------------------------------------');
console.log(renderRow().map((line) => `  ${line}`).join('\n'));
if (result.mode === 'updated') {
  console.log('\n--- block to replace ---------------------------------------------');
  console.log(original.split(/\r?\n/).slice(result.start, result.end).map((line) => `  ${line}`).join('\n'));
}

if (DRY_RUN) {
  console.log('\ndry run: nothing was written.');
  process.exit(0);
}

// Back up before the first write, and never overwrite an existing backup.
let backupPath = null;
if (existed) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  backupPath = `${patchPath}.bak-skins-${stamp}`;
  copyFileSync(patchPath, backupPath);
  console.log(`\nbackup written: ${backupPath}`);
}
mkdirSync(profileDir, { recursive: true });
writeFileSync(patchPath, result.text, 'utf8');

// Verify by re-reading: the installer's claim is only worth what the file says.
const written = readFileSync(patchPath, 'utf8');
const ok = written.includes(`- id: ${ROW_ID}`) && written.includes(PLUGIN_ENTRY) && written.includes(`defaultSkin: ${DEFAULT_SKIN}`);
const count = (written.match(new RegExp(`- id: ${ROW_ID}`, 'gu')) ?? []).length;
console.log(`verification: ${ok ? 'OK' : 'FAILED'} (row occurrences: ${count})`);
if (!ok || count !== 1) {
  console.error('FAILED: the patch file does not contain exactly one correct row.');
  if (backupPath !== null) console.error(`Restore with: copy "${backupPath}" "${patchPath}"`);
  process.exit(1);
}
console.log(`\ninstalled. patch file is now ${written.length} bytes.`);
console.log('Restart the dsh desktop app for the host half to load.');
