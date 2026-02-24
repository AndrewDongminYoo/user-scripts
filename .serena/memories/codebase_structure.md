# High-level structure

- Root files:
  - `wanted-marker.js` (distribution userscript)
  - `package.json` (root package manager metadata)
  - `CLAUDE.md` (project conventions/architecture notes)
- Per-script dev workspace:
  - `wanted-applied-marker/`
    - `src/main.ts`, `src/counter.ts`, `src/style.css`
    - `package.json` with script-local dev/build commands
    - `tsconfig.json` (strict TypeScript settings)
- Tooling config:
  - `.trunk/trunk.yaml` and lint/format config files under `.trunk/configs`
- Planning docs:
  - `docs/plans/*.md`

# Architecture notes

- Root distributable pattern:
  - Userscript metadata header at top.
  - Single self-contained IIFE.
  - No runtime imports.
- Example script (`wanted-marker.js`) uses cache+TTL, bounded concurrency, deduplication, mutation-observer rescans, and Wanted API lookups.
