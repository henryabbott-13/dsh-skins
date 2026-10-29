/**
 * Assemble a skin directory from a measured record.
 *
 * The on-disk format is the contract between the toolkit and the plugin:
 *
 *   <skins-dir>/<skin-id>/
 *   ├── skin.json        identity, type, source, asset map
 *   ├── tokens.json      presentedTokens ({light,dark} pairs) + contrast audit
 *   ├── theme.css        scoped to [data-skin="<skin-id>"]
 *   ├── README.md
 *   ├── preview.html     self-contained
 *   └── assets/          wallpaper + thumb/poster (any still format)
 *
 * Still images are copied as they are: the plugin serves whatever format the
 * skin ships, so the toolkit needs no image encoder and no native dependency.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import { buildTokens, deriveDesign, themeCss } from './derive.mjs';

/** Files every skin directory may carry. */
export const SKIN_FILE_NAMES = Object.freeze(['skin.json', 'tokens.json', 'theme.css', 'README.md', 'preview.html']);

/**
 * Build one skin directory.
 *
 * @param record - a measured analysis record (see docs/skin-format.md).
 * @param meta   - scan metadata: skinId, kind, source, name, and the artwork facts.
 * @param assets - slot → source file path for stills (wallpaper/thumb/poster).
 * @param outRoot - the skins directory to write into.
 */
export function buildSkin({ record, meta, assets = {}, outRoot }) {
  if (record === null || typeof record !== 'object') throw new Error('buildSkin needs a measured record');
  if (meta === null || typeof meta !== 'object' || typeof meta.skinId !== 'string' || meta.skinId.length === 0) {
    throw new Error('buildSkin needs meta.skinId');
  }
  if (!/^(img|video)_[a-z0-9-]+_[0-9a-f]{8}$/u.test(meta.skinId)) {
    throw new Error(`skin id must look like img_<slug>_<8 hex>, got "${meta.skinId}"`);
  }
  if (typeof outRoot !== 'string' || outRoot.length === 0) throw new Error('buildSkin needs outRoot');

  const spec = deriveDesign(record, meta);
  const tokens = buildTokens(spec, meta);
  const css = themeCss(spec, meta);

  const dir = join(outRoot, meta.skinId);
  mkdirSync(join(dir, 'assets'), { recursive: true });

  const copied = {};
  for (const slot of ['wallpaper', 'thumb', 'poster']) {
    const source = assets[slot];
    if (typeof source !== 'string' || !existsSync(source)) continue;
    const target = `assets/${slot}${extname(source).toLowerCase()}`;
    copyFileSync(source, join(dir, target));
    copied[slot] = target;
  }
  if (copied.wallpaper === undefined) throw new Error(`skin "${meta.skinId}" has no wallpaper asset`);

  const skin = {
    skinId: meta.skinId,
    name: meta.name ?? meta.skinId,
    nameZh: meta.nameZh ?? null,
    type: meta.kind === 'video' ? 'video' : 'image',
    source: {
      file: meta.source ?? null,
      bytes: meta.sourceBytes ?? null,
      width: meta.sourceSize?.width ?? null,
      height: meta.sourceSize?.height ?? null,
      durationSeconds: meta.durationSeconds ?? null,
    },
    assets: {
      wallpaper: copied.wallpaper,
      thumb: copied.thumb ?? copied.wallpaper,
      poster: copied.poster ?? copied.wallpaper,
    },
    design: meta.design ?? null,
    styleKeywords: meta.styleKeywords ?? [],
    mood: meta.mood ?? [],
  };

  writeFileSync(join(dir, 'skin.json'), `${JSON.stringify(skin, null, 2)}\n`);
  writeFileSync(
    join(dir, 'tokens.json'),
    `${JSON.stringify({ presentedTokens: tokens.presentedTokens, contrast: tokens.contrast, colors: tokens.colors ?? null }, null, 2)}\n`,
  );
  writeFileSync(join(dir, 'theme.css'), css);
  writeFileSync(join(dir, 'README.md'), renderReadme(spec, skin));
  writeFileSync(join(dir, 'preview.html'), renderPreview(spec, tokens, skin));

  return { dir, spec, tokens, skin };
}

/** Read a skin directory back and report what is missing or malformed. */
export function checkSkinDir(dir) {
  const problems = [];
  const readJson = (name) => {
    try {
      return JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch (error) {
      problems.push(`${name}: ${error.code === 'ENOENT' ? 'missing' : `unreadable (${error.message})`}`);
      return null;
    }
  };
  const meta = readJson('skin.json');
  const tokens = readJson('tokens.json');
  if (existsSync(join(dir, 'theme.css'))) {
    const css = readFileSync(join(dir, 'theme.css'), 'utf8');
    if (meta !== null && !css.includes(`[data-skin="${meta.skinId}"]`)) problems.push('theme.css is not scoped to the skin id');
  } else {
    problems.push('theme.css: missing');
  }
  if (tokens !== null) {
    const presented = tokens.presentedTokens ?? {};
    const pairs = Object.entries(presented);
    if (pairs.length === 0) problems.push('tokens.json has no presentedTokens');
    for (const [token, pair] of pairs) {
      if (typeof pair?.light !== 'string' || typeof pair?.dark !== 'string') problems.push(`${token} is not a {light,dark} pair`);
    }
  }
  if (meta !== null) {
    const assets = meta.assets ?? {};
    if (typeof assets.wallpaper !== 'string' || !existsSync(join(dir, assets.wallpaper))) problems.push('assets.wallpaper: missing');
    for (const slot of ['thumb', 'poster']) {
      if (typeof assets[slot] === 'string' && !existsSync(join(dir, assets[slot]))) problems.push(`assets.${slot}: missing`);
    }
  }
  return { problems, meta, tokens };
}

function renderReadme(spec, skin) {
  return [
    `# ${skin.name}`,
    '',
    `- skin id: \`${skin.skinId}\``,
    `- type: ${skin.type}`,
    `- anchor: ${spec.anchorScheme}`,
    `- accent (light/dark): ${spec.light.accent} / ${spec.dark.accent}`,
    '',
    'Generated by `@henryabbott-13/dsh-skins-toolkit`. The tokens are computed from the',
    'measured record; no third-party artwork is included in this skin unless you added it.',
    '',
  ].join('\n');
}

function renderPreview(spec, tokens, skin) {
  const accent = spec[spec.anchorScheme === 'light' ? 'light' : 'dark'].accent;
  const base = tokens.presentedTokens['--dsw-alias-bg-base']?.[spec.anchorScheme === 'light' ? 'light' : 'dark'] ?? '#16181d';
  const ink = tokens.presentedTokens['--dsw-alias-label-primary']?.[spec.anchorScheme === 'light' ? 'light' : 'dark'] ?? '#f2f2f5';
  return [
    '<!doctype html>',
    '<meta charset="utf-8">',
    `<title>${skin.name}</title>`,
    `<body style="margin:0;min-height:100vh;font:14px/1.6 system-ui;background:${base};color:${ink}">`,
    '<main style="max-width:720px;margin:0 auto;padding:48px 24px">',
    `<h1 style="margin:0 0 8px">${skin.name}</h1>`,
    `<p style="color:${accent}">${skin.skinId} · ${skin.type} · anchor ${spec.anchorScheme}</p>`,
    `<button style="font:inherit;padding:8px 14px;border-radius:8px;border:1px solid ${accent};background:${accent};color:#fff">Accent</button>`,
    '</main>',
    '</body>',
    '',
  ].join('\n');
}

void readdirSync;
