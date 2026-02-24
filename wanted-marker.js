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

(() => {
  "use strict";

  /** ---------- Config ---------- */
  const CACHE_KEY = "wanted_applied_cache_v2";
  const TTL_MS = 14 * 24 * 60 * 60 * 1000;
  const CONCURRENCY = 3;
  const HIDE_APPLIED = false;

  /** ---------- Cache ---------- */
  const now = () => Date.now();
  const loadCache = () => {
    try {
      return GM_getValue(CACHE_KEY, {});
    } catch {
      return {};
    }
  };
  const saveCache = (cache) => GM_setValue(CACHE_KEY, cache);
  const isFresh = (entry) => entry && now() - entry.updatedAt < TTL_MS;

  let cache = loadCache();

  /** ---------- State ---------- */
  const inflight = new Map(); // jobId -> Promise
  const seenAnchors = new WeakSet(); // avoid re-badging same DOM node
  let queue = [];
  let running = 0;

  /** ---------- DOM ---------- */
  function getJobAnchors() {
    // Wanted card is often an <a> with /wd/<id>.
    // If Wanted changes markup, update this selector.
    const anchors = Array.from(document.querySelectorAll('a[href*="/wd/"]'));
    const jobs = [];
    for (const a of anchors) {
      const m = a.href.match(/\/wd\/(\d+)/);
      if (!m) continue;
      jobs.push({ anchor: a, jobId: Number(m[1]) });
    }
    return jobs;
  }

  function ensureBadge(anchor, text) {
    let badge = anchor.querySelector(":scope .__applied_badge");
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

  function markApplied(anchor, statusText) {
    ensureBadge(anchor, statusText ? `지원완료 (${statusText})` : "지원완료");
    anchor.style.opacity = "0.55";
    anchor.style.filter = "grayscale(0.35)";
    if (HIDE_APPLIED) anchor.style.display = "none";
  }

  /** ---------- Network ---------- */
  async function fetchDetails(jobId) {
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
    return res.json();
  }

  function enqueue(jobId, anchor) {
    // If cache is fresh, apply immediately, no queue
    const entry = cache[jobId];
    if (isFresh(entry)) {
      if (entry.applied) markApplied(anchor, entry.statusText);
      return;
    }

    // Deduplicate inflight by jobId
    if (inflight.has(jobId)) {
      inflight
        .get(jobId)
        .then((entry) => {
          if (entry.applied) markApplied(anchor, entry.statusText);
        })
        .catch(() => {});
      return;
    }

    queue.push({ jobId, anchor });
    pump();
  }

  function pump() {
    while (running < CONCURRENCY && queue.length > 0) {
      const { jobId, anchor } = queue.shift();
      running++;

      const p = (async () => {
        try {
          const json = await fetchDetails(jobId);
          const app = json?.data?.application ?? null;

          const entry = {
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
  function scanAndApply() {
    const jobs = getJobAnchors();
    for (const { anchor, jobId } of jobs) {
      // Avoid re-processing the same anchor node endlessly
      if (seenAnchors.has(anchor)) continue;
      seenAnchors.add(anchor);

      // Apply cache / enqueue fetch
      enqueue(jobId, anchor);
    }
  }

  /** ---------- Infinite scroll support ---------- */
  let debounceTimer = null;
  function scheduleScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scanAndApply, 300);
  }

  const observer = new MutationObserver(() => {
    // Any DOM changes -> rescan (debounced)
    scheduleScan();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Initial scan
  scanAndApply();
})();
