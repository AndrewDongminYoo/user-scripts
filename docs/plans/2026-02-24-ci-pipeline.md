# CI/CD Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Delete the legacy `wanted-marker.js`, set up pnpm workspaces, and replace broken GitHub Actions workflows with a working pipeline: trunk check + typecheck on PR, and automatic `.user.js` asset upload on GitHub Release.

**Architecture:** release-please creates Release PRs on conventional commits; when merged, it publishes a GitHub Release with a per-script tag (e.g. `wanted-applied-marker-v1.0.0`). A `release.yml` workflow triggers on that release, builds the script via `pnpm --filter`, and uploads `dist/*.user.js` as a release asset. `check.yml` runs trunk + typecheck on every push/PR.

**Tech Stack:** GitHub Actions, release-please-action v4, softprops/action-gh-release v2, trunk-io/trunk-action v1, pnpm workspaces

---

### Task 1: Delete wanted-marker.js and verify

**Files:**

- Delete: `wanted-marker.js`

**Step 1: Delete the file**

```bash
rm /Users/dongminyu/Development/01_personal/user-scripts/wanted-marker.js
```

**Step 2: Verify it's gone**

```bash
ls /Users/dongminyu/Development/01_personal/user-scripts/*.js 2>&1
```

Expected: `No such file or directory` or empty output.

**Step 3: Commit**

```bash
git rm wanted-marker.js
git commit -m "chore: remove legacy standalone wanted-marker.js"
```

Expected: 1 file deleted.

---

### Task 2: Create pnpm-workspace.yaml

**Files:**

- Create: `pnpm-workspace.yaml`

**Step 1: Create the workspace config**

Create `/Users/dongminyu/Development/01_personal/user-scripts/pnpm-workspace.yaml`:

```yaml
packages:
  - "wanted-applied-marker"
```

**Step 2: Verify pnpm recognizes the workspace**

```bash
cd /Users/dongminyu/Development/01_personal/user-scripts && pnpm -r ls 2>&1 | head -10
```

Expected: output lists `wanted-applied-marker` package.

**Step 3: Commit**

```bash
git add pnpm-workspace.yaml
git commit -m "chore: add pnpm workspace configuration"
```

---

### Task 3: Update root package.json with workspace scripts

**Files:**

- Modify: `package.json`

**Step 1: Add build and typecheck scripts**

The current `package.json` scripts section:

```json
"scripts": {
  "test": "echo \"Error: no test specified\" && exit 1"
}
```

Replace with:

```json
"scripts": {
  "build": "pnpm -r build",
  "typecheck": "pnpm -r exec tsc --noEmit"
}
```

**Step 2: Verify build works from root**

```bash
cd /Users/dongminyu/Development/01_personal/user-scripts && pnpm build 2>&1
```

Expected: runs `wanted-applied-marker`'s build, outputs `dist/wanted-applied-marker.user.js`.

**Step 3: Verify typecheck works from root**

```bash
cd /Users/dongminyu/Development/01_personal/user-scripts && pnpm typecheck 2>&1
```

Expected: no errors.

**Step 4: Commit**

```bash
git add package.json
git commit -m "chore: add workspace build and typecheck scripts to root"
```

---

### Task 4: Update release-please-config.json for monorepo

**Files:**

- Modify: `release-please-config.json`

**Step 1: Replace with monorepo config**

Replace the entire content of `release-please-config.json`:

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

Key change: `"packages"` now points to the `wanted-applied-marker` subdirectory instead of the root `"."`. This makes release-please track commits scoped to `wanted-applied-marker/` and create tags like `wanted-applied-marker-v1.0.0`.

**Step 2: Commit**

```bash
git add release-please-config.json
git commit -m "chore: update release-please config for monorepo packages"
```

---

### Task 5: Create .release-please-manifest.json

**Files:**

- Create: `.release-please-manifest.json`

**Step 1: Create the manifest**

Create `/Users/dongminyu/Development/01_personal/user-scripts/.release-please-manifest.json`:

```json
{
  "wanted-applied-marker": "0.0.0"
}
```

`0.0.0` as initial value means the first `feat:` commit will produce `1.0.0`, the first `fix:` will produce `0.1.0`. This follows release-please's semver bump rules.

**Step 2: Commit**

```bash
git add .release-please-manifest.json
git commit -m "chore: add release-please manifest with initial versions"
```

---

### Task 6: Fix release-please.yml workflow

**Files:**

- Modify: `.github/workflows/release-please.yml`

**Step 1: Replace the workflow**

Replace the entire content of `.github/workflows/release-please.yml`:

