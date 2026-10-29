# Install

Two supported ways to run the plugin, plus a development path. All of them end
with a **restart of dsh**: the host half is loaded at startup, and this profile
has no host-side hot reload.

## Requirements

- DeepSeek Harness **desktop** (Electron) with a profile; built and tested
  against dsh **0.2.1** on Windows.
- No Node.js needed to *use* the plugin. Node 20+ is needed only to build the
  client bundle or run the tests from a checkout.
- ffmpeg is optional: video compression probes for it, reports when it is
  missing, and never fails the rest of the pipeline because of it.

## Option A — install the bundle (recommended)

The bundle is an npm package whose patch layer inserts the plugin by package
name, so nothing in your profile has to be edited by hand.

1. Open **Settings → Plugins** (or the sidebar's Plugins page).
2. Install `@henryabbott-13/dsh-skins-bundle` from the registry, or run
   `plugin_manager` with `install_bundle` and that target.
3. Restart dsh.
4. Open the right sidebar → **Backgrounds**.

The bundle's patch layer looks like this (you do not write it yourself):

```yaml
- insert:
    - id: ui-dsh-skins
      name: '@henryabbott-13/dsh-plugin-skins'
```

## Option B — register the plugin manually

If you prefer to control the profile yourself, or you are testing a local
checkout, add one row to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: ui-dsh-skins
      name: '@henryabbott-13/dsh-plugin-skins'
      config:
        defaultSkin: img_demo-ember_6b1f2c3d
```

`name` may also be an absolute path or a `file://` URL to `lib/index.js` — that
is how the author develops. The loader compares only the `name` string; when you
edit a local copy, bump a `?v=N` query on the file URL or restart, otherwise the
old module instance keeps running.

Then restart dsh and open the panel as in Option A.

## Option C — development checkout

```bash
node packages/plugin/build.mjs          # writes lib/client.js from src/client.body.js
node tools/verify-bundle.mjs            # one registration, id matches package name
node tests/run.mjs                      # 10 offline suites against a sandbox
node tests/toolkit.mjs                  # toolkit contract
node tests/host-config.mjs              # dataDir / default-skin / pipeline contract
```

Point the profile at `packages/plugin/lib/index.js` with a `?v=N` query and
restart. While iterating, only the *browser* half is hot-replaceable (reload the
page); the host half needs a restart.

## Configuration

All keys are optional. Paths are resolved against the running process, not the
checkout.

| Key | Default | Meaning |
| --- | --- | --- |
| `dataDir` (or `workspaceDir`) | `~/.dsh/skins` | Root for the data layout: `output/skins`, `output/reports`, `output/exports`, `output/_trash`, `input_image`, `input_video`, … |
| `defaultSkin` | first skin in the library, else null | Skin applied when the panel has no remembered choice |
| `scanDir` | `<root>/output/_scan` | Advanced: where the generation pipeline scripts and group files live, for installs that run one |
| `ffmpegPath` | auto-detect | Explicit encoder path (also `DSH_FFMPEG` / `FFMPEG_PATH`) |

The same layout as the author's checkout is used under `dataDir`, so a data
directory can be copied between machines as-is.

> The environment variable `DSH_SKINS_DATA` overrides the default root; it exists
> for tests and for sandboxes that cannot edit the profile.

## Adding skins

- **Import a pack**: a `.zip` exported from another install (Export → Import).
- **Build with the toolkit**: `dsh-skins build bundle.json --out <dataDir>/output/skins`
  — see [skin-format.md](skin-format.md).
- **Generate from media**: only when a compatible pipeline is installed
  (`inventory.mjs`, `make_ids.mjs`, `build_all_skins.mjs` in `scanDir`). Without
  one, the job fails immediately with a message naming the missing scripts; the
  rest of the panel keeps working.

No artwork ships with this repository: use media you have the rights to.
