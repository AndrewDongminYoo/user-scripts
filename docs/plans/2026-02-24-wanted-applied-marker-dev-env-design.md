# wanted-applied-marker Dev Environment Design

**Date**: 2026-02-24
**Status**: Approved (Not implemented yet)

## Current Repository State

- `wanted-marker.js` at repo root remains the runtime source-of-truth.
- `wanted-applied-marker/` still contains Vite template files and has not been fully migrated to userscript TypeScript source.

## Problem

`wanted-applied-marker/` currently contains the default Vite + TypeScript counter template, unrelated to the actual userscript. The distributable `wanted-marker.js` exists at the monorepo root as a standalone IIFE with no dev tooling.

## Goal

Set up `wanted-applied-marker/` as a proper TypeScript development environment for the userscript, so that:

- Source of truth is TypeScript files in `src/`
- `pnpm build` produces `dist/wanted-applied-marker.user.js` (distribution-ready, header included)
- `pnpm dev` connects to Tampermonkey for live development

## Decisions

| Decision                | Choice                | Rationale                                                                                      |
| ----------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| Build plugin            | `vite-plugin-monkey`  | Purpose-built for userscripts; handles metadata headers, GM grants, and dev server integration |
| GM type declarations    | `@types/greasemonkey` | Standard package providing `GM_getValue`/`GM_setValue` types                                   |
| Migration scope         | Type annotations only | No functional changes to existing logic                                                        |
| Root `wanted-marker.js` | Keep for now          | Remove in a follow-up once the build output is verified                                        |

## File Changes

### Add

- `wanted-applied-marker/vite.config.ts` — monkey plugin with userscript metadata
- `wanted-applied-marker/src/main.ts` — TypeScript migration of `wanted-marker.js`

### Remove (template leftovers)

- `wanted-applied-marker/src/counter.ts`
- `wanted-applied-marker/src/style.css`
- `wanted-applied-marker/src/typescript.svg`
- `wanted-applied-marker/public/vite.svg`
- `wanted-applied-marker/index.html`

### Update

- `wanted-applied-marker/package.json` — add `vite-plugin-monkey`, `@types/greasemonkey`
- `wanted-applied-marker/tsconfig.json` — add GM type reference

## Architecture

### vite.config.ts

```ts
import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";

export default defineConfig({
  plugins: [
    monkey({
      entry: "src/main.ts",
      userscript: {
        name: "Wanted Applied Marker (Infinite Scroll)",
        namespace: "http://tampermonkey.net/",
        version: "2026-02-24",
        description:
          "Mark/hide already-applied jobs on Wanted list. Works with infinite scroll.",
        author: "Dongmin, Yu",
        match: ["https://www.wanted.co.kr/wdlist/*"],
        "run-at": "document-idle",
        grant: ["GM_getValue", "GM_setValue"],
      },
    }),
  ],
});
```

### TypeScript Types Added

```ts
interface CacheEntry {
  applied: boolean;
  statusText: string | null;
  updatedAt: number;
}
type Cache = Record<number, CacheEntry>;
```

### Dev Workflow

```bash
pnpm dev   → Vite dev server starts
             → Install dev URL (http://localhost:5173/...) in Tampermonkey
             → Edit src/ → Tampermonkey auto-reloads

pnpm build → dist/wanted-applied-marker.user.js (production build)
```
