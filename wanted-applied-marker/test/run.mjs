import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const DIST = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "wanted-applied-marker.user.js",
);
const source = readFileSync(DIST, "utf8");

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}`);
  }
}

function makeAnchor(jobId) {
  let badge = null;
  return {
    href: `https://www.wanted.co.kr/wd/${jobId}`,
    style: {},
    get badgeText() {
      return badge?.textContent ?? null;
    },
    querySelector: () => badge,
    appendChild(child) {
      badge = child;
    },
  };
}

function makeSandbox({
  anchors,
  fetchImpl,
  pageUrl = "https://www.wanted.co.kr/wdlist",
}) {
  const timers = [];
  const errors = [];
  const gmStore = {};
  let observerCallback = null;
  let nextTimerId = 1;
  let observeCalls = 0;
  let queryCalls = 0;

  const globals = {
    console: {
      log: (...args) => console.log(...args),
      error: (...args) => errors.push(args.map(String).join(" ")),
    },
    Date,
    Error,
    Map,
    Promise,
    Set,
    WeakSet,
    clearTimeout(id) {
      const timer = timers.find((entry) => entry.id === id);
      if (timer) timer.cancelled = true;
    },
    setTimeout(callback, delay = 0) {
      const id = nextTimerId++;
      timers.push({ callback, cancelled: false, delay, id });
      return id;
    },
    fetch: fetchImpl,
    GM_getValue: (key, fallback) => gmStore[key] ?? fallback,
    GM_setValue: (key, value) => {
      gmStore[key] = value;
    },
    window: {
      getComputedStyle: () => ({ position: "static" }),
      location: new URL(pageUrl),
    },
    document: {
      documentElement: {},
      querySelectorAll: () => {
        queryCalls++;
        return anchors;
      },
      createElement: () => ({ className: "", style: {}, textContent: "" }),
    },
    MutationObserver: class {
      constructor(callback) {
        observerCallback = callback;
      }
      observe() {
        observeCalls++;
      }
    },
  };
  globals.globalThis = globals;
  vm.createContext(globals);
  vm.runInContext(source, globals);

  return {
    errors,
    gmStore,
    get observeCalls() {
      return observeCalls;
    },
    get queryCalls() {
      return queryCalls;
    },
    triggerMutation() {
      observerCallback?.();
    },
    async runTimers() {
      while (true) {
        await new Promise((resolve) => setImmediate(resolve));
        const timer = timers.shift();
        if (!timer) return;
        if (!timer.cancelled) timer.callback();
      }
    },
  };
}

const okResponse = (application = null) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: { application } }),
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

async function captureUnhandled(task) {
  const unhandled = [];
  const listener = (reason) => unhandled.push(String(reason));
  process.on("unhandledRejection", listener);
  try {
    await task();
    await flush();
    return unhandled;
  } finally {
    process.off("unhandledRejection", listener);
  }
}

check(
  "metadata covers www wdlist variants",
  source.includes("// @match        https://www.wanted.co.kr/wdlist*"),
);
check(
  "metadata covers apex wdlist variants",
  source.includes("// @match        https://wanted.co.kr/wdlist*"),
);

for (const pageUrl of [
  "https://www.wanted.co.kr/wdlist",
  "https://wanted.co.kr/wdlist",
  "https://www.wanted.co.kr/wdlist/",
  "https://wanted.co.kr/wdlist/123?country=kr",
  "https://www.wanted.co.kr/wdlist?tag=frontend#jobs",
]) {
  const calls = [];
  makeSandbox({
    anchors: [makeAnchor(5)],
    fetchImpl: async (url) => {
      calls.push(url);
      return okResponse();
    },
    pageUrl,
  });
  await flush();
  check(`runtime accepts ${pageUrl}`, calls.length === 1);
  check(
    `API request is same-origin for ${pageUrl}`,
    calls[0]?.startsWith("/api/chaos/jobs/v4/5/details?ts=") === true,
  );
}

{
  const calls = [];
  const sandbox = makeSandbox({
    anchors: [makeAnchor(5)],
    fetchImpl: async (url) => {
      calls.push(url);
      return okResponse();
    },
    pageUrl: "https://www.wanted.co.kr/wdlisting?tag=frontend#jobs",
  });
  await flush();
  check("runtime rejects non-wdlist prefix", calls.length === 0);
  check("rejected path skips DOM scan", sandbox.queryCalls === 0);
  check("rejected path skips observer", sandbox.observeCalls === 0);
}

// Given three occupied slots and two cards for a fourth job, when the slot
// opens, then the fourth job is requested once and both cards share it.
{
  const calls = [];
  const pending = [];
  const anchors = [1, 2, 3, 4, 4].map(makeAnchor);
  makeSandbox({
    anchors,
    fetchImpl: (url) => {
      calls.push(Number(url.match(/v4\/(\d+)/)?.[1]));
      return new Promise((resolve) => pending.push(resolve));
    },
  });
  await flush();
  pending.shift()(okResponse());
  await flush();
  pending.at(-1)(okResponse({ status_text: "서류 접수" }));
  await flush();
  check(
    "queued duplicate job fetched once",
    calls.filter((jobId) => jobId === 4).length === 1,
  );
  check(
    "queued duplicate cards share applied result",
    anchors[3].badgeText?.includes("지원완료") &&
      anchors[4].badgeText?.includes("지원완료"),
  );
}

// Given one transient rejection, when the bounded retry succeeds, then the
// card is marked without an unhandled rejection.
{
  const calls = [];
  const anchor = makeAnchor(10);
  let attempt = 0;
  const unhandled = await captureUnhandled(async () => {
    const sandbox = makeSandbox({
      anchors: [anchor],
      fetchImpl: async (url) => {
        calls.push(url);
        attempt++;
        if (attempt === 1) throw new Error("temporary failure");
        return okResponse({ status_text: "서류 접수" });
      },
    });
    await flush();
    await sandbox.runTimers();
    await flush();
  });
  check("transient failure retried", calls.length === 2);
  check("retry marks applied anchor", anchor.badgeText?.includes("지원완료"));
  check("transient failure is handled", unhandled.length === 0);
}

// Given both bounded attempts fail, when a later DOM mutation rescans, then
// the same anchor is eligible for a fresh pair of attempts.
{
  const calls = [];
  const anchor = makeAnchor(20);
  const unhandled = await captureUnhandled(async () => {
    const sandbox = makeSandbox({
      anchors: [anchor],
      fetchImpl: async (url) => {
        calls.push(url);
        throw new Error("persistent failure");
      },
    });
    await flush();
    await sandbox.runTimers();
    sandbox.triggerMutation();
    await sandbox.runTimers();
    await flush();
  });
  check("failed anchor becomes rescan eligible", calls.length === 4);
  check("final failure is handled", unhandled.length === 0);
}

if (failures > 0) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall green");
