# AGENTS.md

Repository operating guide for coding agents.

## Overview

- Monorepo for browser userscripts (Tampermonkey/Greasemonkey).
- Each userscript is a TypeScript + Vite package built with `vite-plugin-monkey`.
- Current package: `wanted-applied-marker/` (source `src/main.ts`, output `dist/wanted-applied-marker.user.js`).
- The built `.user.js` is published as a GitHub Release asset by CI on qualifying pushes to `main`.
- Detailed design/plan docs live under `docs/plans/`.

## Structure

```text
.
├── wanted-applied-marker/               # TS/Vite userscript package
├── docs/plans/                          # design + implementation planning docs
├── .github/workflows/                   # check.yml (lint/typecheck) + release.yml
├── pnpm-workspace.yaml                  # workspace + dependency overrides
├── CLAUDE.md                            # project guidance snapshot
└── .trunk/                              # lint/format config
```

## Source Of Truth

- Runtime behavior on Wanted site: `wanted-applied-marker/src/main.ts`.
- Userscript metadata header (name, match, grants, version): `wanted-applied-marker/vite.config.ts`.
- Tooling/dependency intent: root `package.json`, `pnpm-workspace.yaml`, and `wanted-applied-marker/package.json`.
- Agent-facing repo guidance: this file + `CLAUDE.md`.

## Where To Edit

- Change userscript behavior: edit `wanted-applied-marker/src/main.ts`.
- Change metadata (match globs, grants, name): edit `wanted-applied-marker/vite.config.ts`.
- Add a new userscript: scaffold a new package and register it in `pnpm-workspace.yaml` and the `matrix.package` list in `.github/workflows/release.yml`.
- Update process or architecture documentation: edit `CLAUDE.md` and relevant files in `docs/plans/`.

## Conventions

- Use `pnpm` only (`pnpm@10.26.2` at root).
- Keep userscript source as import-free TypeScript in `src/main.ts`; `vite-plugin-monkey` prepends the metadata header at build time.
- Prefer `GM_getValue`/`GM_setValue` (legacy synchronous API) for persistence, declared in `src/env.d.ts`.
- Keep docs explicit about implementation status: `planned`, `in-progress`, or `completed`.

## Commands

Run from repo root:

```bash
pnpm install
pnpm build       # build all packages (pnpm -r build)
pnpm typecheck   # tsc --noEmit across packages
trunk check
trunk fmt
```

Run from `wanted-applied-marker/`:

```bash
pnpm dev
pnpm build
pnpm preview
```

## Documentation Alignment Rules

- When code state changes, update:
  - `AGENTS.md` (this file) for repo map/conventions.
  - `CLAUDE.md` for project summary and architecture notes.
  - `docs/plans/*.md` status lines if work moved from planned to implemented.
- Do not mark design/plan docs as completed unless code and verification are done.
- Avoid duplicating full explanations across files; keep root summary here, keep task details in `docs/plans/`.

## Anti-Patterns

- Hand-editing the generated `dist/*.user.js`; edit `src/main.ts` and `vite.config.ts`, then rebuild.
- Adding a new package without registering it in both `pnpm-workspace.yaml` and the release workflow `matrix.package` list.
- Updating one documentation file without syncing status language in the others.
