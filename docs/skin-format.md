# Skin format

A skin is a directory the plugin reads. It is not a CSS file and not a theme
package: it is data the runtime applies through `theme.overrideTokens`.

```
<skins-dir>/
└── <skin-id>/
    ├── skin.json        identity, type, source, asset map
    ├── tokens.json      presentedTokens ({light,dark} pairs) + contrast audit
    ├── theme.css        scoped to [data-skin="<skin-id>"]
    ├── preview.html     optional, self-contained
    ├── README.md        optional
    └── assets/
        ├── wallpaper.webp|png|jpg|jpeg|avif   (required)
        ├── thumb.webp|png|jpg|jpeg            (optional → falls back to wallpaper)
        ├── poster.webp|png|jpg|jpeg           (optional → falls back to wallpaper)
        └── source.mp4                         (optional, compressed playback copy)
```

## Skin id

```
img_<slug>_<first 8 hex of SHA-256 of the source file>
video_<slug>_<first 8 hex of the same>
```

`slug` is the source file name lower-cased with non-alphanumerics collapsed to
`-`. The id never changes for the same bytes, which is what lets the panel
remember a choice across rebuilds.

## `skin.json`

```json
{
  "skinId": "img_demo-ember_6b1f2c3d",
  "name": "Demo Ember",
  "nameZh": "示例·余烬",
  "type": "image",
  "source": { "file": "still.png", "bytes": 6817, "width": 640, "height": 360 },
  "assets": {
    "wallpaper": "assets/wallpaper.png",
    "thumb": "assets/wallpaper.png",
    "poster": "assets/wallpaper.png"
  },
  "styleKeywords": ["demo", "generated"],
  "mood": ["calm"]
}
```

- `type` is `image` or `video`.
- `assets` values are **paths relative to the skin directory**. Any still format
  the browser can paint is accepted; `thumb`/`poster` may point at the same file
  as `wallpaper`.
- For a video skin, `source` describes the original media; the plugin streams it
  through its Range-capable route.

## `tokens.json`

The only required shape is `presentedTokens`: a flat object of CSS custom
property names to `{ "light": color, "dark": color }`. Values must be hex
(`#rgb` / `#rrggbb`) or `rgba(...)`; the theme runtime rejects bare strings and
pairs whose two slots disagree in kind.

```json
{
  "presentedTokens": {
    "--dsw-alias-bg-base": { "light": "rgba(24,22,26,0.36)", "dark": "rgba(24,22,26,0.36)" },
    "--dsw-alias-label-primary": { "light": "#f2f2f5", "dark": "#f2f2f5" }
  },
  "contrast": {
    "ratios": { "light: ink on base": 14.1 },
    "wcag": { "light: ink on base": { "ratio": 14.1, "bodyText": true, "largeText": true, "graphics": true } }
  }
}
```

> The shipped skins use the same 30-token set the plugin's live layer uses. A
> skin that covers *that* set produces the same result in both modes; a smaller
> set only overrides what it lists.

## `theme.css`

Scoped to the skin id so two skins never fight:

```css
[data-skin="img_demo-ember_6b1f2c3d"] { --dsw-alias-bg-base: rgba(24,22,26,0.36); }
```

The plugin injects it as a `<style>` element and sets `data-skin` on the root
while that skin is applied.

## Measured record (input to the toolkit)

`@henryabbott-13/dsh-skins-toolkit` turns a *measured record* into the files
above. Measurement is not part of the toolkit: the panel measures in the
browser, and scripts may measure with any decoder.

A record carries the artwork's own numbers and, where available, an analyst's
verdicts. Only `primaryColor`, `accentColor` and `luminance` are load-bearing;
the rest sharpen the result and fall back to defaults:

```json
{
  "firstImpression": "…",
  "primaryColor": "#2a1e22",
  "secondaryColors": ["#c1764a", "#8fb3d9"],
  "accentColor": "#c1764a",
  "neutrals": ["#1a1518", "#6a5550", "#efe4da"],
  "luminance": 0.24,
  "contrast": "medium",
  "saturation": "muted",
  "temperature": "warm",
  "busyness": "calm",
  "material": "…", "lighting": "…", "composition": "…",
  "styleKeywords": ["demo"], "mood": ["calm"],
  "backgroundSuitability": { "dark": { "verdict": "good" }, "light": { "verdict": "workable" } },
  "paletteProposal": { "accent": "#c1764a", "surface": "#1a1518", "scheme": "dark", "companion": "#8fb3d9" }
}
```

`meta` beside it names the identity and the scan facts (`skinId`, `kind`,
`name`, `source`, `sourceBytes`, `sourceSize`, `durationSeconds`, …).

## CLI

```bash
dsh-skins build bundle.json --out <skins-dir>   # bundle.json: { "skins": [ { record, meta, assets } ] }
dsh-skins check <skins-dir>                     # errors: missing files, unscoped CSS, malformed tokens
```

`build` copies the stills you hand it (no encoder, no native dependency), writes
the six files, and refuses ids that do not match the rule above.

## Security expectations

- Asset paths are relative to the skin directory; the plugin refuses anything
  that escapes its data root.
- Importing a pack validates every entry (path traversal, absolute paths, CRCs,
  a 2 GB cap) before writing, and installs into `<id>.importing` before renaming
  into place.
