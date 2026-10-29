/**
 * Run every offline suite against a sandbox built from this checkout.
 *
 * The suites were written against the author's workspace layout
 * (`output/plugin/dsh-skins`, `output/skins`, `output/_scan`, `input_image`), so
 * this runner recreates that shape in `tests/.sandbox` from the repository's own
 * packages — no artwork, no dsh install, no network. Each suite keeps its file,
 * is given `process.cwd()` = sandbox, and stops the run when it reports a
 * failure.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const sandbox = join(repoRoot, 'tests', '.sandbox');
// The suites address the plugin by its workspace layout name (`dsh-skins`),
// so the sandbox keeps that name even though the npm package is scoped.
const pluginId = 'dsh-skins';

rmSync(sandbox, { recursive: true, force: true });
mkdirSync(join(sandbox, 'output', 'plugin'), { recursive: true });
cpSync(join(repoRoot, 'packages', 'plugin'), join(sandbox, 'output', 'plugin', pluginId), { recursive: true });
mkdirSync(join(sandbox, 'output', '_scan'), { recursive: true });
cpSync(join(repoRoot, 'tests', 'vendor', 'skin_derive.mjs'), join(sandbox, 'output', '_scan', 'skin_derive.mjs'));
for (const relative of [
  'input_image',
  'input_video',
  'output/plans',
  'output/analysis/frames',
  'output/reports',
  'output/skins',
]) {
  mkdirSync(join(sandbox, relative), { recursive: true });
}

const env = {
  ...process.env,
  DSH_SKINS_WORKSPACE: sandbox,
  SKINS_PLUGIN_DIR: join(sandbox, 'output', 'plugin', pluginId),
};

const run = (script, args = []) => {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: sandbox, env, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\nFAILED: ${script} (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
};

run(join(repoRoot, 'tests', 'fixtures', 'make-fixture-skin.mjs'));

const suites = [
  'verify_panel.mjs',
  'verify_devtools.mjs',
  'verify_library.mjs',
  'verify_visual.mjs',
  'verify_video.mjs',
  'verify_assets.mjs',
  'verify_automation.mjs',
  'verify_auto_record.mjs',
  'verify_catalog_offline.mjs',
  'verify_host_routes.mjs',
];

for (const suite of suites) {
  console.log(`\n══════ ${suite} ══════`);
  run(join(repoRoot, 'tests', 'suites', suite));
}

console.log('\nall suites passed');
