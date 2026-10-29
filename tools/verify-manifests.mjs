/**
 * Check that the published manifests agree with each other.
 *
 * Three package names appear in the bundle patch and in the plugin's own
 * manifest; a rename that misses one of them produces a bundle that installs
 * and then loads nothing. This check keeps them in sync.
 */
import { readFileSync } from 'node:fs';

const read = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
const bundle = read('../packages/bundle/package.json');
const plugin = read('../packages/plugin/package.json');
const patch = readFileSync(new URL('../packages/bundle/cordis.patch.yml', import.meta.url), 'utf8');

const problems = [];
if (bundle.dsh?.manifestVersion !== 1) problems.push('bundle dsh.manifestVersion must be 1');
if (typeof bundle.dsh?.bundle?.patch !== 'string') problems.push('bundle dsh.bundle.patch must be a path');
if (bundle.dependencies?.[plugin.name] === undefined) {
  problems.push(`bundle does not depend on the plugin package "${plugin.name}"`);
}
if (!patch.includes(plugin.name)) problems.push(`cordis.patch.yml does not insert "${plugin.name}"`);
if (plugin.license !== 'Apache-2.0') problems.push('plugin license must be Apache-2.0');
if (bundle.license !== 'Apache-2.0') problems.push('bundle license must be Apache-2.0');

console.log(`plugin: ${plugin.name}@${plugin.version}`);
console.log(`bundle: ${bundle.name}@${bundle.version}`);
for (const problem of problems) console.log(`  ! ${problem}`);
console.log(`problems: ${problems.length}`);
process.exit(problems.length === 0 ? 0 : 1);
