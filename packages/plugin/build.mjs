/*
 * Wrap `src/client.body.js` into the bundle format dsh-client-modules serves.
 *
 * The bundle is deliberately NOT an ES module. The page's loader already defines
 * `window.__ModuleLoader__`, and a plugin bundle is a registration of a factory:
 * running the script only registers it, and the factory body runs at
 * materialization. `require("react")` and the `PACKAGE_ID` constant are provided
 * by the wrapper, which is the same contract Project_1's ui-shortcuts plugin
 * uses, so this works on a packaged desktop app with no build pipeline.
 *
 *     node build.mjs
 *
 * Re-run after every `src/client.body.js` edit: `lib/client.js` is generated.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/** Must match `name` in package.json: it is the loader id and the body's PACKAGE_ID. */
const ID = '@henryabbott-13/dsh-plugin-skins';

const body = readFileSync(new URL('./src/client.body.js', import.meta.url), 'utf8').replace(/\s+$/, '');
const indented = body
  .split('\n')
  .map((line) => (line.length === 0 ? '' : `\t\t${line}`))
  .join('\n');

const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
\t\tlet react = require("react");
\t\tconst PACKAGE_ID = ${JSON.stringify(ID)};
${indented}

\t\treturn module.exports;
\t}
});
`;

mkdirSync(new URL('./lib/', import.meta.url), { recursive: true });
writeFileSync(new URL('./lib/client.js', import.meta.url), bundle);
console.log(`wrote lib/client.js (${bundle.length} bytes) for ${ID}`);
