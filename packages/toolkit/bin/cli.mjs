#!/usr/bin/env node
/**
 * dsh-skins CLI — assemble skins from measurements, then check the result.
 *
 *   dsh-skins build <bundle.json> [--out <skins-dir>]
 *   dsh-skins check <skins-dir>
 *
 * The bundle is the input format for `build`:
 *
 *   {
 *     "skins": [
 *       {
 *         "record": { ...measured record... },
 *         "meta":   { "skinId": "img_demo_1a2b3c4d", "kind": "image", "name": "Demo", ... },
 *         "assets": { "wallpaper": "path/to/still.png", "thumb": "...", "poster": "..." }
 *       }
 *     ]
 *   }
 *
 * Measurement itself is deliberately not part of this CLI: the panel measures in
 * the browser, and any decoder (sharp, ffmpeg, a service) can produce the record.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { buildSkin, checkSkinDir } from '../lib/index.mjs';

const argv = process.argv.slice(2);
const command = argv[0];

function flag(name, fallback) {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
}

function usage() {
  console.log('usage:');
  console.log('  dsh-skins build <bundle.json> [--out <skins-dir>]');
  console.log('  dsh-skins check <skins-dir>');
  process.exit(command === undefined ? 2 : 1);
}

if (command === 'build') {
  const bundlePath = argv[1];
  if (!existsSync(bundlePath)) {
    console.error(`no bundle at ${bundlePath}`);
    usage();
  }
  const out = flag('out', 'skins');
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const entries = Array.isArray(bundle.skins) ? bundle.skins : [];
  if (entries.length === 0) {
    console.error('the bundle carries no "skins" entries');
    process.exit(1);
  }
  for (const entry of entries) {
    try {
      const result = buildSkin({ record: entry.record, meta: entry.meta, assets: entry.assets ?? {}, outRoot: out });
      console.log(`built ${entry.meta?.skinId ?? '?'} -> ${result.dir} (${Object.keys(result.tokens.presentedTokens).length} tokens)`);
    } catch (error) {
      console.error(`failed ${entry.meta?.skinId ?? '?'}: ${error.message}`);
      process.exitCode = 1;
    }
  }
} else if (command === 'check') {
  const root = argv[1];
  if (!existsSync(root)) {
    console.error(`no skins directory at ${root}`);
    usage();
  }
  let checked = 0;
  let problems = 0;
  for (const name of readdirSync(root).sort()) {
    if (!name.startsWith('img_') && !name.startsWith('video_')) continue;
    const result = checkSkinDir(join(root, name));
    checked += 1;
    for (const problem of result.problems) {
      problems += 1;
      console.log(`  ! ${name}: ${problem}`);
    }
  }
  console.log(`skins checked: ${checked}, problems: ${problems}`);
  process.exit(problems === 0 ? 0 : 1);
} else {
  usage();
}
