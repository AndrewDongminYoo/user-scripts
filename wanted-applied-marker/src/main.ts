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
