# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This monorepo manages browser userscripts (Tampermonkey/Greasemonkey). Each userscript has two forms:

- **Root-level `.js` file**: Distribution-ready, self-contained IIFE with Tampermonkey metadata headers
- **`<script-name>/` subdirectory**: Vite + TypeScript development environment for that script

Current scripts:

- `wanted-marker.js` / `wanted-applied-marker/` — Marks already-applied jobs on Wanted.co.kr job listings

## Package Manager

Use **pnpm** exclusively (configured at root with `pnpm@10.26.2`).

## Per-Script Development Commands

Run from inside the script's subdirectory (e.g., `wanted-applied-marker/`):

```sh
pnpm dev        # Start Vite dev server
pnpm build      # Type-check (tsc) then bundle with Vite
pnpm preview    # Preview built output
```

## Architecture

### Userscript Structure

Each distributable script at root follows this pattern:

- **Tampermonkey metadata block** (`// ==UserScript==` ... `// ==/UserScript==`) at the top
- **Single IIFE** (`(() => { "use strict"; ... })()`) — no imports, fully self-contained
- **GM\_ API usage**: `GM_getValue`/`GM_setValue` for persistent storage (not localStorage)

### wanted-marker.js Key Design

- **Cache**: Stores apply status per `jobId` with 14-day TTL via `GM_getValue`/`GM_setValue`
- **Concurrency**: Max 3 simultaneous API calls (`CONCURRENCY = 3`), queued via `pump()`
- **Deduplication**: `inflight` Map prevents duplicate in-flight requests for the same `jobId`; `seenAnchors` WeakSet prevents re-processing the same DOM node
- **Infinite scroll**: `MutationObserver` on `document.documentElement` triggers debounced re-scan (300ms)
- **API**: `https://www.wanted.co.kr/api/chaos/jobs/v4/{jobId}/details` — checks `data.application` field for apply status

### Adding a New Script

1. Create a subdirectory (e.g., `my-script/`) with `pnpm create vite` using the vanilla-ts template
2. Develop in `my-script/src/`
3. After building, produce the standalone distributable at `my-script.js` in the root with proper Tampermonkey headers
