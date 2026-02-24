# CI/CD Pipeline Design

**Date**: 2026-02-24
**Status**: Approved

## Goal

Automatic deployment pipeline: when a release-please release PR is merged to `main`, build the relevant userscript and attach `dist/<name>.user.js` as a GitHub Release asset.

## Decisions

| Decision        | Choice                         | Rationale                                                               |
| --------------- | ------------------------------ | ----------------------------------------------------------------------- |
| Deploy target   | GitHub Releases (asset upload) | Tampermonkey can install directly from a GitHub Release URL             |
| Release trigger | release-please                 | Conventional commit analysis, automatic CHANGELOG + PR + GitHub Release |
| Versioning      | Per-script (monorepo)          | Each script gets independent semver                                     |
| Lint in CI      | trunk-io/trunk-action@v1       | Already configured in .trunk/trunk.yaml                                 |

## Flow

```plaintext
feat(wanted-applied-marker): ... → main
  → release-please.yml: creates/updates Release PR
  → PR merge → release-please creates GitHub Release + tag (wanted-applied-marker-v1.x.x)
  → release.yml triggers on published release
  → extracts package name from tag
  → pnpm --filter <package> build
  → uploads dist/<name>.user.js as release asset
```

## File Changes

### Delete

- `wanted-marker.js` — legacy standalone file; source of truth is now `wanted-applied-marker/src/`

### Create

- `pnpm-workspace.yaml` — lists `wanted-applied-marker` (and future scripts)
- `.release-please-manifest.json` — initial version tracking for each script

### Update

- `release-please-config.json` — switch from single root package to per-subdirectory packages
- `.github/workflows/release-please.yml` — fix branch (`master` → `main`), add config/manifest paths
- `.github/workflows/build.yml` → **rewrite as release.yml** — trigger `on: release: published`, extract package from tag, build, upload asset
- `.github/workflows/check.yml` — fix pnpm action (v3 → v4), replace broken lint/test with trunk check + typecheck

## Workflow Details

### release-please.yml

```yaml
on:
  push:
    branches: [main]

jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json
```

### release.yml (replaces build.yml)

```yaml
on:
  release:
    types: [published]

jobs:
  build-and-upload:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: pnpm
      - run: pnpm install

      - name: Extract package name from tag
        # Tag format: <package-name>-v<semver>  (e.g. wanted-applied-marker-v1.0.0)
        run: |
          TAG="${{ github.event.release.tag_name }}"
          PACKAGE="${TAG%-v*}"
          echo "PACKAGE=$PACKAGE" >> $GITHUB_ENV

      - name: Build
        run: pnpm --filter "${{ env.PACKAGE }}" build

      - name: Upload .user.js to release
        uses: softprops/action-gh-release@v2
        with:
          files: ${{ env.PACKAGE }}/dist/${{ env.PACKAGE }}.user.js
```

### check.yml

```yaml
on:
  push:
    branches: ["**"]
  pull_request:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: pnpm
      - run: pnpm install

      - name: Typecheck
        run: pnpm -r exec tsc --noEmit

      - name: Trunk Check
        uses: trunk-io/trunk-action@v1
```

## release-please-config.json (monorepo)

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "pull-request-header": ":robot: I have created a release",
  "pull-request-title-pattern": "chore: release${component} ${version}",
  "include-component-in-tag": true,
  "packages": {
    "wanted-applied-marker": {
      "component": "wanted-applied-marker",
      "release-type": "node"
    }
  }
}
```

## .release-please-manifest.json

```json
{
  "wanted-applied-marker": "0.0.0"
}
```

Initial `0.0.0` so the next release-please run bumps to `1.0.0` (on a `feat:` commit).

## pnpm-workspace.yaml

```yaml
packages:
  - "wanted-applied-marker"
```

## Root package.json scripts

Add:

```json
"scripts": {
  "build": "pnpm -r build",
  "typecheck": "pnpm -r exec tsc --noEmit"
}
```
