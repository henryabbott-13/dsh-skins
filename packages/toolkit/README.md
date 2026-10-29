# @henryabbott-13/dsh-skins-toolkit

Turn a **measured artwork record** into a complete DSH skin, and check skin
directories before they are used.

```js
import { buildSkin, checkSkinDir } from '@henryabbott-13/dsh-skins-toolkit';

const { dir, tokens } = buildSkin({
  record,                       // measured record (see docs/skin-format.md)
  meta: { skinId: 'img_demo_1a2b3c4d', kind: 'image', name: 'Demo' },
  assets: { wallpaper: './still.png' },
  outRoot: './skins',
});
console.log(dir, Object.keys(tokens.presentedTokens).length);
```

```bash
dsh-skins build bundle.json --out skins
dsh-skins check skins
```

## What it does

- `deriveDesign(record, meta)` — picks the anchor polarity, the interface hue,
  the accent (with a WCAG search), the tone ladder, radius/blur/shadow/motion
  budgets.
- `buildTokens(spec, meta)` — emits the `presentedTokens` layer as `{light,dark}`
  pairs plus a contrast audit.
- `themeCss(spec, meta)` — the scoped stylesheet.
- `buildSkin(...)` — writes `skin.json`, `tokens.json`, `theme.css`, `README.md`,
  `preview.html` and `assets/` into `<outRoot>/<skinId>/`.
- `checkSkinDir(dir)` — reports missing files, unscoped CSS and malformed tokens.

## Measurement is not included

This package does not decode images or videos and has **no native dependency**.
Measurement belongs to whoever has a decoder: the panel measures in the browser,
scripts can use sharp/ffmpeg, a service can do it server-side. The record format
is documented in `docs/skin-format.md`.

## License

Apache-2.0. Documentation is CC-BY-4.0. Community project, unofficial.
