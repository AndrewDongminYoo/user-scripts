# Userscript Reliability and Release Hardening Implementation Plan

Date: 2026-07-21
Status: In progress

Progress: Tasks 1–5 and Task 6 Steps 1, 2, and 4 are complete. The exact-final-SHA review in Task 6 Step 3 remains before this plan can be marked completed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the repository review findings and submit one focused draft pull request with regression coverage and a green full-repository gate.

**Architecture:** Keep each userscript import-free and test its built bundle through the existing Node VM pattern. Replace Wanted's separate queue/inflight window with one job-keyed pending map, guard broad metadata matches with an exact runtime pathname check, and make the API same-origin. Make Gemini pagination return only after the server cursor is exhausted, then harden dependency and workflow inputs without changing runtime features.

**Tech Stack:** TypeScript 6, Vite 8, vite-plugin-monkey 8, Node VM test harnesses, pnpm 10.26.2, Trunk, GitHub Actions.

## Global Constraints

- Use `pnpm` only.
- Keep each `src/main.ts` import-free.
- Do not hand-edit or commit `dist/*.user.js`.
- Preserve existing public behavior outside the reviewed defects.
- Write regression tests before production changes and observe each intended RED failure.
- Keep implementation, direct tests, dependency lockfile, workflow pins, and documentation in concern-level commits.

---

### Task 1: Wanted request reliability harness and scheduler

**Files:**

- Create: `wanted-applied-marker/test/run.mjs`
- Modify: `wanted-applied-marker/package.json`
- Modify: `wanted-applied-marker/src/main.ts:4-170`

**Interfaces:**

- Consumes: built `dist/wanted-applied-marker.user.js` and stubbed DOM, GM storage, fetch, timers, and MutationObserver surfaces.
- Produces: `pnpm --filter wanted-applied-marker test`; job-keyed `pendingAnchors`; one retry after `RETRY_DELAY_MS = 500`.

- [ ] **Step 1: Add the test command and a VM sandbox**

Add `"test": "node test/run.mjs"` to the package scripts.
The harness reads the built bundle, exposes a `makeSandbox` helper, records fetch calls and unhandled rejections, retains the observer callback, and uses a controllable timer queue.

- [ ] **Step 2: Add failing scheduler scenarios**

Add checks equivalent to:

```javascript
check(
  "queued duplicate job fetched once",
  calls.filter((id) => id === 4).length === 1,
);
check("transient failure retried", calls.length === 2);
check("retry marks applied anchor", anchor.badgeText === "지원완료");
check("failure is handled", unhandled.length === 0);
```

Add a two-failure scenario, trigger the observer again, and assert the same anchor becomes fetchable again rather than remaining permanently seen.

- [ ] **Step 3: Run RED**

Run: `pnpm --filter wanted-applied-marker build && pnpm --filter wanted-applied-marker test`
Expected: FAIL because queued job `4` is fetched twice, the transient failure emits an unhandled rejection, and the failed anchor is not retried.

- [ ] **Step 4: Implement the minimal scheduler repair**

Replace the queue payload and `inflight` promise map with:

```typescript
const pendingAnchors = new Map<number, Set<HTMLAnchorElement>>();
const queue: number[] = [];
```

When a job is already pending, add the anchor to its set and return.
When starting a job, call a two-attempt helper that waits 500 ms after the first failure.
On success, cache once and mark every pending anchor.
On final failure, log the narrowed `Error`, remove the affected anchors from `seenAnchors`, and consume the rejection at the worker boundary.
Always delete the pending entry, decrement `running`, and pump in `finally`.

- [ ] **Step 5: Run GREEN and source checks**

Run: `pnpm --filter wanted-applied-marker build && pnpm --filter wanted-applied-marker test && pnpm --filter wanted-applied-marker exec tsc --noEmit`
Expected: all scheduler checks pass with zero unhandled rejections.

- [ ] **Step 6: Commit**

```bash
git add wanted-applied-marker/package.json wanted-applied-marker/src/main.ts wanted-applied-marker/test/run.mjs
git commit -m "fix(wanted-applied-marker): recover failed job checks"
```

### Task 2: Wanted URL and API-origin coverage

**Files:**

- Modify: `wanted-applied-marker/test/run.mjs`
- Modify: `wanted-applied-marker/vite.config.ts:17`
- Modify: `wanted-applied-marker/src/main.ts:95-190`

**Interfaces:**

