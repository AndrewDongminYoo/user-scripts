# Code and implementation conventions

- Use `pnpm` exclusively.
- Userscript distributables at repo root should:
  - Include Tampermonkey metadata block.
  - Be fully self-contained IIFE JavaScript.
  - Use `GM_getValue`/`GM_setValue` for persistence.
- Script development happens in `<script-name>/src` using TypeScript + Vite.
- TypeScript configuration in current script is strict (`strict: true`) with modern targets (`ES2022`) and bundler module resolution.

# Naming/layout conventions

- Script pairing convention:
  - Root distributable file: `<script-name>.js`
  - Dev environment directory: related subdirectory (e.g. `wanted-applied-marker/`).
- New scripts should follow the documented flow in `CLAUDE.md` (create Vite TS project, develop in `src`, emit root distributable).
