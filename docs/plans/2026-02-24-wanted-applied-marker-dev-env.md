# wanted-applied-marker Dev Environment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Date**: 2026-02-24
**Status**: Pending (Not executed)
**Execution note**: The plan below describes target work; repository contents still reflect pre-migration scaffold files in `wanted-applied-marker/src/`.

**Goal:** Replace the default Vite counter template in `wanted-applied-marker/` with a proper userscript dev environment that builds `dist/wanted-applied-marker.user.js` via `vite-plugin-monkey`.

**Architecture:** `vite-plugin-monkey` manages the Tampermonkey metadata header and GM API declarations; TypeScript source lives in `src/main.ts`; `pnpm build` outputs a single `.user.js` ready for Tampermonkey installation.

**Tech Stack:** Vite 7, TypeScript 5, vite-plugin-monkey, @types/greasemonkey, pnpm

---

### Task 1: Install vite-plugin-monkey and greasemonkey types

**Files:**

- Modify: `wanted-applied-marker/package.json`

**Step 1: Add dependencies via pnpm**

Run from `wanted-applied-marker/`:

```bash
pnpm add -D vite-plugin-monkey @types/greasemonkey
```

Expected: `package.json` devDependencies now includes both packages, `pnpm-lock.yaml` updated.

**Step 2: Verify install succeeded**

```bash
pnpm ls vite-plugin-monkey @types/greasemonkey
```

Expected: both packages listed with version numbers.

**Step 3: Commit**

```bash
git add wanted-applied-marker/package.json wanted-applied-marker/pnpm-lock.yaml
git commit -m "chore(wanted-applied-marker): add vite-plugin-monkey and greasemonkey types"
```

---

### Task 2: Create vite.config.ts

**Files:**

- Create: `wanted-applied-marker/vite.config.ts`

**Step 1: Create the config**

Create `wanted-applied-marker/vite.config.ts` with the following content:

```ts
import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";

export default defineConfig({
  plugins: [
    monkey({
      entry: "src/main.ts",
      userscript: {
        name: "Wanted Applied Marker (Infinite Scroll)",
        namespace: "http://tampermonkey.net/",
        version: "2026-02-24",
        description:
          "Mark/hide already-applied jobs on Wanted list. Works with infinite scroll.",
        author: "Dongmin, Yu",
        match: ["https://www.wanted.co.kr/wdlist/*"],
        "run-at": "document-idle",
        grant: ["GM_getValue", "GM_setValue"],
      },
    }),
  ],
});
```

