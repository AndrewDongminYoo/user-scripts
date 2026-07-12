# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This monorepo manages browser userscripts (Tampermonkey/Greasemonkey). Each userscript lives in its own subdirectory with a Vite + TypeScript development environment. The built output (`dist/<name>.user.js`) is published as a GitHub Release asset on every qualifying push to `main`.

Current scripts:

- `wanted-applied-marker/` — Marks already-applied jobs on Wanted.co.kr job listings (TypeScript source, built with `vite-plugin-monkey`)
- `claude-chat-exporter/` — Exports Claude.ai conversations (current one, or all) to Markdown/JSON via the site's same-origin API (TypeScript source, built with `vite-plugin-monkey`)
- `gemini-chat-exporter/` — Exports gemini.google.com conversations to Markdown/JSON: the current one by scraping the rendered DOM, and all of them (Export-All → ZIP) via the site's `batchexecute` API driven by an observe-replay interceptor (TypeScript source, built with `vite-plugin-monkey`)

## Package Manager

Use **pnpm** exclusively (configured at root with `pnpm@10.26.2`).

## Per-Script Development Commands

Run from inside the script's subdirectory (e.g., `wanted-applied-marker/`):

```sh
pnpm dev        # Start Vite dev server → install the printed .user.js URL in Tampermonkey for live reload
pnpm build      # Type-check (tsc) then bundle → dist/<name>.user.js (includes Tampermonkey header)
pnpm preview    # Preview built output
```

Monorepo-wide commands (from root):

```sh
pnpm build       # Build all packages
pnpm typecheck   # Type-check all packages (tsc --noEmit)
pnpm -r test     # Run each package's test harness (currently claude-chat-exporter, gemini-chat-exporter)
```

## Architecture

### Userscript Structure

Each script lives in its own subdirectory with `vite-plugin-monkey`:

- **Source**: `src/main.ts` — TypeScript, no imports, pure logic (Tampermonkey provides GM globals at runtime)
- **GM types**: `src/env.d.ts` — `declare global` block importing `GmGetValueType`/`GmSetValueType` from `vite-plugin-monkey/dist/client`
- **Build output**: `dist/<name>.user.js` — single file with Tampermonkey metadata header prepended by the plugin
- **GM API**: `GM_getValue`/`GM_setValue` for persistent storage (synchronous, legacy API — not the async `GM.*` API)

### wanted-applied-marker Key Design

- **Cache**: Stores apply status per `jobId` with 14-day TTL via `GM_getValue`/`GM_setValue`
- **Concurrency**: Max 3 simultaneous API calls (`CONCURRENCY = 3`), queued via `pump()`
- **Deduplication**: `inflight` Map prevents duplicate in-flight requests for the same `jobId`; `seenAnchors` WeakSet prevents re-processing the same DOM node
- **Infinite scroll**: `MutationObserver` on `document.documentElement` triggers debounced re-scan (300ms)
- **API**: `https://www.wanted.co.kr/api/chaos/jobs/v4/{jobId}/details` — checks `data.application` field for apply status

### claude-chat-exporter Key Design

See `claude-chat-exporter/AGENTS.md` for the full design notes. Highlights:

- **API**: reads conversations from the site's own same-origin endpoints — `GET /api/organizations`, `.../chat_conversations`, and `.../chat_conversations/{id}?tree=True&rendering_mode=messages&render_all_tools=true`.
- **Two renderers**: `renderBlocks` (Markdown — document-order `<details>` blocks, truncated to `MD_BLOCK_CAP` = 2000 chars) and `collectStructured` (JSON — typed arrays, untruncated). They share predicates so Markdown and JSON stay coherent. JSON pairs `tool_use`/`tool_result` by `tool_use_id` with a FIFO document-order fallback.
- **Content captured**: text, extended thinking, tool calls/results (compact), and attachment extracted text; uploaded image `files[]` and text-block `citations` are intentionally not exported.
- **Settings**: a `⚙️` panel persists `{ format, frontmatter, messageTimestamps, includeThinking, includeToolCalls, includeAttachments }` under the `cce_settings` key.
- **Export All**: max `CONCURRENCY` = 4 concurrent fetches; results packed into a dependency-free store-only ZIP.
- **CSP**: `@grant GM_addStyle` (plus `GM_getValue`/`GM_setValue`) forces Tampermonkey's sandboxed world, exempting the script from claude.ai's strict CSP.
- **Tests**: `claude-chat-exporter/test/run.mjs` is a Node harness that runs the built `dist` bundle against a stubbed DOM/GM/fetch sandbox; add assertions there for new behavior.

### gemini-chat-exporter Key Design

See `gemini-chat-exporter/AGENTS.md` for the full design notes. Highlights:

