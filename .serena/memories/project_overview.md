# Project purpose

- This repository is a monorepo for browser userscripts (Tampermonkey/Greasemonkey).
- Each userscript has:
  - A root-level distributable `.js` file (self-contained IIFE with userscript metadata).
  - A per-script TypeScript/Vite development subdirectory.
- Current script pair:
  - `wanted-marker.js` and `wanted-applied-marker/` for marking already-applied jobs on Wanted.co.kr listings.

# Tech stack

- TypeScript (per-script dev project)
- Vite (build/dev tooling)
- Node package manager: pnpm (`pnpm@10.26.2` at repo root)
- Root distributables are plain JavaScript userscripts using GM\_\* APIs (e.g. GM_getValue/GM_setValue).