**Step 2: Verify vite picks up the config (type-check only, no build yet)**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors (or errors only about missing main.ts content — that's fine at this stage).

**Step 3: Commit**

```bash
git add wanted-applied-marker/vite.config.ts
git commit -m "feat(wanted-applied-marker): add vite.config.ts with monkey plugin"
```

---

### Task 3: Update tsconfig.json for GM types

**Files:**

- Modify: `wanted-applied-marker/tsconfig.json`

**Step 1: Add greasemonkey to types array**

In `wanted-applied-marker/tsconfig.json`, change:

```json
"types": ["vite/client"]
```

to:

```json
"types": ["vite/client", "greasemonkey"]
```

**Step 2: Verify GM globals are now recognized**

Create a temporary one-liner to confirm (don't commit this):

```bash
echo 'const x = GM_getValue("k", {})' | pnpm exec tsc --stdin --noEmit --target ES2022 --lib ES2022,DOM 2>&1 | head -5
```

Or simply verify in Step 1 of Task 5 that `GM_getValue` / `GM_setValue` don't produce type errors.

**Step 3: Commit**

```bash
git add wanted-applied-marker/tsconfig.json
git commit -m "chore(wanted-applied-marker): add greasemonkey types to tsconfig"
```

---

### Task 4: Remove template files

**Files:**

- Delete: `wanted-applied-marker/src/counter.ts`
- Delete: `wanted-applied-marker/src/style.css`
- Delete: `wanted-applied-marker/src/typescript.svg`
- Delete: `wanted-applied-marker/public/vite.svg`
- Delete: `wanted-applied-marker/index.html`

**Step 1: Delete all template leftovers**

```bash
rm wanted-applied-marker/src/counter.ts \
   wanted-applied-marker/src/style.css \
   wanted-applied-marker/src/typescript.svg \
   wanted-applied-marker/public/vite.svg \
   wanted-applied-marker/index.html
```

**Step 2: Verify nothing important was deleted**

```bash
ls wanted-applied-marker/src/
```

Expected: only `main.ts` (still the old counter content for now — that's fine).

**Step 3: Commit**

```bash
git add -u wanted-applied-marker/
git commit -m "chore(wanted-applied-marker): remove default Vite template files"
```

---

### Task 5: Migrate wanted-marker.js to TypeScript

**Files:**

- Modify: `wanted-applied-marker/src/main.ts` (replace entirely)

**Step 1: Replace src/main.ts with the TypeScript version**

The logic is identical to `wanted-marker.js`. Only type annotations are added.

Replace the entire content of `wanted-applied-marker/src/main.ts` with:

```ts
"use strict";

/** ---------- Config ---------- */
const CACHE_KEY = "wanted_applied_cache_v2";
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 3;
const HIDE_APPLIED = false;

/** ---------- Types ---------- */
interface CacheEntry {
  applied: boolean;
  statusText: string | null;
  updatedAt: number;
}

interface JobDetailResponse {
  data?: {
    application?: {
      status_text?: string;
    } | null;
  };
}

type Cache = Record<number, CacheEntry>;

/** ---------- Cache ---------- */
const now = (): number => Date.now();
const loadCache = (): Cache => {
  try {
    return GM_getValue<Cache>(CACHE_KEY, {});
  } catch {
    return {};
  }
};
const saveCache = (cache: Cache): void => GM_setValue(CACHE_KEY, cache);
const isFresh = (entry: CacheEntry | undefined): boolean =>
  entry !== undefined && now() - entry.updatedAt < TTL_MS;

let cache: Cache = loadCache();

/** ---------- State ---------- */
const inflight = new Map<number, Promise<CacheEntry>>();
const seenAnchors = new WeakSet<Element>();
let queue: Array<{ jobId: number; anchor: HTMLAnchorElement }> = [];
let running = 0;

/** ---------- DOM ---------- */
function getJobAnchors(): Array<{ anchor: HTMLAnchorElement; jobId: number }> {
  const anchors = Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/wd/"]'),
  );
  const jobs: Array<{ anchor: HTMLAnchorElement; jobId: number }> = [];
  for (const a of anchors) {
    const m = a.href.match(/\/wd\/(\d+)/);
    if (!m) continue;
    jobs.push({ anchor: a, jobId: Number(m[1]) });
  }
  return jobs;
}

function ensureBadge(anchor: HTMLAnchorElement, text: string): void {
  let badge = anchor.querySelector<HTMLSpanElement>(":scope .__applied_badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "__applied_badge";
    badge.style.position = "absolute";
    badge.style.top = "10px";
    badge.style.right = "10px";
    badge.style.zIndex = "10";
    badge.style.padding = "4px 8px";
    badge.style.borderRadius = "999px";
    badge.style.fontSize = "12px";
    badge.style.lineHeight = "1";
    badge.style.fontWeight = "700";
    badge.style.background = "rgba(0,0,0,0.75)";
    badge.style.color = "#fff";

    const computed = window.getComputedStyle(anchor);
    if (computed.position === "static") anchor.style.position = "relative";
    anchor.appendChild(badge);
  }
  badge.textContent = text;
}

function markApplied(
  anchor: HTMLAnchorElement,
  statusText: string | null,
): void {
  ensureBadge(anchor, statusText ? `지원완료 (${statusText})` : "지원완료");
  anchor.style.opacity = "0.55";
  anchor.style.filter = "grayscale(0.35)";
  if (HIDE_APPLIED) anchor.style.display = "none";
}

/** ---------- Network ---------- */
async function fetchDetails(jobId: number): Promise<JobDetailResponse> {
  const url = `https://www.wanted.co.kr/api/chaos/jobs/v4/${jobId}/details?ts=${Date.now()}`;
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: {
      accept: "application/json, text/plain, */*",
      "wanted-user-agent": "user-web",
      "wanted-user-country": "KR",
      "wanted-user-language": "ko",
    },
  });
  if (!res.ok) throw new Error(`details ${jobId} failed: ${res.status}`);
  return res.json() as Promise<JobDetailResponse>;
}

