# Compatibility

## Tested versions

| dsh | Status | Notes |
| --- | --- | --- |
| **0.2.1** | ✅ primary target | Developed and verified against `0.2.1-rc.3` (Electron desktop, Windows 11). |
| 0.2.0 | ⚠️ works, unmaintained | The chrome fixes were written against it; its CSS-module class prefix differs (`BynINW_` vs `0.2.1`'s `mP3x-q_`). |
| older | ❌ | The right-sidebar slot contract and `theme.overrideTokens` shape are assumed. |

`package.json` declares `engines.dsh: ^0.2.1`. DSH treats that as **declarative**
advice (its loader does not reject a mismatch), so a broken host build surfaces as
missing UI rather than a refused install — check the panel's diagnostics if that
happens.

## What is a stable contract, and what is not

**Stable (documented extension points).** The plugin only *needs* these:

- `theme.overrideTokens(source, { light, dark })` for the token layer — pairs are
  required, bare strings are rejected by design.
- `ctx.sidebarRightTabs.register(...)` and the `sidebar.right.pane.tab` slot for
  the panel.
- `ctx.shortcuts.register(...)` for the two commands.
- `ctx.webServer.register({ kind: 'prefix', … })` for the asset routes.
- The lazy-CJS client bundle shape (`window.__ModuleLoader__.load({ id, factory })`).

**Best-effort (reverse-engineered, version-sensitive).** These make the artwork
edge-to-edge and make focus mode work, and they can break on a shell rewrite:

- `chrome.css` — clears the shell's column borders and pseudo-element edges, and
  keeps the artwork layer out of the pointer path.
- Focus mode — walks the panel's ancestor chain, hides the shell's columns, and
  clears the Windows titlebar strip.
- `titleBarInPage` / window-button diagnosis — reads `data-windows-titlebar`.

### The class-name rule

Shell class names are CSS-module hashes, so **any selector that targets them must
match the suffix, never a baked-in prefix**:

```css
/* correct — matches BynINW_frame (0.2.0) and mP3x-q_frame (0.2.1) */
[class*="_frame"] { … }
/* wrong — silently stops matching after an upgrade */
.BynINW_frame { … }
```

This is not hypothetical: writing the literal prefix is exactly how the
focus-mode grey strip came back after the 0.2.1 upgrade. Every rule in
`chrome.css` and the focus-mode stylesheet follows the suffix rule.

## Diagnosing a break

The panel reports what it matched instead of asserting it in a comment:

- `skins-client-report.json` → `focusMode.titlebarInPage`, `focusMode.fullscreen`,
  and `focusMode.probe` / `probeSettled` — a grid of `elementFromPoint` chains
  (tag, class, computed background, rect, z-index) along the top edge. A leftover
  band names its painter there.
- `focusPlan.hide` / `focusPlan.lanes` — the elements focus mode hid and promoted.
- `staleHost` — the page is talking to an older host module (restart needed).
- `GET /dsh-skins/version` — host revision, data root and node command.

If a release changes the shell and the artwork edge or focus mode regresses,
capture those fields and open an issue: a probe dump identifies the element in
one round instead of five screenshots.

## Updating the plugin

- Browser half: edit `src/client.body.js`, run `node build.mjs`, reload the page.
- Host half: edit `lib/index.js`, restart dsh.
- For a `file://` registration, bump the `?v=N` query (or restart); the loader
  compares only the `name` string and Node caches ES modules by full URL.

## CI matrix

CI runs on Node 20 with no dsh install: the suites stub the shell, the toolkit
has no native dependency, and the demo skins are generated. That keeps the
*contract* tested; the *integration* (real window, real chrome) is what the
version matrix above records.
