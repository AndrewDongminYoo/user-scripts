# AGENTS.md (wanted-applied-marker)

Subdirectory guide for `wanted-applied-marker/`.

## Purpose

- Intended TypeScript + Vite development workspace for the Wanted userscript.
- Current state: scaffold/template is still present; migration from `wanted-marker.js` is not yet completed.

## Current Layout

```text
wanted-applied-marker/
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── index.html
├── public/
└── src/
    ├── main.ts      # currently Vite template code
    ├── counter.ts
    ├── style.css
    └── typescript.svg
```

## What To Change Here

- For migration work, this is the correct location to add:
  - `vite.config.ts` with userscript plugin config.
  - TS userscript logic in `src/main.ts`.
- Keep docs in `docs/plans/` aligned with actual progress after each milestone.

## Commands

Run inside this directory:

```bash
pnpm install
pnpm dev
pnpm build
pnpm preview
```

## Constraints

- Keep TypeScript strict mode intact unless there is a documented reason.
- Treat `docs/plans/2026-02-24-wanted-applied-marker-dev-env*.md` as planning references, not proof of completion.
- Until migration lands, runtime source-of-truth remains root `wanted-marker.js`.
