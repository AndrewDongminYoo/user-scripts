# High-level structure

- Root files:
  - `package.json` (workspace scripts: `build`, `typecheck`)
  - `pnpm-workspace.yaml` (workspace packages + dependency overrides)
  - `CLAUDE.md` / `AGENTS.md` (project conventions/architecture notes)
- Per-script package:
  - `wanted-applied-marker/`
    - `src/main.ts` (userscript logic), `src/env.d.ts` (GM\_\* globals)
    - `vite.config.ts` (vite-plugin-monkey: metadata header)
    - `package.json` with script-local dev/build commands
    - `tsconfig.json` (strict TypeScript settings)
- CI:
  - `.github/workflows/check.yml` (typecheck + trunk), `release.yml` (build + GitHub Release asset)
- Tooling config:
  - `.trunk/trunk.yaml` and lint/format config files under `.trunk/configs`
- Planning docs:
  - `docs/plans/*.md`

# Architecture notes

- Userscript build pattern:
  - `vite-plugin-monkey` prepends the Tampermonkey metadata header at build time.
  - Import-free TypeScript source in `src/main.ts`; GM globals declared in `src/env.d.ts`.
  - Output is a single `dist/<name>.user.js`.
- `wanted-applied-marker` uses cache+TTL, bounded concurrency, deduplication, mutation-observer rescans, and Wanted API lookups.