function enqueue(jobId: number, anchor: HTMLAnchorElement): void {
  const entry = cache[jobId];
  if (isFresh(entry)) {
    if (entry.applied) markApplied(anchor, entry.statusText);
    return;
  }

  if (inflight.has(jobId)) {
    inflight
      .get(jobId)!
      .then((e) => {
        if (e.applied) markApplied(anchor, e.statusText);
      })
      .catch(() => {});
    return;
  }

  queue.push({ jobId, anchor });
  pump();
}

function pump(): void {
  while (running < CONCURRENCY && queue.length > 0) {
    const { jobId, anchor } = queue.shift()!;
    running++;

    const p = (async (): Promise<CacheEntry> => {
      try {
        const json = await fetchDetails(jobId);
        const app = json?.data?.application ?? null;

        const entry: CacheEntry = {
          applied: app != null,
          statusText: app?.status_text ?? null,
          updatedAt: now(),
        };
        cache[jobId] = entry;
        saveCache(cache);

        if (entry.applied) markApplied(anchor, entry.statusText);
        return entry;
      } finally {
        running--;
        inflight.delete(jobId);
        pump();
      }
    })();

    inflight.set(jobId, p);
  }
}

/** ---------- Main scan (idempotent) ---------- */
function scanAndApply(): void {
  const jobs = getJobAnchors();
  for (const { anchor, jobId } of jobs) {
    if (seenAnchors.has(anchor)) continue;
    seenAnchors.add(anchor);
    enqueue(jobId, anchor);
  }
}

/** ---------- Infinite scroll support ---------- */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleScan(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(scanAndApply, 300);
}

const observer = new MutationObserver(() => {
  scheduleScan();
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
});

scanAndApply();
```

**Step 2: Run TypeScript type check**

```bash
cd wanted-applied-marker && pnpm exec tsc --noEmit
```

Expected: **no errors**. If there are errors about `GM_getValue` / `GM_setValue`, verify Task 3 (greasemonkey types in tsconfig) was completed.

**Step 3: Commit**

```bash
git add wanted-applied-marker/src/main.ts
git commit -m "feat(wanted-applied-marker): migrate userscript to TypeScript"
```

---

### Task 6: Verify the full build

**Files:**

- Verify: `wanted-applied-marker/dist/wanted-applied-marker.user.js`

**Step 1: Run the build**

```bash
cd wanted-applied-marker && pnpm build
```

Expected output (approximately):

```
vite v7.x.x building for production...
✓ built in Xms
dist/wanted-applied-marker.user.js  XX kB
```

**Step 2: Inspect the output file header**

```bash
head -15 wanted-applied-marker/dist/wanted-applied-marker.user.js
```

Expected: The file starts with a valid Tampermonkey metadata block:

```
// ==UserScript==
// @name         Wanted Applied Marker (Infinite Scroll)
// @namespace    http://tampermonkey.net/
// @version      2026-02-24
// @description  Mark/hide already-applied jobs on Wanted list. Works with infinite scroll.
// @author       Dongmin, Yu
// @match        https://www.wanted.co.kr/wdlist/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==
```

**Step 3: Add dist to .gitignore (if not already ignored)**

Check `wanted-applied-marker/.gitignore`:

```bash
cat wanted-applied-marker/.gitignore
```

If `dist` is not listed, add it:

```bash
echo "dist" >> wanted-applied-marker/.gitignore
git add wanted-applied-marker/.gitignore
```

**Step 4: Final commit**

```bash
git add wanted-applied-marker/.gitignore
git commit -m "chore(wanted-applied-marker): verify build and update gitignore"
```

---

### Task 7: Update CLAUDE.md

**Files:**

- Modify: `CLAUDE.md`

**Step 1: Update the Per-Script Development Commands section**

The section currently says "Run from inside the script's subdirectory." Add a note about `vite-plugin-monkey` dev URL:

````markdown
## Per-Script Development Commands

Run from inside the script's subdirectory (e.g., `wanted-applied-marker/`):

\```sh
pnpm dev # Start Vite dev server → copy the .user.js URL into Tampermonkey
pnpm build # Type-check (tsc) then bundle with Vite → dist/<name>.user.js
pnpm preview # Preview built output
\```
````

Also update the Architecture section to note that `vite-plugin-monkey` is used.

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with vite-plugin-monkey dev workflow"
```
