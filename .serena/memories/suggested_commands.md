# Core project commands

- Install deps (root or script dir):
  - `pnpm install`
- In script subdirectory (example: `wanted-applied-marker/`):
  - `pnpm dev` (start Vite dev server)
  - `pnpm build` (type-check with `tsc` then `vite build`)
  - `pnpm preview` (preview built output)

# Repo/tooling commands

- `trunk check` (run configured linters/checks)
- `trunk fmt` (apply configured formatting)

# Useful Darwin shell commands

- `git status`, `git diff`
- `ls`, `cd`, `pwd`
- `rg <pattern>` (fast code/text search)
- `find . -name '<glob>'`
- `cat <file>` / `sed -n 'start,endp' <file>`
