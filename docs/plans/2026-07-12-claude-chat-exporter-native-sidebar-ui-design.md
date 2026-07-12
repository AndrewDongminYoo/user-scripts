# claude-chat-exporter Native Sidebar UI Design

**Date**: 2026-07-12
**Status**: Approved

## Goal

Redesign the `claude-chat-exporter` injected UI so it blends into claude.ai the way [pionxzh/chatgpt-exporter](https://github.com/pionxzh/chatgpt-exporter) blends into ChatGPT.
Replace the self-branded bottom-right floating overlay (two orange pills + a small dark inline panel) with a native-looking **Export** item mounted into Claude's own sidebar, opening a full **Exporter Settings** modal.
Only the UI layer changes — rendering, API, ZIP, and export flows are untouched.

## Scope

In scope:

- A single native-styled **Export** item inserted into Claude's sidebar, near the bottom account row.
- A full **Exporter Settings modal** (chatgpt-exporter style), mounted to `document.body`, holding the existing settings plus the export action buttons.
- Native theming via Claude's own CSS custom properties, including automatic light/dark adaptation.
- A robust floating-pill **fallback** when the sidebar mount point is absent.
- Preservation of the MutationObserver re-mount contract for SPA navigations.

Out of scope (unchanged from prior phases — reopening any is a new decision):

- HTML / PNG output, filename templates, per-field frontmatter toggles, metadata field mapping.
- Any change to `renderBlocks` / `collectStructured` / `toMarkdown` / `toJSON` / ZIP / fetch logic.
- New settings keys — the persisted `Settings` shape (`cce_settings`) stays identical.

## Verified facts (live against claude.ai, 2026-07-12)

Confirmed by inspecting the running page (data-mode toggled and restored):

- **Mount anchor**: the sidebar body is `div.dframe-sidebar-body` — a stable semantic class, not a hashed Tailwind class.
  Its nav items are `<button>` rows: height `32px` (`--df-row-h`), font `14px`/weight `400` (`--df-row-font`), border-radius `8px`, icon/label gap `8px`, label in `span.df-leading-slot`, color `hsl(var(--text-300))`.
- **Theme scoping**: all color/radius custom properties are declared on the **`<html>`** element via `[data-color-version="v2"][data-theme="claude"][data-mode="light"|"dark"]`.
  Because `<html>` is an ancestor of `<body>`, a body-mounted modal **inherits both light and dark values automatically**; dark mode is toggled purely by `<html>`'s `data-mode` attribute.
- **Brand accent** is `--cds-clay` = `#d97757` (declared on `:root`/`.cds-root`) — identical to the current button color. Emphasized/hover is `--cds-clay-emphasized` = `#c6613f`.
- **Do not use `--df-*` in the modal**: `--df-row-h` / `--df-row-font` resolve to empty at `body` level (scoped to the sidebar frame). The modal uses only `--bg-*`, `--text-*`, `--border-*`, `--radius-*`, `--cds-clay`, `--cds-clay-emphasized`, and literal sizes.

## UI — sidebar Export item

- Insert one full-width item into `.dframe-sidebar-body`, positioned near the account row at the bottom.
- Markup is `document.createElement` only; styling flows through the existing `GM_addStyle` block (keeps the Tampermonkey sandbox / CSP exemption intact — never inject `<style>` into Claude's DOM).
- Styled to match a nav row using Claude variables and literal dimensions (32px row, 14px label, 8px radius, `hsl(var(--text-300))` text, hover `hsl(var(--bg-300))`), with a small inline download SVG icon and the label `Export`.
- Click opens the settings modal.

## UI — Exporter Settings modal

Mounted once to `document.body` (`position: fixed`, top z-index), styled via Claude variables so it auto-themes:

- **Backdrop** dims the page; click on backdrop or `Esc` closes; `×` in the header closes.
- **Header**: title `Exporter Settings`.
- **Format**: a two-option segmented control, `Markdown` | `JSON` (maps to `settings.format`).
- **Options** (native-looking switches, clay accent when on):
  - `Frontmatter` _(md)_, `Message timestamps` _(md)_ — disabled/dimmed while format is `JSON` (they are Markdown-only).
  - `Extended thinking`, `Tool calls`, `Attachments`.
- **Actions**: `⬇ Export this chat` (clay primary) and `⬇ Export all` (secondary).
- **Progress**: Export All progress and result render inline in the modal (`Exporting 12/40…` → `Done (40)` / `Done (38, 2 failed)`).
- Every control persists immediately via `saveSettings` (unchanged behavior). Export All still snapshots settings at click time so a mid-run toggle can't mix formats within one ZIP.

## Robustness

- **Fallback**: if `.dframe-sidebar-body` is not found (collapsed sidebar, narrow viewport, or a Claude redesign), mount a single clay pill `⬇ Export` at the current bottom-right position; it opens the same modal. One trigger, one modal, two mount strategies.
- **Re-mount**: a debounced MutationObserver re-inserts the sidebar item when `.dframe-sidebar-body` exists but our item is gone, guarded to fire only when our node is absent so our own insertion does not thrash the observer. The modal, once mounted to `body`, persists across SPA navigations.
- **Single-instance guards**: stable ids for the sidebar item, the fallback pill, and the modal prevent duplicate mounts (equivalent to the current single-id guard).

## Tradeoff (accepted)

The current always-visible pills give one-click export; the modal flow is two clicks (open Export → click an action button).
This is the intended consequence of the modal choice and is not worked around.

## Verification

- **Node harness** (`test/run.mjs`, stubbed DOM/GM/fetch) is regression-only: it exercises the render/export logic and the fallback code path (`querySelector('.dframe-sidebar-body')` returns null in the stub). It cannot verify native appearance, dark mode, SPA re-mount survival, or sidebar mounting.
- **Live browser is the real check**: load the built `dist` bundle on claude.ai and confirm, by eye — open modal → change format/toggles → `Export this chat` + `Export all` → toggle Claude dark mode → navigate routes and confirm re-mount → collapse/remove the sidebar and confirm the floating fallback.

## Success criteria

1. Export item appears as a native-looking sidebar row near the account area → verify in browser.
2. Modal opens, themes correctly in light and dark, and persists settings → verify in browser + `GM_getValue` after reload.
3. `Export this chat` and `Export all` produce the same output as before → verify downloads + `pnpm --filter claude-chat-exporter test` stays green.
4. Removing the sidebar triggers the floating fallback; both open the same modal → verify in browser.
5. Route navigation re-mounts the item without duplicates or observer thrash → verify in browser.
