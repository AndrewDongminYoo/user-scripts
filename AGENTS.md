# AGENTS.md

Repository operating guide for coding agents.

## Overview

- Monorepo for browser userscripts (Tampermonkey/Greasemonkey).
- Primary distribution artifact today: `wanted-marker.js` (root-level, self-contained IIFE).
- Script development workspace exists at `wanted-applied-marker/` (Vite + TypeScript scaffold, migration in progress).
- Detailed design/plan docs live under `docs/plans/`.

## Structure

```text
.
├── wanted-marker.js                     # Current production userscript
├── wanted-applied-marker/               # TS/Vite dev workspace for migration
├── docs/plans/                          # design + implementation planning docs
├── CLAUDE.md                            # project guidance snapshot
└── .trunk/                              # lint/format config
```

## Source Of Truth

- Runtime behavior on Wanted site: `wanted-marker.js`.
- Tooling/dependency intent for migration: `wanted-applied-marker/package.json` and `docs/plans/*`.
- Agent-facing repo guidance: this file + `CLAUDE.md`.

## Where To Edit

- Change userscript behavior now: edit `wanted-marker.js`.
- Build out TypeScript userscript pipeline: edit inside `wanted-applied-marker/` and keep plans updated.
- Update process or architecture documentation: edit `CLAUDE.md` and relevant files in `docs/plans/`.

## Conventions

- Use `pnpm` only (`pnpm@10.26.2` at root).
- Keep distributable userscript as a single self-contained IIFE with a valid metadata header.
- Prefer `GM_getValue`/`GM_setValue` for persistence in userscript runtime.
- Keep docs explicit about implementation status: `planned`, `in-progress`, or `completed`.

## Commands

Run from repo root:

```bash
pnpm install
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

- Treating `wanted-applied-marker/src/main.ts` template as production logic (it is not yet migrated).
- Declaring migration complete when `vite.config.ts` and userscript TS entry are still missing.
- Updating one documentation file without syncing status language in the others.
