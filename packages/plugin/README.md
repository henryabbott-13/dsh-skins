# @henryabbott-13/dsh-plugin-skins

Wallpaper and theme skins for **DeepSeek Harness** (dsh). This package is the
engine: a host half that serves skin assets over loopback routes, and a browser
half that applies a skin's `--dsw-*` token layer through `ctx.theme` and renders
the right-sidebar panel.

> Community project, unofficial. Not affiliated with or endorsed by DeepSeek.

## What it does

- Reads a skin directory (`<skins-dir>/<skin-id>/`) and publishes a catalog.
- Streams each skin's wallpaper / poster / video with HTTP Range support, so a
  large clip seeks instead of downloading whole.
- Applies `tokens.json` as `theme.overrideTokens(source, { light, dark })` pairs
  and injects the skin's `theme.css`.
- Adds a **Backgrounds** panel to the right sidebar: library grid, apply, tweaks
  (blur / opacity / veil), filters, parallax, video transport, automation rules,
  import / export, cleanup, and a focus mode that hides the shell UI.
- Never edits a dsh file: it is a profile patch row plus files the plugin writes.

## Install

Install the bundle `@henryabbott-13/dsh-skins-bundle` from the Plugins page (or
with `plugin_manager install_bundle`), then restart dsh. The bundle carries a
patch layer that inserts this plugin by package name.

Manual install (development): add a row to your profile's `cordis.patch.yml` and
restart:

```yaml
- insert:
    - id: ui-dsh-skins
      name: '@henryabbott-13/dsh-plugin-skins'
      config:
        skinsDir: '~/.dsh/skins'   # optional; the panel also reads defaults
```

The host half reloads on restart only; the browser half is refetched on page
reload.

## Skins are user content

No artwork ships with this package. Point `config.skinsDir` at skin directories
you have the rights to use, or build skins from your own media with the toolkit.
The skin format is documented in `docs/skin-format.md`.

## Compatibility

Built against dsh **0.2.1** (Electron desktop). Shell class names are hashed per
build, so anything targeting them matches the class *suffix*
(`[class*="_frame"]`) instead of a baked-in prefix. A future shell rename can
still break the focus-mode chrome fixes — the panel reports what it matched — but
the theme/token layer keeps working because it uses the documented
`overrideTokens` contract. Details: `docs/compat.md`.

## Requirements

- dsh desktop (Electron) with the `desktop` profile.
- Node 20+ only when building from source.
- ffmpeg is optional (video compression); invoked as an external program, never
  bundled.

## Build from source

```bash
node build.mjs
node ../../tools/verify-bundle.mjs
```

## License

Apache-2.0. Documentation is CC-BY-4.0. See the repository root `LICENSE`,
`LICENSE-docs` and `NOTICE`.
