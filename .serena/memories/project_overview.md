# Project purpose

- This repository is a monorepo for browser userscripts (Tampermonkey/Greasemonkey).
- Each userscript is a TypeScript/Vite package built with `vite-plugin-monkey`; the build emits a single `dist/<name>.user.js` with the Tampermonkey metadata header.
- Current script:
  - `wanted-applied-marker/` for marking already-applied jobs on Wanted.co.kr listings.

# Tech stack

- TypeScript (per-package source, strict mode)
- Vite + `vite-plugin-monkey` (build/dev tooling and userscript metadata)
- Node package manager: pnpm (`pnpm@10.26.2` at repo root)
- Userscripts use GM\_\* APIs (e.g. GM_getValue/GM_setValue), declared in `src/env.d.ts`.
