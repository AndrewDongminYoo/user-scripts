"use strict";

/** ---------- Config ---------- */
const CACHE_KEY = "wanted_applied_cache_v2";
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 3;
const RETRY_DELAY_MS = 500;
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
const seenAnchors = new WeakSet<Element>();
const pendingAnchors = new Map<number, Set<HTMLAnchorElement>>();
const queue: number[] = [];
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
  const url = `/api/chaos/jobs/v4/${jobId}/details?ts=${Date.now()}`;
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function fetchDetailsWithRetry(
  jobId: number,
): Promise<JobDetailResponse> {
  try {
    return await fetchDetails(jobId);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    await sleep(RETRY_DELAY_MS);
    return fetchDetails(jobId);
  }
}

function enqueue(jobId: number, anchor: HTMLAnchorElement): void {
  const entry = cache[jobId];
  if (isFresh(entry)) {
    if (entry.applied) markApplied(anchor, entry.statusText);
    return;
  }

  const pending = pendingAnchors.get(jobId);
  if (pending) {
    pending.add(anchor);
    return;
  }

  pendingAnchors.set(jobId, new Set([anchor]));
  queue.push(jobId);
  pump();
}

async function processJob(jobId: number): Promise<void> {
  try {
    const json = await fetchDetailsWithRetry(jobId);
    const app = json.data?.application ?? null;

    const entry: CacheEntry = {
      applied: app != null,
      statusText: app?.status_text ?? null,
      updatedAt: now(),
    };
    cache[jobId] = entry;
    saveCache(cache);

    if (entry.applied) {
      for (const anchor of pendingAnchors.get(jobId) ?? [])
        markApplied(anchor, entry.statusText);
    }
  } catch (error) {
    const cause =
      error instanceof Error ? error : new Error("unknown job details failure");
    console.error(`[wanted-applied-marker] job ${jobId} failed`, cause);
    for (const anchor of pendingAnchors.get(jobId) ?? [])
      seenAnchors.delete(anchor);
  } finally {
    pendingAnchors.delete(jobId);
    running--;
    pump();
  }
}

function pump(): void {
  while (running < CONCURRENCY && queue.length > 0) {
    const jobId = queue.shift();
    if (jobId === undefined) return;
    running++;
    processJob(jobId).catch((error: unknown) => {
      const cause =
        error instanceof Error ? error : new Error("unknown scheduler failure");
      console.error("[wanted-applied-marker] scheduler failed", cause);
    });
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

function isWantedListPage(pathname: string): boolean {
  return pathname === "/wdlist" || pathname.startsWith("/wdlist/");
}

if (isWantedListPage(window.location.pathname)) {
  const observer = new MutationObserver(() => {
    scheduleScan();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  scanAndApply();
}
