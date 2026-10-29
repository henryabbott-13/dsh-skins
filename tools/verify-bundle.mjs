/**
 * Check that the built client bundle is exactly one valid module registration.
 *
 * DeepSeek Harness serves a client plugin as a lazy-CJS registration, not an ES
 * module: the script calls `window.__ModuleLoader__.load({ id, factory })` and
 * the factory runs later. A missing registration, two registrations, or an id
 * that does not match the package name all fail silently in a running app, so
 * they are asserted here where CI can see them.
 */
import { readFileSync } from 'node:fs';

const pluginRoot = new URL('../packages/plugin/', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', pluginRoot), 'utf8'));
const code = readFileSync(new URL('lib/client.js', pluginRoot), 'utf8');

const registrations = [];
const loader = {
  load(definition) {
    registrations.push(definition);
  },
};

// The factory is not executed here: `require("react")` is provided by the host
// at materialization time, and executing it would test the stub instead.
new Function('window', code)({ __ModuleLoader__: loader });

const problems = [];
if (registrations.length !== 1) problems.push(`expected exactly 1 registration, got ${registrations.length}`);

const definition = registrations[0];
if (definition !== undefined) {
  if (definition.id !== pkg.name) {
    problems.push(`bundle id "${definition.id}" does not match package name "${pkg.name}"`);
  }
  if (typeof definition.factory !== 'function') problems.push('factory is not a function');
}

if (typeof pkg.dsh?.client?.platform !== 'string') problems.push('package.json is missing dsh.client.platform');
if (typeof pkg.exports?.['./client'] !== 'string') problems.push('package.json is missing the ./client export');

console.log(`bundle: ${code.length} bytes, id=${definition?.id ?? '(none)'}`);
for (const problem of problems) console.log(`  ! ${problem}`);
console.log(`problems: ${problems.length}`);
process.exit(problems.length === 0 ? 0 : 1);
