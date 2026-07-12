# user-scripts

A monorepo of browser userscripts (Tampermonkey / Greasemonkey), each written in TypeScript and bundled with [`vite-plugin-monkey`](https://github.com/lisonge/vite-plugin-monkey).
Every package builds to a single `dist/<name>.user.js` that is published as a GitHub Release asset by CI on qualifying pushes to `main`.

## Scripts

| Package                                                    | What it does                                                                                                                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`wanted-applied-marker`](wanted-applied-marker/README.md) | Marks already-applied jobs on Wanted.co.kr listings, using the site's `chaos/jobs` API with a 14-day cache.                                                                                        |
| [`claude-chat-exporter`](claude-chat-exporter/README.md)   | Exports Claude.ai conversations — the current one, or all of them — to Markdown or JSON via the site's same-origin API. Captures text, extended thinking, tool calls/results, and attachment text. |

## Install a script

Each script ships as a userscript file on the [Releases](https://github.com/AndrewDongminYoo/user-scripts/releases) page.
With Tampermonkey (or another userscript manager) installed, open the latest `<name>.user.js` release asset and confirm the install prompt.
See each package's own README for site-specific setup notes.

## Development

This repo uses **pnpm** exclusively (`pnpm@10.26.2`, pinned via `packageManager`).

```sh
pnpm install       # install all workspace dependencies
pnpm build         # build every package (pnpm -r build)
pnpm typecheck     # tsc --noEmit across packages
pnpm -r test       # run each package's test harness (currently claude-chat-exporter)
trunk check        # lint + format check
```

Per-package commands run from inside a package directory (e.g. `claude-chat-exporter/`):

```sh
pnpm dev           # Vite dev server; install the printed .user.js URL in Tampermonkey for live reload
pnpm build         # type-check (tsc) then bundle to dist/<name>.user.js (with the metadata header)
pnpm preview       # preview the built output
```

Each script's source is a single import-free `src/main.ts` — Tampermonkey provides the `GM_*` globals at runtime, declared in `src/env.d.ts`.
`vite-plugin-monkey` prepends the userscript metadata header (name, `@match`, `@grant`, `@version`) at build time from `vite.config.ts`.
Never hand-edit `dist/*.user.js`.

## CI/CD

| Workflow | File                            | Trigger                          |
| -------- | ------------------------------- | -------------------------------- |
| Check    | `.github/workflows/check.yml`   | Push to any branch, PR to `main` |
| Release  | `.github/workflows/release.yml` | Push to `main`                   |

**Check** runs `pnpm typecheck`, `pnpm -r build`, `pnpm -r test`, then `trunk check`; all must pass before merge.

**Release** runs a matrix over the packages. For each one it detects `feat:` / `fix:` / `refactor:` / `perf:` commits since that package's last tag, generates a date-based version (`YYYY-MM-DD`, with a `.N` suffix for same-day releases), builds with `SCRIPT_VERSION=<version>`, then creates a tag `<package>-<version>`, a GitHub Release, and uploads `<package>/dist/<package>.user.js`.

## Adding a new script

1. Scaffold a package with `pnpm create vite` (`vanilla-ts` template).
2. Add `vite-plugin-monkey` and a `vite.config.ts` with the `monkey({ entry, userscript })` plugin (see an existing package for reference).
3. Add `src/env.d.ts` exposing the `GM_*` globals you use.
4. Register the package directory in `pnpm-workspace.yaml` and in the `matrix.package` list in `.github/workflows/release.yml`.

See `AGENTS.md` and `CLAUDE.md` for the full contributor and agent guidance.

## License

MIT
