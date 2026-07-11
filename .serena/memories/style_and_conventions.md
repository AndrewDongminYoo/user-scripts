# Code and implementation conventions

- Use `pnpm` exclusively.
- Userscripts are built with `vite-plugin-monkey`:
  - The Tampermonkey metadata block is declared in `vite.config.ts` and prepended at build time.
  - Source in `src/main.ts` is import-free TypeScript; GM globals are declared in `src/env.d.ts`.
  - Use `GM_getValue`/`GM_setValue` for persistence.
- Script development happens in `<package-name>/src` using TypeScript + Vite.
- TypeScript configuration is strict (`strict: true`) with modern targets (`ES2022`) and bundler module resolution.

# Naming/layout conventions

- Each userscript is its own workspace package directory (e.g. `wanted-applied-marker/`).
- Build output is `<package-name>/dist/<package-name>.user.js`.
- New scripts should follow the documented flow in `CLAUDE.md` (create Vite TS project, add `vite-plugin-monkey`, develop in `src`, register in `pnpm-workspace.yaml` and the release matrix).