- **DOM scraping via `SEL`**: Gemini exposes no clean conversation API (its internal `batchexecute` RPC is per-build obfuscated), so a centralized `SEL` object (`turn`, `userQuery`, `queryText`, `attachmentChip`, `modelResponse`, `responseMarkdown`, `thinking`, `scroller`, `sidebar`) selects the stable semantic Angular custom elements instead — a selector fix is a one-place edit.
- **HTML→MD converter**: dependency-free (`htmlToMarkdown`/`blockMd`/`inlineMd`/`listMd`/`tableMd`), covering headings, ordered/nested lists, tables, fenced code blocks, links, bold/italic, and blockquotes; both the Markdown and JSON renderers consume the same `Conversation`/`Turn` shape.
- **Virtualization-safe turn loading**: `ensureAllTurnsLoaded` repeatedly scrolls `infinite-scroller.chat-history` to `scrollTop = 0` until the rendered turn count stabilizes, then does a single document-order collect — Gemini's scroller lazy-loads older turns upward but does not evict rendered nodes (live-verified).
- **Trusted Types**: Gemini enforces a Trusted Types CSP, so `element.innerHTML = <string>` throws; the sidebar trigger's icon is built via `document.createElementNS`/`setAttribute`, never `innerHTML`.
- **Settings**: a `⚙️` panel persists `{ format, frontmatter, includeThinking, includeAttachments }` under the `gce_settings` key.
- **Export-All via `batchexecute` observe-replay** (shipped, live-verified 2026-07-12): a `document-start` interceptor patches `unsafeWindow`'s (page-world) XHR/fetch to learn the app's own `batchexecute` request templates, then replays them with only the conversation id + `_reqid` swapped (reusing the captured `at` token — no `WIZ_global_data` reading). List RPC `MaZiqc` pages via a response cursor (`payload[2]` entries: `[0]`=`c_<id>`, `[1]`=title; `payload[1]`=cursor); content RPC `hNvQHb` parses per-turn prompt (`turn[2][0][0]`) + response Markdown (`turn[3][0][0][1][0]`), with `payload[1]` as a truncation flag. Serial paced replays (non-deterministic under bursts) → store-only ZIP. Self-heals across `bl`/`at`/`f.sid` rotation (the whole template is re-learned each session); the two rpcid literals (`MaZiqc`/`hNvQHb`) and payload paths are **pinned constants**, so an rpcid or payload-structure rotation needs a one-line manual refresh (the arming path logs learned rpcids to the console). Design: `docs/plans/2026-07-12-gemini-export-all-batchexecute-blueprint.md`.
- **CSP / grants**: `@grant GM_addStyle`, `GM_getValue`, `GM_setValue`, `unsafeWindow`; `@run-at document-start`. A real `GM_*` grant forces Tampermonkey's sandboxed world (CSP-exempt); `unsafeWindow` lets the interceptor patch the page world; `document-start` makes the interceptor live before Angular's boot `batchexecute` calls (UI mount deferred to `<body>`).
- **Tests**: `gemini-chat-exporter/test/run.mjs` is a Node harness that runs the built `dist` bundle against a stubbed DOM/GM sandbox; add assertions there for new behavior.

## CI/CD Pipeline

| Workflow | File                            | Trigger                          |
| -------- | ------------------------------- | -------------------------------- |
| Check    | `.github/workflows/check.yml`   | Push to any branch, PR to `main` |
| Release  | `.github/workflows/release.yml` | Push to `main`                   |

### Check Workflow

Runs `pnpm typecheck`, `pnpm -r build`, `pnpm -r test` (the per-package Node harnesses), then `trunk-io/trunk-action@v1` (lint/format). All branches must pass before merge.

### Release Workflow

Uses a matrix over packages (`wanted-applied-marker`, `claude-chat-exporter`, `gemini-chat-exporter`). For each package:

1. Detects `feat:|fix:|refactor:|perf:` conventional commits since the last tag that touched `<package>/`
2. Generates a **date-based version** (`YYYY-MM-DD`). Same-day releases use `.N` suffix (e.g., `2026-02-24.1`)
3. Builds with `SCRIPT_VERSION=<version>` — injected into the `// @version` metadata block via `vite.config.ts`
4. Creates a git tag (`<package>-<version>`), a GitHub Release, and uploads `<package>/dist/<package>.user.js`

### Adding a New Script to the Pipeline

1. Create a subdirectory with `pnpm create vite` using the `vanilla-ts` template
2. Install `vite-plugin-monkey`: `pnpm add -D vite-plugin-monkey`
3. Create `vite.config.ts` with the monkey plugin (see `wanted-applied-marker/vite.config.ts` as reference)
4. Create `src/env.d.ts` to expose GM globals (see `wanted-applied-marker/src/env.d.ts` as reference)
5. Add the subdirectory name to `pnpm-workspace.yaml`
6. Add the subdirectory name to the `matrix.package` list in `.github/workflows/release.yml`
