# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See also: `AGENTS.md` (root operating guide), `docs/AGENTS.md`, and `wanted-applied-marker/AGENTS.md`.

## Project Overview

This monorepo manages browser userscripts (Tampermonkey/Greasemonkey). Each userscript has two forms:

- **Root-level `.js` file**: Distribution-ready, self-contained IIFE with Tampermonkey metadata headers
- **`<script-name>/` subdirectory**: Vite + TypeScript development environment for that script

Current scripts:

- `wanted-applied-marker/` — Marks already-applied jobs on Wanted.co.kr job listings (TypeScript source, built with `vite-plugin-monkey`)
- `wanted-marker.js` — Legacy standalone IIFE (to be removed once the subdirectory build is verified)

## Package Manager

Use **pnpm** exclusively (configured at root with `pnpm@10.26.2`).

## Per-Script Development Commands

Run from inside the script's subdirectory (e.g., `wanted-applied-marker/`):

```sh
pnpm dev        # Start Vite dev server → install the printed .user.js URL in Tampermonkey for live reload
pnpm build      # Type-check (tsc) then bundle → dist/<name>.user.js (includes Tampermonkey header)
pnpm preview    # Preview built output
```

## Architecture

### Userscript Structure

Each script lives in its own subdirectory with `vite-plugin-monkey`:

- **Source**: `src/main.ts` — TypeScript, no imports, pure logic (Tampermonkey provides GM globals at runtime)
- **GM types**: `src/env.d.ts` — `declare global` block importing `GmGetValueType`/`GmSetValueType` from `vite-plugin-monkey/dist/client`
- **Build output**: `dist/<name>.user.js` — single file with Tampermonkey metadata header prepended by the plugin
- **GM\_ API**: `GM_getValue`/`GM_setValue` for persistent storage (synchronous, legacy API — not the async `GM.*` API)

### wanted-marker.js Key Design

- **Cache**: Stores apply status per `jobId` with 14-day TTL via `GM_getValue`/`GM_setValue`
- **Concurrency**: Max 3 simultaneous API calls (`CONCURRENCY = 3`), queued via `pump()`
- **Deduplication**: `inflight` Map prevents duplicate in-flight requests for the same `jobId`; `seenAnchors` WeakSet prevents re-processing the same DOM node
- **Infinite scroll**: `MutationObserver` on `document.documentElement` triggers debounced re-scan (300ms)
- **API**: `https://www.wanted.co.kr/api/chaos/jobs/v4/{jobId}/details` — checks `data.application` field for apply status

### Adding a New Script

1. Create a subdirectory with `pnpm create vite` using the `vanilla-ts` template
2. Install `vite-plugin-monkey`: `pnpm add -D vite-plugin-monkey`
3. Create `vite.config.ts` with the monkey plugin (see `wanted-applied-marker/vite.config.ts` as reference)
4. Create `src/env.d.ts` to expose GM globals (see `wanted-applied-marker/src/env.d.ts` as reference)
5. `pnpm build` → `dist/<name>.user.js`
