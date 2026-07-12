import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const DIST = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "gemini-chat-exporter.user.js",
);
const src = readFileSync(DIST, "utf8");

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}`);
  }
}

// A fixture DOM node with just enough surface for the extractor.
function node({ text = "", query = {}, queryAll = {} } = {}) {
  return {
    textContent: text,
    querySelector: (sel) => query[sel] ?? null,
    querySelectorAll: (sel) => queryAll[sel] ?? [],
  };
}

function makeSandbox({ pathname, title, turns, settings }) {
  let lastBlob = null;
  let resolveDownload;
  const downloaded = new Promise((r) => (resolveDownload = r));
  const bodyChildren = [];
  const el = (tag) => {
    const e = {
      tagName: tag,
      _on: {},
      children: [],
      style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener(t, cb) {
        this._on[t] = cb;
      },
      appendChild(c) {
        this.children.push(c);
      },
      remove() {},
      click() {
        if (this.tagName === "a")
          resolveDownload({ name: this.download, blob: lastBlob });
      },
    };
    return e;
  };
  const turnNodes = turns.map((t) =>
    node({
      query: {
        ".query-text": node({ text: t.prompt }),
        ".markdown": node({ text: t.response }),
        "thinking-overlay": t.thinking ? node({ text: t.thinking }) : null,
        ".file-preview-container": null,
      },
    }),
  );
  const gmStore = { gce_settings: settings };
  const globals = {
    window: { location: { pathname } },
    document: {
      title,
      documentElement: {},
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: (sel) =>
        sel === ".conversation-container" ? turnNodes : [],
      addEventListener: () => {},
      createElement: el,
      body: {
        appendChild(c) {
          bodyChildren.push(c);
        },
      },
    },
    MutationObserver: class {
      observe() {}
    },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    Blob: class {
      constructor(parts, opts) {
        lastBlob = { text: parts.join(""), type: opts?.type ?? "" };
      }
    },
    console,
    setTimeout: (fn) => fn && fn(),
    GM_addStyle: () => {},
    GM_getValue: (k, d) => (k in gmStore ? gmStore[k] : d),
    GM_setValue: (k, v) => {
      gmStore[k] = v;
    },
  };
  globals.globalThis = globals;
  vm.createContext(globals);
  vm.runInContext(src, globals);
  return { globals, downloaded, bodyChildren };
}

// --- Test: basic 2-turn Markdown export ---
{
  const { downloaded, bodyChildren } = makeSandbox({
    pathname: "/app/abc123",
    title: "Test chat - Google Gemini",
    settings: {
      format: "md",
      frontmatter: false,
      includeThinking: true,
      includeAttachments: true,
    },
    turns: [
      { prompt: "Hello", response: "Hi there" },
      { prompt: "Bye", response: "Goodbye" },
    ],
  });

  const btn = bodyChildren.find((c) => c.id === "__gce_export_btn");
  check("export button mounted", !!btn);
  btn._on.click();
  const { blob } = await downloaded;
  check("md has title", blob.text.includes("# Test chat"));
  check("md has user turn", blob.text.includes("Hello"));
  check("md has gemini turn", blob.text.includes("Goodbye"));
  check("md mime", blob.type.startsWith("text/markdown"));
}

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall green");