```yaml
name: release-please

on:
  push:
    branches:
      - main

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

Key fixes:

- `master` → `main` (this repo uses `main`)
- Added `token`, `config-file`, `manifest-file` options

**Step 2: Validate YAML syntax**

```bash
pnpm exec js-yaml .github/workflows/release-please.yml > /dev/null 2>&1 && echo "valid" || echo "invalid"
```

If `js-yaml` is not available, just visually verify the indentation is correct.

**Step 3: Commit**

```bash
git add .github/workflows/release-please.yml
git commit -m "fix: update release-please workflow to use main branch and monorepo config"
```

---

### Task 7: Rewrite build.yml → release.yml

**Files:**

- Delete: `.github/workflows/build.yml`
- Create: `.github/workflows/release.yml`

**Step 1: Delete the old build.yml**

```bash
git rm .github/workflows/build.yml
```

**Step 2: Create release.yml**

Create `/Users/dongminyu/Development/01_personal/user-scripts/.github/workflows/release.yml`:

```yaml
name: Release

on:
  release:
    types: [published]

jobs:
  build-and-upload:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: pnpm

      - name: Install dependencies
        run: pnpm install

      - name: Extract package name from tag
        # Tag format from release-please: <package-name>-v<semver>
        # Example: wanted-applied-marker-v1.0.0 → PACKAGE=wanted-applied-marker
        run: |
          TAG="${{ github.event.release.tag_name }}"
          PACKAGE="${TAG%-v*}"
          echo "PACKAGE=$PACKAGE" >> "$GITHUB_ENV"

      - name: Build
        run: pnpm --filter "${{ env.PACKAGE }}" build

      - name: Upload .user.js to release
        uses: softprops/action-gh-release@v2
        with:
          files: ${{ env.PACKAGE }}/dist/${{ env.PACKAGE }}.user.js
```

**Step 3: Verify the tag extraction logic locally**

```bash
TAG="wanted-applied-marker-v1.0.0"
PACKAGE="${TAG%-v*}"
echo "$PACKAGE"
```

Expected output: `wanted-applied-marker`

**Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat: add release workflow to build and upload .user.js on GitHub Release"
```

---

### Task 8: Fix check.yml

**Files:**

- Modify: `.github/workflows/check.yml`

**Step 1: Replace the workflow**

Replace the entire content of `.github/workflows/check.yml`:

```yaml
name: Check

on:
  push:
    branches:
      - "**"
  pull_request:
    branches:
      - main

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: pnpm

      - name: Install dependencies
        run: pnpm install

      - name: Typecheck
        run: pnpm typecheck

      - name: Trunk Check
        uses: trunk-io/trunk-action@v1
```

Key fixes:

- pnpm action v3 → v4
- Replaced broken `pnpm run lint` / `pnpm run test` with `pnpm typecheck` (calls `pnpm -r exec tsc --noEmit`)
- Added `trunk-io/trunk-action@v1` for lint (prettier, markdownlint, yamllint, etc.)
- Branch filter: `master` → `main`

**Step 2: Commit**

```bash
git add .github/workflows/check.yml
git commit -m "fix: rewrite check workflow with typecheck and trunk lint"
```

---

### Task 9: Update CLAUDE.md

**Files:**

- Modify: `CLAUDE.md`

**Step 1: Add CI/CD pipeline section**

Add the following section at the end of `CLAUDE.md`, before the last empty line:

````markdown
## CI/CD Pipeline

### Workflows

| Workflow             | Trigger                  | Purpose                                                             |
| -------------------- | ------------------------ | ------------------------------------------------------------------- |
| `check.yml`          | Every push / PR to main  | TypeScript typecheck (`pnpm typecheck`) + trunk lint                |
| `release-please.yml` | Push to main             | Creates/updates Release PRs; on merge, creates GitHub Release + tag |
| `release.yml`        | GitHub Release published | Builds the tagged script, uploads `dist/*.user.js` as release asset |

### Making a Release

Use conventional commits scoped to the script name:

```sh
feat(wanted-applied-marker): add new feature     # bumps minor version
fix(wanted-applied-marker): fix edge case         # bumps patch version
feat(wanted-applied-marker)!: breaking change     # bumps major version
```

release-please detects these commits and opens a Release PR automatically. Merging the PR publishes the release and triggers the asset build.
````

### Adding a New Script to the Pipeline

1. Add the subdirectory to `pnpm-workspace.yaml`
2. Add the package to `release-please-config.json` under `packages`
3. Add the initial version to `.release-please-manifest.json`

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document CI/CD pipeline in CLAUDE.md"
```