- Consumes: `window.location.pathname` and the generated userscript metadata header.
- Produces: `isWantedListPage(pathname: string): boolean`; two metadata matches; relative details API URL.

- [ ] **Step 1: Add failing URL and header scenarios**

Run the built bundle for both hosts with `/wdlist`, `/wdlist/`, `/wdlist/123`, query, and fragment fixtures.
Assert that `/wdlisting` performs no query, observer installation, or fetch.
Assert the generated header contains exactly these entries:

```plaintext
@match        https://www.wanted.co.kr/wdlist*
@match        https://wanted.co.kr/wdlist*
```

Assert every details request starts with `/api/chaos/jobs/v4/` rather than a hard-coded origin.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter wanted-applied-marker build && pnpm --filter wanted-applied-marker test`
Expected: FAIL because only the `www` slash-suffix metadata pattern exists, unrelated paths start the runtime, and the API URL is absolute.

- [ ] **Step 3: Implement the runtime guard and metadata**

Add:

```typescript
function isWantedListPage(pathname: string): boolean {
  return pathname === "/wdlist" || pathname.startsWith("/wdlist/");
}
```

Move observer creation and the initial scan into `init()` and invoke it only when the guard passes.
Use `/api/chaos/jobs/v4/${jobId}/details?...` for the request URL.
Set the two approved `/wdlist*` metadata entries in `vite.config.ts`.

- [ ] **Step 4: Run GREEN**

Run: `pnpm --filter wanted-applied-marker build && pnpm --filter wanted-applied-marker test`
Expected: every URL/header/API-origin check passes.

- [ ] **Step 5: Commit**

```bash
git add wanted-applied-marker/src/main.ts wanted-applied-marker/test/run.mjs wanted-applied-marker/vite.config.ts
git commit -m "fix(wanted-applied-marker): cover Wanted URL variants"
```

### Task 3: Gemini pagination completeness

**Files:**

- Modify: `gemini-chat-exporter/test/run.mjs`
- Modify: `gemini-chat-exporter/src/main.ts:1018-1044`

**Interfaces:**

- Consumes: learned `MaZiqc` template and server cursors.
- Produces: `listAllConversations()` that resolves only after a cursor-less page and rejects local incomplete termination.

- [ ] **Step 1: Add failing incomplete-pagination scenarios**

Extend the VM transport fixture so `listAllConversations()` receives an empty parsed page with a non-null cursor.
Assert it rejects with a Korean retry/completeness message instead of returning the accumulated list.
Add a 200-page cursor fixture and assert cap exhaustion also rejects.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter gemini-chat-exporter build && pnpm --filter gemini-chat-exporter test`
Expected: FAIL because both conditions currently return partial data.

- [ ] **Step 3: Implement explicit terminal states**

Return the accumulated refs immediately only when `next` is null.
Throw when `refs.length === 0` while `next` remains present.
After the loop, throw a page-cap error instead of returning refs.

- [ ] **Step 4: Run GREEN and commit**

Run: `pnpm --filter gemini-chat-exporter build && pnpm --filter gemini-chat-exporter test`
Expected: all existing and new Gemini checks pass.

```bash
git add gemini-chat-exporter/src/main.ts gemini-chat-exporter/test/run.mjs
git commit -m "fix(gemini-chat-exporter): reject partial conversation lists"
```

### Task 4: Dependency and workflow supply-chain hardening

**Files:**

- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify: `.github/workflows/check.yml`
- Modify: `.github/workflows/release.yml`

**Interfaces:**

- Consumes: GitHub Advisory API result for `GHSA-3jxr-9vmj-r5cp` and resolved tag commits for every current Action version.
- Produces: patched `brace-expansion` resolution and immutable Action references with readable version comments.

- [ ] **Step 1: Verify advisory and Action commits**

Run `gh api advisories/GHSA-3jxr-9vmj-r5cp` and select the patched `1.1.x` entry.
Resolve each workflow tag through the GitHub API and dereference annotated tags before recording a 40-character commit SHA.

- [ ] **Step 2: Apply the dependency override and regenerate the lockfile**

Set `brace-expansion: ^1.1.16` in `pnpm-workspace.yaml`.
Run: `pnpm install --no-frozen-lockfile`
Expected: `pnpm-lock.yaml` resolves `brace-expansion` to at least `1.1.16`.

- [ ] **Step 3: Pin workflow Actions**

