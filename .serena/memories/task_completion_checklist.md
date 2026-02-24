# Before marking work complete

- Run relevant script-level validation in affected subdirectory:
  - `pnpm build` (minimum check for TS+bundle integrity)
- Run repo-level checks/format as needed:
  - `trunk check`
  - `trunk fmt` (if formatting changes are expected)
- If behavior changed in a userscript:
  - Verify root distributable metadata block remains valid.
  - Verify userscript runtime behavior on target page(s).
- Review diff for consistency with userscript architecture constraints (self-contained IIFE, GM\_\* persistence where applicable).
