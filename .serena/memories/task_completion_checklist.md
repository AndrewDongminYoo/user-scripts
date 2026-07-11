# Before marking work complete

- Run relevant script-level validation in affected subdirectory:
  - `pnpm build` (minimum check for TS+bundle integrity)
- Run repo-level checks/format as needed:
  - `trunk check`
  - `trunk fmt` (if formatting changes are expected)
- If behavior changed in a userscript:
  - Verify the `vite.config.ts` `userscript` metadata block is still valid and rebuild (`pnpm build`).
  - Verify userscript runtime behavior on target page(s).
- Review diff for consistency with userscript architecture constraints (import-free `src/main.ts`, GM\_\* persistence where applicable).