Replace each `uses: owner/repo@tag` with `uses: owner/repo@<40-character-sha> # tag` in both workflow files.
Do not change permissions, triggers, job logic, or Action versions.

- [ ] **Step 4: Verify and commit**

Run: `pnpm -r why brace-expansion && .trunk/tools/osv-scanner scan source --lockfile pnpm-lock.yaml && pnpm build`
Expected: safe version resolved, OSV exits 0, and all packages build.

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml .github/workflows/check.yml .github/workflows/release.yml
git commit -m "build: harden dependency and workflow inputs"
```

### Task 5: Documentation alignment

**Files:**

- Modify: `wanted-applied-marker/README.md`
- Modify: `wanted-applied-marker/AGENTS.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `claude-chat-exporter/README.md`
- Modify: `gemini-chat-exporter/AGENTS.md`
- Modify: `docs/plans/2026-07-12-gemini-export-all-batchexecute-blueprint.md`
- Modify: `docs/plans/2026-07-12-gemini-chat-exporter.md`
- Modify: `docs/plans/2026-07-21-reliability-and-release-hardening-design.md`
- Modify: `docs/plans/2026-07-21-reliability-and-release-hardening.md`

**Interfaces:**

- Consumes: shipped package list, test scripts, Wanted URL contract, and Gemini's implemented pinned-RPC behavior.
- Produces: documentation that matches the final code and passes Markdown lint.

- [ ] **Step 1: Apply narrow documentation corrections**

Replace Wanted's repository-wide latest asset link with the package-filtered releases instructions used by its siblings.
Document both Wanted hosts and accepted `/wdlist` path forms.
Add Gemini to the root scripts table and document all three built-bundle harnesses.
Replace Claude's stale “two floating buttons” wording with the current trigger/modal interaction.
Mark the Gemini reconnaissance as implemented with the pinned-RPC divergence.
Remove the trailing space inside the code span at the existing MD038 location.
Set the design document to `Completed` after implementation and verification. Keep this implementation plan `In progress` until its exact-final-SHA review is complete.

- [ ] **Step 2: Run documentation checks and commit**

Run: `trunk check README.md AGENTS.md CLAUDE.md wanted-applied-marker/README.md wanted-applied-marker/AGENTS.md claude-chat-exporter/README.md gemini-chat-exporter/AGENTS.md docs/plans/2026-07-12-gemini-export-all-batchexecute-blueprint.md docs/plans/2026-07-12-gemini-chat-exporter.md docs/plans/2026-07-21-reliability-and-release-hardening-design.md docs/plans/2026-07-21-reliability-and-release-hardening.md`
Expected: no issues.

```bash
git add README.md AGENTS.md CLAUDE.md wanted-applied-marker/README.md wanted-applied-marker/AGENTS.md claude-chat-exporter/README.md gemini-chat-exporter/AGENTS.md docs/plans/2026-07-12-gemini-export-all-batchexecute-blueprint.md docs/plans/2026-07-12-gemini-chat-exporter.md docs/plans/2026-07-21-reliability-and-release-hardening-design.md docs/plans/2026-07-21-reliability-and-release-hardening.md
git commit -m "docs: align userscript behavior and release guidance"
```

### Task 6: Final verification, review, and draft PR

**Files:**

- Verify: all changed files and generated ignored bundles.

**Interfaces:**

- Consumes: the complete branch diff against `origin/main`.
- Produces: fresh validation evidence, concern-split commits, pushed branch, and a draft PR.

- [ ] **Step 1: Run the full repository gate**

```bash
pnpm typecheck
pnpm build
pnpm -r test
trunk check --all
```

Expected: every command exits 0.

- [ ] **Step 2: Run focused manual QA**

Inspect the generated Wanted metadata and execute the retry, final-failure rescan, queued-dedup, accepted-URL, rejected-path, and relative-API scenarios through the built VM harness.
Confirm `git status --short` contains no tracked generated output or debug artifacts.

- [ ] **Step 3: Review the final SHA**

Run the required code-quality, security, goal, context, and hands-on QA review lanes plus the runtime debugging audit against the exact final commit SHA.
Fix blockers with new regression tests and rerun affected lanes on the new SHA.

- [ ] **Step 4: Push and open a draft PR**

Run: `git push -u origin agent/improve-userscript-reliability`
Open a draft PR targeting `main` with the root causes, behavior changes, security changes, documentation alignment, and exact validation commands.
