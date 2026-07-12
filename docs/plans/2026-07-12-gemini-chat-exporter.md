# Gemini Chat Exporter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `gemini-chat-exporter/` userscript that exports gemini.google.com conversations (current one, or all) to Markdown/JSON by scraping the rendered DOM, modeled on the existing `claude-chat-exporter/`.

**Architecture:** Single-file import-free IIFE built by `vite-plugin-monkey`, running in Tampermonkey's sandboxed world (CSP-exempt). A Gemini-specific extraction seam walks `.conversation-container` DOM nodes and converts each `model-response .markdown` subtree to Markdown; the UI, settings, store-only ZIP, and download plumbing are ported near-verbatim from the Claude exporter. Tests run the built dist inside a Node stub-DOM sandbox that feeds fixture conversation markup and inspects the downloaded Blob.

**Tech Stack:** TypeScript (strict), Vite 8, vite-plugin-monkey 8, Tampermonkey GM APIs (`GM_addStyle`/`GM_getValue`/`GM_setValue`), Node's built-in test-free assertion harness (`node test/run.mjs`).

## Global Constraints

- Package manager: **pnpm only** (`pnpm@10.26.2`). Run package scripts via `pnpm --filter gemini-chat-exporter <script>` or from inside the dir.
- `src/main.ts` stays **import-free**; `vite-plugin-monkey` supplies the metadata header. Never hand-edit `dist/*.user.js`.
- **No runtime dependencies.** The store-only ZIP exists specifically to avoid a zip library — do not add one. No UI/CSS/HTTP framework.
- TypeScript **strict mode** stays on; `tsconfig.json` mirrors `claude-chat-exporter/tsconfig.json` (`noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`, etc.).
- Metadata: `@match` `https://gemini.google.com/*`, `run-at` `document-idle`, `@grant GM_addStyle, GM_getValue, GM_setValue`.
- Settings persistence key: `gce_settings`. Settings shape: `{ format: "md"|"json", frontmatter: boolean, includeThinking: boolean, includeAttachments: boolean }`.
- Korean comments/user-facing strings are intentional where present; commit messages and identifiers in English. Conventional commits, split by concern. No Co-Author lines, no `Claude-Session` trailer.
- Every commit must pass `pnpm --filter gemini-chat-exporter build` (which runs `tsc` first) and the Node harness (`pnpm --filter gemini-chat-exporter test`). The pre-commit hook runs trunk on staged files.
- Scope decisions (from the design spec `docs/plans/2026-07-12-gemini-chat-exporter-design.md`): current + all export in v1; capture text + code + tables + thinking; Deep Research immersive reports and image bytes are OUT of scope.

## Reference Alignment (pionxzh/chatgpt-exporter)

The UX target is chatgpt-exporter's "blends natively into the host UI" feel. Decisions after analyzing its dist + source:

- **Adopt — dual-persistence mount (Task 7).** chatgpt-exporter survives SPA re-renders with a node-observer **and** a low-frequency `setInterval` reconciliation loop (drops disconnected containers, re-injects). Gemini's Angular sidebar re-renders aggressively; a MutationObserver alone misses full remounts. We replicate this dependency-free: debounced observer + a 1s reconciliation interval keyed on `isConnected`.
- **Adopt — self-owned panel inside the host sidebar.** It mounts its own container as a sibling in the nav sidebar (not a floating widget). We mirror this: native trigger appended into Gemini's sidebar, with a floating pill only as fallback.
- **Adopt — date-prefixed ZIP filenames (Task 6)** and independent GM-persisted content toggles (Task 3/5), matching both its and the Claude exporter's conventions.
- **Reject — API layer + its `markdown.ts`.** It reads ChatGPT's backend JSON tree with a bearer token and builds Markdown from typed nodes (no HTML→MD library). Gemini has no such API; we own the DOM→structured step. Nothing in its exporter internals is reusable.
- **Reject — PNG/html2canvas export.** Pulls a heavy dependency, violates the single-file dependency-free constraint, and Gemini's KaTeX/code-block rendering screenshots poorly. Markdown + JSON + ZIP is the right scope.
- **Defer — user-templated filename format (`KEY_FILENAME_FORMAT`) and editable frontmatter field list (`KEY_META_LIST`).** High-utility but scope creep for v1; a fixed frontmatter block behind one `frontmatter` toggle matches the Claude exporter precedent. Note as future enhancements, not baseline.

## Selector Reference (verified live 2026-07-12)

Copy these into a `SEL` constant in Task 1; every extraction task consumes them.

```ts
const SEL = {
  turn: ".conversation-container", // one per user↔model exchange
  userQuery: "user-query",
  queryText: ".query-text", // prompt text inside user-query
  attachmentChip: ".file-preview-container", // uploaded-file chips (names only)
  modelResponse: "model-response",
  responseMarkdown: ".markdown", // rendered HTML body of the answer
  thinking: "thinking-overlay", // reasoning, collapsed by default
  scroller: "infinite-scroller.chat-history", // scroll container for the turn list
  sidebar: "bard-sidenav-container", // UI mount root (verify in Task 7)
} as const;
```

Conversation URL shape: `https://gemini.google.com/app/{id}` where `{id}` is 16 hex chars. Title: `document.title` minus the trailing `" - Google Gemini"`.

---

## File Structure

- `gemini-chat-exporter/package.json` — scripts + devDeps mirror of the Claude package.
- `gemini-chat-exporter/tsconfig.json` — copy of the Claude tsconfig.
- `gemini-chat-exporter/vite.config.ts` — monkey plugin config (metadata header).
- `gemini-chat-exporter/src/env.d.ts` — GM globals bridge (copy of Claude's).
- `gemini-chat-exporter/src/main.ts` — the whole userscript (types, settings, extraction, converter, renderers, ZIP, UI). One file, by project convention.
- `gemini-chat-exporter/test/run.mjs` — Node harness: stub DOM/GM sandbox + fixtures + assertions.
- `gemini-chat-exporter/README.md`, `gemini-chat-exporter/AGENTS.md` — docs.
- `pnpm-workspace.yaml` — add `gemini-chat-exporter` to `packages`.
- `.github/workflows/release.yml` — add `gemini-chat-exporter` to `matrix.package`.

---

## Task 1: Scaffold package + minimal end-to-end export + test harness

Establishes the whole pipeline: a built userscript that scrapes plain-text turns from a fixture DOM and downloads a basic Markdown file, plus the Node harness that drives it. Everything after this layers fidelity onto a working spine.

**Files:**

- Create: `gemini-chat-exporter/package.json`
- Create: `gemini-chat-exporter/tsconfig.json`
- Create: `gemini-chat-exporter/vite.config.ts`
- Create: `gemini-chat-exporter/src/env.d.ts`
- Create: `gemini-chat-exporter/src/main.ts`
- Create: `gemini-chat-exporter/test/run.mjs`
- Modify: `pnpm-workspace.yaml`
- Modify: `.github/workflows/release.yml:17-19`

**Interfaces:**

- Produces: `SEL` constant (see Selector Reference); `interface Turn { index: number; prompt: string; attachments: string[]; responseMarkdown: string; thinking?: string }`; `interface Conversation { id: string; title: string; url: string; turns: Turn[] }`; `interface Settings { format: "md"|"json"; frontmatter: boolean; includeThinking: boolean; includeAttachments: boolean }`; `scrapeCurrentConversation(): Conversation`; `htmlToMarkdown(root): string` (plain-text stub in this task); `toMarkdown(conv, s): string`; `exportCurrentConversation(): Promise<void>`; control id `__gce_export_btn`.

- [ ] **Step 1: Create `gemini-chat-exporter/package.json`**

```json
{
  "name": "gemini-chat-exporter",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "test": "node test/run.mjs"
  },
  "devDependencies": {
    "typescript": "~6.0.3",
    "vite": "^8.1.4",
    "vite-plugin-monkey": "^8.0.6"
  }
}
```

- [ ] **Step 2: Create `gemini-chat-exporter/tsconfig.json`** — byte-for-byte copy of `claude-chat-exporter/tsconfig.json` (read it and reproduce; it has `strict`, `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`, `moduleResolution: bundler`, `lib: ES2022/DOM/DOM.Iterable`, `include: ["src"]`).

- [ ] **Step 3: Create `gemini-chat-exporter/src/env.d.ts`** — byte-for-byte copy of `claude-chat-exporter/src/env.d.ts`:

```ts
import type {
  GmAddStyleType,
  GmGetValueType,
  GmSetValueType,
} from "vite-plugin-monkey/dist/client";

declare global {
  const GM_addStyle: GmAddStyleType;
  const GM_getValue: GmGetValueType;
  const GM_setValue: GmSetValueType;
}
```

- [ ] **Step 4: Create `gemini-chat-exporter/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";

export default defineConfig({
  plugins: [
    monkey({
      entry: "src/main.ts",
      userscript: {
        name: "Gemini Chat Exporter",
        namespace: "http://tampermonkey.net/",
        version:
          process.env["SCRIPT_VERSION"] ??
          new Date().toISOString().slice(0, 10),
        description:
          "Export gemini.google.com conversations to Markdown/JSON from the conversation page.",
        author: "Dongmin, Yu",
        match: ["https://gemini.google.com/*"],
        "run-at": "document-idle",
        // A real GM_* grant forces Tampermonkey's sandboxed world, which is
        // exempt from Gemini's strict CSP. With `@grant none` the injected
        // script is blocked by script-src and never runs.
        grant: ["GM_addStyle", "GM_getValue", "GM_setValue"],
      },
    }),
  ],
});
```

- [ ] **Step 5: Create `gemini-chat-exporter/src/main.ts`** (minimal end-to-end spine)

```ts
"use strict";

/**
 * Gemini Chat Exporter
 *
 * Exports gemini.google.com conversations to Markdown/JSON by scraping the
 * rendered DOM (Gemini exposes no clean API; its batchexecute RPC is per-build
 * obfuscated). Semantic Angular custom elements are the stable extraction seam.
 */

/** ---------- Selectors (verified live 2026-07-12) ---------- */
const SEL = {
  turn: ".conversation-container",
  userQuery: "user-query",
  queryText: ".query-text",
  attachmentChip: ".file-preview-container",
  modelResponse: "model-response",
  responseMarkdown: ".markdown",
  thinking: "thinking-overlay",
  scroller: "infinite-scroller.chat-history",
  sidebar: "bard-sidenav-container",
} as const;

/** ---------- Types ---------- */
interface Turn {
  index: number;
  prompt: string;
  attachments: string[];
  responseMarkdown: string;
  thinking?: string;
}
interface Conversation {
  id: string;
  title: string;
  url: string;
  turns: Turn[];
}

/** ---------- Settings ---------- */
type Format = "md" | "json";
interface Settings {
  format: Format;
  frontmatter: boolean;
  includeThinking: boolean;
  includeAttachments: boolean;
}
const SETTINGS_KEY = "gce_settings";
const DEFAULT_SETTINGS: Settings = {
  format: "md",
  frontmatter: true,
  includeThinking: true,
  includeAttachments: true,
};
function loadSettings(): Settings {
  try {
    const raw = GM_getValue<Partial<Settings>>(SETTINGS_KEY, {});
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings(s: Settings): void {
  GM_setValue(SETTINGS_KEY, s);
}
let settings: Settings = loadSettings();

/** ---------- Conversation id / title ---------- */
function getConversationId(): string | null {
  const m = window.location.pathname.match(/\/app\/([0-9a-f]+)/i);
  return m ? m[1] : null;
}
function getTitle(): string {
  return (
    document.title.replace(/\s*-\s*Google Gemini\s*$/, "").trim() ||
    "Gemini conversation"
  );
}

/** ---------- HTML -> Markdown (plain-text stub; fidelity in Task 2) ---------- */
function htmlToMarkdown(root: Element | null): string {
  return (root?.textContent ?? "").trim();
}

/** ---------- Extraction ---------- */
function scrapeCurrentConversation(): Conversation {
  const id = getConversationId() ?? "";
  const turns: Turn[] = [];
  const containers = document.querySelectorAll(SEL.turn);
  containers.forEach((c, i) => {
    const prompt = (c.querySelector(SEL.queryText)?.textContent ?? "").trim();
    const responseMarkdown = htmlToMarkdown(
      c.querySelector(SEL.responseMarkdown),
    );
    if (!prompt && !responseMarkdown) return;
    turns.push({ index: i, prompt, attachments: [], responseMarkdown });
  });
  return {
    id,
    title: getTitle(),
    url: `https://gemini.google.com/app/${id}`,
    turns,
  };
}

/** ---------- Markdown renderer ---------- */
function toMarkdown(conv: Conversation, _s: Settings): string {
  const out: string[] = [`# ${conv.title}`, ""];
  for (const t of conv.turns) {
    if (t.prompt) out.push("## 👤 User", "", t.prompt, "");
    if (t.responseMarkdown) out.push("## ✦ Gemini", "", t.responseMarkdown, "");
  }
  return out.join("\n");
}

/** ---------- Render dispatch ---------- */
function renderConversation(
  conv: Conversation,
  s: Settings,
): { text: string; extension: string; mime: string } {
  return {
    text: toMarkdown(conv, s),
    extension: "md",
    mime: "text/markdown;charset=utf-8",
  };
}

/** ---------- Filenames ---------- */
function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[/\\?%*:|"<>]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "gemini-conversation"
  );
}

/** ---------- Download ---------- */
function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** ---------- Export flow ---------- */
async function exportCurrentConversation(): Promise<void> {
  const conv = scrapeCurrentConversation();
  if (!conv.turns.length) throw new Error("No conversation turns found.");
  const { text, extension, mime } = renderConversation(conv, settings);
  downloadBlob(
    `${sanitizeFilename(conv.title)}.${extension}`,
    new Blob([text], { type: mime }),
  );
}

/** ---------- Minimal UI (replaced in Task 7) ---------- */
const ONE_ID = "__gce_export_btn";
function mountUI(): void {
  if (document.getElementById(ONE_ID)) return;
  const btn = document.createElement("button");
  btn.id = ONE_ID;
  btn.type = "button";
  btn.textContent = "⬇ Export";
  btn.addEventListener("click", () => {
    void exportCurrentConversation();
  });
  document.body.appendChild(btn);
}
mountUI();

// Keep TS from flagging currently-unused settings plumbing (wired up in Task 5).
void saveSettings;
```

- [ ] **Step 6: Register the package in `pnpm-workspace.yaml`** — add the third list item under `packages:`:

```yaml
packages:
  - wanted-applied-marker
  - claude-chat-exporter
  - gemini-chat-exporter
```

- [ ] **Step 7: Register in `.github/workflows/release.yml`** — add to the `matrix.package` list (currently lines 17-19):

```yaml
package:
  - wanted-applied-marker
  - claude-chat-exporter
  - gemini-chat-exporter
```

- [ ] **Step 8: Install + first build**

Run: `cd gemini-chat-exporter && pnpm install && pnpm build`
Expected: `tsc` passes, `dist/gemini-chat-exporter.user.js` created with a `// ==UserScript==` header containing `@match https://gemini.google.com/*`.

- [ ] **Step 9: Write the failing test harness** — Create `gemini-chat-exporter/test/run.mjs`. Model it on `claude-chat-exporter/test/run.mjs` but replace the fetch-based sandbox with a DOM-node sandbox. The sandbox must implement enough of the DOM for the built IIFE: `document.querySelectorAll(selector)` returns fixture turn nodes; each node supports `.querySelector(sel)` and exposes `.textContent`; `document.createElement` returns stub elements collected into `allEls`; clicking the download anchor resolves a promise with the Blob. Assert the exported Markdown from a 2-turn fixture.

```js
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
      body: { appendChild() {} },
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
  return { globals, downloaded };
}

// --- Test: basic 2-turn Markdown export ---
{
  const { globals, downloaded } = makeSandbox({
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
  // Find the export button among created elements is unnecessary; call via the
  // registered click handler on the body button. Simpler: the IIFE created the
  // button and attached a click handler. Re-create the flow by invoking export
  // through the button handler captured on document.body's appended child.
  // For this harness, expose export by clicking the mounted button:
  const bodyBtn = globals.__gceTestButton; // set below via a hook if needed
  // Fallback: drive by locating the button handler is out of scope here; assert
  // the download fires when we trigger it.
  check("placeholder — see Step 10 for wiring", true);
  void downloaded;
  void bodyBtn;
}

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall green");
```

- [ ] **Step 10: Make the harness drive the export button, then assert output.** The built IIFE appends the export button to `document.body`. Capture appended children so the test can click the button. Replace `body: { appendChild() {} }` with a version that records children, find the element whose `id === "__gce_export_btn"`, invoke `el._on.click()`, await `downloaded`, and assert:

```js
// in makeSandbox globals.document.body:
const bodyChildren = [];
// body: { appendChild(c) { bodyChildren.push(c); } },
// expose: return { globals, downloaded, bodyChildren };

// in the test:
const btn = bodyChildren.find((c) => c.id === "__gce_export_btn");
check("export button mounted", !!btn);
btn._on.click();
const { blob } = await downloaded;
check("md has title", blob.text.includes("# Test chat"));
check("md has user turn", blob.text.includes("Hello"));
check("md has gemini turn", blob.text.includes("Goodbye"));
check("md mime", blob.type.startsWith("text/markdown"));
```

Wire the `id` onto stub elements: in `el(tag)`, add `set id(v){this._id=v;} get id(){return this._id;}` or simply allow `e.id = ...` assignment (plain property works since the stub is a plain object). Ensure `createElement` stubs accept arbitrary property assignment (they do, as plain objects).

- [ ] **Step 11: Run the harness and verify it passes**

Run: `cd gemini-chat-exporter && pnpm build && pnpm test`
Expected: `all green`, including `export button mounted`, `md has title`, `md has user turn`, `md has gemini turn`, `md mime`.

- [ ] **Step 12: Verify monorepo-wide test picks it up**

Run: `cd .. && pnpm -r test`
Expected: both `claude-chat-exporter` and `gemini-chat-exporter` harnesses run and pass.

- [ ] **Step 13: Commit**

```bash
git add gemini-chat-exporter pnpm-workspace.yaml pnpm-lock.yaml .github/workflows/release.yml
git commit -m "feat(gemini-chat-exporter): scaffold DOM-scraping exporter with end-to-end MD export"
```

---

## Task 2: HTML→Markdown converter fidelity

Replace the plain-text `htmlToMarkdown` stub with a dependency-free converter that walks the `.markdown` subtree and emits Markdown for paragraphs, headings, lists, code blocks, tables, links, and emphasis. This is the core new algorithm and the piece with the most edge cases.

**Files:**

- Modify: `gemini-chat-exporter/src/main.ts` (replace `htmlToMarkdown`)
- Modify: `gemini-chat-exporter/test/run.mjs` (richer fixture nodes + assertions)

**Interfaces:**

- Consumes: `Element`-like nodes with `.nodeType`, `.nodeName`, `.textContent`, `.childNodes`, `.getAttribute(name)`, `.classList` (for code language). The test sandbox's fixture nodes must now expose these.
- Produces: `htmlToMarkdown(root: Element | null): string` returning multi-line Markdown.

- [ ] **Step 1: Write failing tests** for each supported structure. Add fixture nodes that model real DOM (element nodes have `nodeType===1`, text nodes `nodeType===3`). Add a fixture builder to `run.mjs`:

```js
// Element/text node fixtures for the HTML->MD converter.
function textNode(s) {
  return { nodeType: 3, textContent: s, childNodes: [] };
}
function elNode(name, children = [], attrs = {}) {
  return {
    nodeType: 1,
    nodeName: name.toUpperCase(),
    childNodes: children,
    getAttribute: (k) => attrs[k] ?? null,
    classList: { contains: (c) => (attrs.class ?? "").split(" ").includes(c) },
    get textContent() {
      return children.map((c) => c.textContent).join("");
    },
  };
}
```

Assertions (new sandbox test that passes a fixture `.markdown` root and reads exported MD):

````js
// .markdown containing: <p>, <h2>, <ul><li>, <pre><code class="language-js">, <table>
const md = elNode("div", [
  elNode("h2", [textNode("Heading")]),
  elNode("p", [
    textNode("A "),
    elNode("strong", [textNode("bold")]),
    textNode(" word."),
  ]),
  elNode("ul", [
    elNode("li", [textNode("one")]),
    elNode("li", [textNode("two")]),
  ]),
  elNode("pre", [
    elNode("code", [textNode("const x = 1;")], { class: "language-js" }),
  ]),
  elNode("p", [elNode("a", [textNode("link")], { href: "https://x.dev" })]),
]);
// drive an export whose single turn's .markdown === md, then:
check("h2 -> ##", out.includes("## Heading"));
check("bold -> **", out.includes("**bold**"));
check("ul -> - ", out.includes("- one") && out.includes("- two"));
check(
  "code fence + lang",
  out.includes("```js") && out.includes("const x = 1;"),
);
check("link -> []()", out.includes("[link](https://x.dev)"));
````

Run: `pnpm build && pnpm test` → Expected: the new checks FAIL (stub returns plain text).

- [ ] **Step 2: Implement the converter** — replace `htmlToMarkdown` in `main.ts`:

```ts
/** ---------- HTML -> Markdown (dependency-free) ---------- */
const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "SECTION",
  "ARTICLE",
  "UL",
  "OL",
  "PRE",
  "TABLE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
]);

function codeLang(code: Element): string {
  const cls = code.getAttribute("class") ?? "";
  const m = cls.match(/language-([\w+-]+)/);
  return m ? m[1] : "";
}

function inlineMd(node: Node): string {
  if (node.nodeType === 3 /* text */) return node.textContent ?? "";
  if (node.nodeType !== 1 /* element */) return "";
  const el = node as Element;
  const inner = childrenInline(el);
  switch (el.nodeName) {
    case "STRONG":
    case "B":
      return `**${inner}**`;
    case "EM":
    case "I":
      return `*${inner}*`;
    case "CODE":
      return `\`${inner}\``;
    case "A": {
      const href = el.getAttribute("href") ?? "";
      return href ? `[${inner}](${href})` : inner;
    }
    case "BR":
      return "\n";
    default:
      return inner;
  }
}

function childrenInline(el: Element): string {
  let s = "";
  el.childNodes.forEach((c) => {
    s += inlineMd(c);
  });
  return s;
}

function listMd(el: Element, ordered: boolean): string {
  const lines: string[] = [];
  let n = 1;
  el.childNodes.forEach((c) => {
    if (c.nodeType === 1 && (c as Element).nodeName === "LI") {
      const marker = ordered ? `${n++}.` : "-";
      lines.push(`${marker} ${childrenInline(c as Element).trim()}`);
    }
  });
  return lines.join("\n");
}

function tableMd(el: Element): string {
  const rows: string[][] = [];
  const trList = el.querySelectorAll("tr");
  trList.forEach((tr) => {
    const cells: string[] = [];
    tr.childNodes.forEach((cell) => {
      if (
        cell.nodeType === 1 &&
        ((cell as Element).nodeName === "TD" ||
          (cell as Element).nodeName === "TH")
      )
        cells.push(
          childrenInline(cell as Element)
            .trim()
            .replace(/\|/g, "\\|"),
        );
    });
    if (cells.length) rows.push(cells);
  });
  if (!rows.length) return "";
  const width = rows[0].length;
  const header = `| ${rows[0].join(" | ")} |`;
  const sep = `| ${Array(width).fill("---").join(" | ")} |`;
  const body = rows
    .slice(1)
    .map((r) => `| ${r.join(" | ")} |`)
    .join("\n");
  return [header, sep, body].filter(Boolean).join("\n");
}

function blockMd(el: Element): string {
  switch (el.nodeName) {
    case "H1":
      return `# ${childrenInline(el).trim()}`;
    case "H2":
      return `## ${childrenInline(el).trim()}`;
    case "H3":
      return `### ${childrenInline(el).trim()}`;
    case "H4":
      return `#### ${childrenInline(el).trim()}`;
    case "H5":
      return `##### ${childrenInline(el).trim()}`;
    case "H6":
      return `###### ${childrenInline(el).trim()}`;
    case "UL":
      return listMd(el, false);
    case "OL":
      return listMd(el, true);
    case "TABLE":
      return tableMd(el);
    case "BLOCKQUOTE":
      return childrenInline(el)
        .trim()
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "PRE": {
      const code = el.querySelector("code");
      const lang = code ? codeLang(code) : "";
      const body = (code ?? el).textContent ?? "";
      return `\`\`\`${lang}\n${body.replace(/\n$/, "")}\n\`\`\``;
    }
    case "P":
    default:
      return childrenInline(el).trim();
  }
}

function htmlToMarkdown(root: Element | null): string {
  if (!root) return "";
  const blocks: string[] = [];
  root.childNodes.forEach((node) => {
    if (node.nodeType === 3) {
      const t = (node.textContent ?? "").trim();
      if (t) blocks.push(t);
    } else if (node.nodeType === 1) {
      const el = node as Element;
      if (BLOCK_TAGS.has(el.nodeName)) blocks.push(blockMd(el));
      else {
        const inline = inlineMd(el).trim();
        if (inline) blocks.push(inline);
      }
    }
  });
  return blocks.filter(Boolean).join("\n\n").trim();
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm build && pnpm test`
Expected: all fidelity checks PASS (`h2 -> ##`, `bold -> **`, `ul -> - `, `code fence + lang`, `link -> []()`), plus Task 1 checks still green.

- [ ] **Step 4: Add nested-list + table assertions** (edge cases the converter must not crash on): a `<ul>` with a nested `<ul>`, and a 2-row `<table>` with a header. Assert output contains the table separator row `| --- |` and both data rows. Fix `listMd`/`tableMd` if they fail.

Run: `pnpm build && pnpm test` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gemini-chat-exporter/src/main.ts gemini-chat-exporter/test/run.mjs
git commit -m "feat(gemini-chat-exporter): dependency-free HTML→Markdown converter"
```

---

## Task 3: Thinking + attachments capture

Capture `thinking-overlay` reasoning text (gated by `includeThinking`) and attachment chip names (gated by `includeAttachments`) into each `Turn`, and render them.

**Files:**

- Modify: `gemini-chat-exporter/src/main.ts` (`scrapeCurrentConversation`, `toMarkdown`, add `expandCollapsed`)
- Modify: `gemini-chat-exporter/test/run.mjs`

**Interfaces:**

- Consumes: `Turn.thinking`, `Turn.attachments` (already in the type).
- Produces: `expandCollapsed(container: Element): void`; `scrapeCurrentConversation` now fills `thinking`/`attachments`; `toMarkdown` emits a `🧠 Thinking` details block and an attachments list per settings.

- [ ] **Step 1: Write failing tests** — fixture turn with `thinking-overlay` text and a `.file-preview-container` whose `textContent` is a filename. Assert:

```js
// settings.includeThinking = true, includeAttachments = true
check(
  "thinking captured",
  out.includes("Thinking") && out.includes("reasoning step"),
);
check("attachment name listed", out.includes("report.pdf"));
// second sandbox with includeThinking=false:
check("thinking omitted when off", !outOff.includes("reasoning step"));
```

The fixture `.conversation-container` `querySelector` must return the thinking node for `"thinking-overlay"` and the attachment node for `".file-preview-container"`; add `querySelectorAll(".file-preview-container")` support for multiple chips.

Run: `pnpm build && pnpm test` → Expected: FAIL.

- [ ] **Step 2: Implement capture** — in `main.ts`, add `expandCollapsed` and extend `scrapeCurrentConversation`:

```ts
// Gemini collapses reasoning behind a toggle; expand before reading so the
// text is in the DOM. Best-effort: click a control if the overlay is collapsed.
function expandCollapsed(container: Element): void {
  const overlay = container.querySelector(SEL.thinking);
  if (!overlay) return;
  const btn = overlay.querySelector("button, [role='button']");
  const expanded = overlay.getAttribute("aria-expanded");
  if (btn && expanded !== "true") (btn as HTMLElement).click();
}
```

Extend the `containers.forEach` body in `scrapeCurrentConversation`:

```ts
if (settings.includeThinking) expandCollapsed(c);
const thinking = settings.includeThinking
  ? (c.querySelector(SEL.thinking)?.textContent ?? "").trim()
  : "";
const attachments = settings.includeAttachments
  ? Array.from(c.querySelectorAll(SEL.attachmentChip))
      .map((a) => (a.textContent ?? "").trim())
      .filter(Boolean)
  : [];
if (!prompt && !responseMarkdown && !thinking && !attachments.length) return;
const turn: Turn = { index: i, prompt, attachments, responseMarkdown };
if (thinking) turn.thinking = thinking;
turns.push(turn);
```

(Remove the old `turns.push({...})`; keep the early-return guard updated as above.)

- [ ] **Step 3: Render thinking + attachments** — update `toMarkdown`:

```ts
function toMarkdown(conv: Conversation, s: Settings): string {
  const out: string[] = [];
  if (s.frontmatter) {
    out.push(
      "---",
      `title: "${conv.title.replace(/"/g, '\\"')}"`,
      `source: "${conv.url}"`,
      `date: ${new Date().toISOString().slice(0, 10)}`,
      "---",
      "",
    );
  }
  out.push(`# ${conv.title}`, "");
  for (const t of conv.turns) {
    if (t.prompt) {
      out.push("## 👤 User", "");
      if (s.includeAttachments && t.attachments.length)
        out.push(...t.attachments.map((a) => `> 📎 ${a}`), "");
      out.push(t.prompt, "");
    }
    if (t.responseMarkdown || t.thinking) {
      out.push("## ✦ Gemini", "");
      if (s.includeThinking && t.thinking)
        out.push(
          `<details><summary>🧠 Thinking</summary>\n\n${t.thinking}\n\n</details>`,
          "",
        );
      if (t.responseMarkdown) out.push(t.responseMarkdown, "");
    }
  }
  return out.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm build && pnpm test`
Expected: `thinking captured`, `attachment name listed`, `thinking omitted when off` all PASS.

- [ ] **Step 5: Commit**

```bash
git add gemini-chat-exporter/src/main.ts gemini-chat-exporter/test/run.mjs
git commit -m "feat(gemini-chat-exporter): capture thinking + attachment names"
```

---

## Task 4: Completeness — load all turns before scraping

Long conversations lazy-load older turns into `infinite-scroller.chat-history`. Add `ensureAllTurnsLoaded` that scrolls to top until the turn count stabilizes, accumulating turns into a `Map` keyed by turn identity so the result is correct whether or not Gemini recycles DOM nodes.

**Files:**

- Modify: `gemini-chat-exporter/src/main.ts` (`scrapeCurrentConversation` becomes async; add `ensureAllTurnsLoaded`, `turnKey`)
- Modify: `gemini-chat-exporter/test/run.mjs` (mock scroller that reveals turns across passes)

**Interfaces:**

- Produces: `turnKey(prompt: string, ordinal: number): string`; `ensureAllTurnsLoaded(): Promise<void>`; `scrapeCurrentConversation(): Promise<Conversation>` (now async, accumulates via Map). `exportCurrentConversation` awaits it.

- [ ] **Step 1: Write failing test** — a mock scroller sandbox where `querySelectorAll(".conversation-container")` returns only the last 2 turns initially, and after each `scrollTop = 0` reveals 2 more (simulating upward lazy-load), up to 6 total. Assert the export contains all 6 turns' prompts. Requires the sandbox to model `SEL.scroller` node with `scrollTop`/`scrollHeight` and a `querySelectorAll` whose return grows when `scrollTop` is set to 0.

```js
// reveal schedule: pass0 -> turns[4..5], pass1 -> [2..5], pass2 -> [0..5], stable
check(
  "all 6 turns exported",
  ["q0", "q1", "q2", "q3", "q4", "q5"].every((q) => out.includes(q)),
);
```

Run: `pnpm build && pnpm test` → Expected: FAIL (only last 2 turns exported).

- [ ] **Step 2: Implement completeness** — in `main.ts`:

```ts
function turnKey(prompt: string, ordinal: number): string {
  // Prompt text + ordinal is stable across re-render; enough to dedupe turns
  // whether nodes persist or recycle.
  return `${ordinal}::${prompt.slice(0, 80)}`;
}

async function ensureAllTurnsLoaded(): Promise<void> {
  const scroller = document.querySelector(SEL.scroller);
  if (!scroller) return;
  let prev = -1;
  let stable = 0;
  // Loop until the turn count is unchanged across two consecutive passes.
  for (let i = 0; i < 60 && stable < 2; i++) {
    const count = document.querySelectorAll(SEL.turn).length;
    stable = count === prev ? stable + 1 : 0;
    prev = count;
    scroller.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 400));
  }
}
```

Rewrite `scrapeCurrentConversation` to be async and accumulate:

```ts
async function scrapeCurrentConversation(): Promise<Conversation> {
  const id = getConversationId() ?? "";
  await ensureAllTurnsLoaded();
  const byKey = new Map<string, Turn>();
  let ordinal = 0;
  const collect = (): void => {
    document.querySelectorAll(SEL.turn).forEach((c) => {
      const prompt = (c.querySelector(SEL.queryText)?.textContent ?? "").trim();
      const responseMarkdown = htmlToMarkdown(
        c.querySelector(SEL.responseMarkdown),
      );
      if (settings.includeThinking) expandCollapsed(c);
      const thinking = settings.includeThinking
        ? (c.querySelector(SEL.thinking)?.textContent ?? "").trim()
        : "";
      const attachments = settings.includeAttachments
        ? Array.from(c.querySelectorAll(SEL.attachmentChip))
            .map((a) => (a.textContent ?? "").trim())
            .filter(Boolean)
        : [];
      if (!prompt && !responseMarkdown && !thinking && !attachments.length)
        return;
      const key = turnKey(prompt, ordinal++);
      if (byKey.has(key)) return;
      const turn: Turn = {
        index: byKey.size,
        prompt,
        attachments,
        responseMarkdown,
      };
      if (thinking) turn.thinking = thinking;
      byKey.set(key, turn);
    });
  };
  collect();
  return {
    id,
    title: getTitle(),
    url: `https://gemini.google.com/app/${id}`,
    turns: Array.from(byKey.values()),
  };
}
```

Note: `ordinal` counts document-order position each `collect()` pass; because a single pass after `ensureAllTurnsLoaded` sees the full, in-order list, keys are unique per turn. (The Map guards against a future incremental-collect variant.)

Update `exportCurrentConversation` to `const conv = await scrapeCurrentConversation();`.

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm build && pnpm test`
Expected: `all 6 turns exported` PASS, prior checks still green. In the mock, `setTimeout` runs synchronously (sandbox `setTimeout: (fn) => fn && fn()`), so the scroll loop resolves immediately; ensure the mock's `querySelectorAll` returns the full set once `scrollTop` has been set to 0 enough times.

- [ ] **Step 4: Commit**

```bash
git add gemini-chat-exporter/src/main.ts gemini-chat-exporter/test/run.mjs
git commit -m "feat(gemini-chat-exporter): load all turns before scraping (virtualization-safe)"
```

---

## Task 5: JSON renderer + settings modal

Add the JSON format and the settings modal (segmented format control + switches), reusing the Claude exporter's modal structure and CSS. Persist settings under `gce_settings`. Wire real inputs with stable ids so the harness can drive them.

**Files:**

- Modify: `gemini-chat-exporter/src/main.ts` (add `toJSON`, `renderConversation` dispatch, GM_addStyle block, modal, `elc`, `swRow`)
- Modify: `gemini-chat-exporter/test/run.mjs` (JSON-format assertions)

**Interfaces:**

- Produces: `toJSON(conv, s): string`; control ids `__gce_fmt_md`, `__gce_fmt_json`, `__gce_frontmatter`, `__gce_thinking`, `__gce_attachments`; action id `__gce_export_btn`, `__gce_export_all_btn` (all-button wired in Task 6); modal id `__gce_modal`.

- [ ] **Step 1: Write failing test** — sandbox with `settings.format = "json"`; drive export; assert the Blob is valid JSON with `title`, `turns[]` each having `prompt`/`response`/optional `thinking`.

```js
const data = JSON.parse(blob.text);
check("json has title", data.title === "Test chat");
check("json turns", Array.isArray(data.turns) && data.turns.length === 2);
check("json prompt", data.turns[0].prompt === "Hello");
check("json mime", blob.type.startsWith("application/json"));
```

Run: `pnpm build && pnpm test` → Expected: FAIL (only MD implemented).

- [ ] **Step 2: Implement `toJSON` + dispatch** — in `main.ts`:

```ts
interface JsonTurn {
  prompt: string;
  response: string;
  thinking?: string;
  attachments?: string[];
}
function toJSON(conv: Conversation, s: Settings): string {
  const turns: JsonTurn[] = conv.turns.map((t) => {
    const jt: JsonTurn = { prompt: t.prompt, response: t.responseMarkdown };
    if (s.includeThinking && t.thinking) jt.thinking = t.thinking;
    if (s.includeAttachments && t.attachments.length)
      jt.attachments = t.attachments;
    return jt;
  });
  return JSON.stringify(
    {
      title: conv.title,
      source: conv.url,
      exported_at: new Date().toISOString(),
      turns,
    },
    null,
    2,
  );
}
```

Replace `renderConversation`:

```ts
function renderConversation(
  conv: Conversation,
  s: Settings,
): { text: string; extension: string; mime: string } {
  if (s.format === "json")
    return {
      text: toJSON(conv, s),
      extension: "json",
      mime: "application/json;charset=utf-8",
    };
  return {
    text: toMarkdown(conv, s),
    extension: "md",
    mime: "text/markdown;charset=utf-8",
  };
}
```

- [ ] **Step 3: Run the JSON test to verify it passes**

Run: `pnpm build && pnpm test` → Expected: JSON checks PASS.

- [ ] **Step 4: Add the settings modal.** Port the modal from `claude-chat-exporter/src/main.ts:825-1083` with these deltas: rename ids `cce_`→`gce_`, `MODAL_ID = "__gce_modal"`; drop the `messageTimestamps` and `includeToolCalls` rows and the `mdOnlyRows`/`syncMdOnly` timestamp handling (keep `frontmatter` as the only md-only row); `swRow`'s key type is `Exclude<keyof Settings, "format">`; format radios use ids `__gce_fmt_md`/`__gce_fmt_json`; switches use `__gce_frontmatter`, `__gce_thinking`, `__gce_attachments`. Copy the `elc`, `runExport`, `setProgress`, `openModal`, `closeModal`, `swRow`, `buildModal` helpers verbatim (adjusting ids/labels). Copy the `GM_addStyle` CSS block from `:825-899` but replace Claude theme vars with Gemini-safe fallbacks (see Step 5).

Add these constants near the UI section:

```ts
const ALL_ID = "__gce_export_all_btn";
const ONE_LABEL = "⬇ Export this chat";
const ALL_LABEL = "⬇ Export all";
const MODAL_ID = "__gce_modal";
const TRIGGER_ID = "__gce_export_trigger";
```

- [ ] **Step 5: Use Gemini-safe theme colors in the `GM_addStyle` block.** Gemini does not expose Claude's `--bg-*`/`--text-*`/`--cds-clay` custom properties. Use Material-style values with `prefers-color-scheme` for dark mode instead of `hsl(var(--...))`:

```ts
GM_addStyle(`
  #${MODAL_ID} { position: fixed; inset: 0; z-index: 2147483647; display: none; }
  #${MODAL_ID}.open { display: block; }
  #${MODAL_ID} .gce-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.5); }
  #${MODAL_ID} .gce-panel {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
    width: min(420px, calc(100vw - 32px)); max-height: calc(100vh - 64px); overflow-y: auto;
    background: #fff; color: #1f1f1f; border: 1px solid #dadce0; border-radius: 12px;
    box-shadow: 0 12px 48px rgba(0,0,0,.3); padding: 20px; font: 400 14px/1.4 "Google Sans", system-ui, sans-serif;
  }
  #${MODAL_ID} .gce-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
  #${MODAL_ID} .gce-title { font-size:16px; font-weight:600; }
  #${MODAL_ID} .gce-x { border:none; background:transparent; cursor:pointer; font-size:20px; color:#5f6368; padding:4px; border-radius:6px; }
  #${MODAL_ID} .gce-section { margin-bottom:16px; }
  #${MODAL_ID} .gce-seg { display:flex; gap:4px; padding:3px; background:#f1f3f4; border-radius:8px; }
  #${MODAL_ID} .gce-seg input { position:absolute; opacity:0; pointer-events:none; }
  #${MODAL_ID} .gce-seg label { flex:1; text-align:center; padding:6px 0; border-radius:6px; cursor:pointer; color:#5f6368; }
  #${MODAL_ID} .gce-seg input:checked + label { background:#fff; color:#1f1f1f; box-shadow:0 1px 2px rgba(0,0,0,.1); }
  #${MODAL_ID} .gce-row { display:flex; align-items:center; justify-content:space-between; padding:6px 0; }
  #${MODAL_ID} .gce-row.gce-disabled { opacity:.4; pointer-events:none; }
  #${MODAL_ID} .gce-sw { position:relative; width:36px; height:20px; flex:0 0 auto; }
  #${MODAL_ID} .gce-sw input { position:absolute; opacity:0; width:100%; height:100%; margin:0; cursor:pointer; }
  #${MODAL_ID} .gce-sw .gce-track { position:absolute; inset:0; background:#bdc1c6; border-radius:999px; transition:background .15s; }
  #${MODAL_ID} .gce-sw .gce-track::after { content:""; position:absolute; top:2px; left:2px; width:16px; height:16px; background:#fff; border-radius:50%; transition:transform .15s; }
  #${MODAL_ID} .gce-sw input:checked + .gce-track { background:#1a73e8; }
  #${MODAL_ID} .gce-sw input:checked + .gce-track::after { transform:translateX(16px); }
  #${MODAL_ID} .gce-actions { display:flex; gap:8px; margin-top:8px; }
  #${MODAL_ID} .gce-btn { flex:1; padding:10px; border:none; border-radius:8px; cursor:pointer; font-weight:600; font-size:14px; }
  #${MODAL_ID} .gce-btn:disabled { opacity:.6; cursor:default; }
  #${MODAL_ID} .gce-primary { background:#1a73e8; color:#fff; }
  #${MODAL_ID} .gce-secondary { background:#f1f3f4; color:#1f1f1f; }
  #${MODAL_ID} .gce-progress { margin-top:10px; min-height:18px; font-size:13px; color:#5f6368; text-align:center; }
  #${TRIGGER_ID} { display:flex; align-items:center; gap:8px; width:calc(100% - 16px); margin:0 8px; height:40px; padding:0 12px; border:none; background:transparent; cursor:pointer; font:400 14px/1 "Google Sans", system-ui, sans-serif; color:#444746; border-radius:999px; text-align:left; }
  #${TRIGGER_ID}:hover { background:rgba(0,0,0,.06); }
  #${TRIGGER_ID}.gce-floating { position:fixed; bottom:20px; right:20px; z-index:2147483646; width:auto; height:auto; padding:10px 16px; margin:0; background:#1a73e8; color:#fff; font-weight:600; border-radius:999px; box-shadow:0 2px 8px rgba(0,0,0,.25); }
  @media (prefers-color-scheme: dark) {
    #${MODAL_ID} .gce-panel { background:#1e1f20; color:#e3e3e3; border-color:#444746; }
    #${MODAL_ID} .gce-seg { background:#2d2e30; }
    #${MODAL_ID} .gce-seg input:checked + label { background:#131314; color:#e3e3e3; }
    #${MODAL_ID} .gce-secondary { background:#2d2e30; color:#e3e3e3; }
    #${TRIGGER_ID} { color:#c4c7c5; }
    #${TRIGGER_ID}:hover { background:rgba(255,255,255,.08); }
  }
`);
```

- [ ] **Step 6: Write a failing test that drives settings controls** — after mounting, find `__gce_fmt_json` among created elements, invoke its `change` handler, assert `GM_getValue("gce_settings").format === "json"`. The sandbox must let `createElement` stubs register `change` handlers and expose them (the Claude harness already does this pattern). Add a `querySelector`/`getElementById` that returns the mounted modal so `openModal` works, or drive the input handler directly from the captured element list.

```js
const fmtJson = createdEls.find((e) => e._id === "__gce_fmt_json");
check("json radio exists", !!fmtJson);
fmtJson.checked = true;
fmtJson._on.change();
check("format persisted", gmStore.gce_settings.format === "json");
```

Run: `pnpm build && pnpm test` → Expected: FAIL until Step 4/5 modal is wired.

- [ ] **Step 7: Run all tests to verify they pass**

Run: `pnpm build && pnpm test` → Expected: all green (MD, JSON, converter, thinking, completeness, settings-persist).

- [ ] **Step 8: Commit**

```bash
git add gemini-chat-exporter/src/main.ts gemini-chat-exporter/test/run.mjs
git commit -m "feat(gemini-chat-exporter): JSON format + settings modal"
```

---

## Task 6: Store-only ZIP + Export-All orchestrator

Port the dependency-free ZIP and add Export-All: enumerate conversation ids from the sidebar, then serially navigate to each, load all turns, scrape, and pack into a ZIP. Enumeration has a defined fallback because Gemini's sidebar is router-driven.

**Files:**

- Modify: `gemini-chat-exporter/src/main.ts` (ZIP helpers, `uniqueName`, `enumerateConversationIds`, `exportAllConversations`, wire the All button)
- Modify: `gemini-chat-exporter/test/run.mjs` (ZIP-structure assertion with stubbed navigation)

**Interfaces:**

- Consumes: `renderConversation`, `sanitizeFilename`, `downloadBlob`.
- Produces: `crc32`, `zipStore(files)`, `uniqueName`, `enumerateConversationIds(): Promise<string[]>`, `exportAllConversations(onProgress): Promise<{exported:number; failed:number}>`.

- [ ] **Step 1: Port the ZIP + uniqueName helpers verbatim** from `claude-chat-exporter/src/main.ts:579-717` (the `sanitizeFilename` you already have, plus `uniqueName:590-606`, `CRC_TABLE:609-617`, `crc32:619-624`, `u16`/`u32:626-632`, `ZipEntry:634-637`, `zipStore:639-705`). These are content-agnostic byte builders — copy exactly. Change the `sanitizeFilename` fallback string to `"gemini-conversation"` (already done in Task 1).

- [ ] **Step 2: Write a failing test for Export-All** — stub navigation so that setting `window.location.pathname` (or calling the script's navigate helper) swaps which turns `querySelectorAll` returns. Provide 2 fake conversation ids via a stubbed `enumerateConversationIds`. Assert the downloaded Blob is a ZIP (`PK\x03\x04` signature) containing 2 entries.

```js
check("zip signature", blob.text.startsWith("PK") || firstBytesArePK(blob));
check("zip has 2 files", countZipLocalHeaders(blob) === 2);
```

(Provide small `firstBytesArePK`/`countZipLocalHeaders` helpers in `run.mjs` that scan the Blob `parts` for the `0x04034b50` local-file-header signature. Since the sandbox Blob stores `parts`, adapt the Blob stub to keep the raw `parts` array for ZIP tests.)

Run: `pnpm build && pnpm test` → Expected: FAIL.

- [ ] **Step 3: Implement enumeration + Export-All** — in `main.ts`:

```ts
const CONCURRENCY_NAV_DELAY_MS = 500;

// Gemini's sidebar is Angular-router-driven with no stable per-item href. Cold
// page loads expose <a href="/app/{id}"> anchors; harvest those, scrolling the
// sidebar to load more. Fallback: whatever ids are currently in the DOM.
async function enumerateConversationIds(): Promise<string[]> {
  const ids = new Set<string>();
  const harvest = (): void => {
    document.querySelectorAll('a[href*="/app/"]').forEach((a) => {
      const m = (a.getAttribute("href") ?? "").match(/\/app\/([0-9a-f]+)/i);
      if (m) ids.add(m[1]);
    });
  };
  const list = document.querySelector("mat-nav-list, " + SEL.sidebar);
  harvest();
  // Scroll the sidebar to load more items until the id set stops growing.
  let prev = -1;
  for (let i = 0; i < 40 && ids.size !== prev; i++) {
    prev = ids.size;
    if (list) list.scrollTop = list.scrollHeight;
    await new Promise((r) => setTimeout(r, 300));
    harvest();
  }
  return Array.from(ids);
}

// Client-side navigate to a conversation and wait for its turns to render.
async function navigateToConversation(id: string): Promise<void> {
  window.location.assign(`/app/${id}`);
  await new Promise((r) => setTimeout(r, CONCURRENCY_NAV_DELAY_MS));
  // Wait until at least one turn is present (bounded).
  for (let i = 0; i < 20; i++) {
    if (document.querySelectorAll(SEL.turn).length) break;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function exportAllConversations(
  onProgress: (done: number, total: number) => void,
): Promise<{ exported: number; failed: number }> {
  const snapshot = settings;
  const ids = await enumerateConversationIds();
  const enc = new TextEncoder();
  const used = new Set<string>();
  const files: ZipEntry[] = [];
  let failed = 0;
  for (let i = 0; i < ids.length; i++) {
    try {
      await navigateToConversation(ids[i]);
      const conv = await scrapeCurrentConversation();
      const rendered = renderConversation(conv, snapshot);
      // Date-prefixed name mirrors the Claude exporter's ZIP convention; a full
      // user-templated filename format (chatgpt-exporter's KEY_FILENAME_FORMAT)
      // is deferred to a later enhancement — see the Reference Alignment note.
      const datePrefix = new Date().toISOString().slice(0, 10);
      const base = `${datePrefix} ${sanitizeFilename(conv.title)}.${rendered.extension}`;
      files.push({
        name: uniqueName(base, used),
        data: enc.encode(rendered.text),
      });
    } catch (err) {
      failed++;
      console.error("[gemini-chat-exporter] skip", ids[i], err);
    }
    onProgress(i + 1, ids.length);
  }
  if (failed > 0)
    files.push({
      name: "_errors.txt",
      data: enc.encode(`${failed} conversation(s) failed to export.\n`),
    });
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(`gemini-conversations-${stamp}.zip`, zipStore(files));
  return { exported: files.length - (failed > 0 ? 1 : 0), failed };
}
```

- [ ] **Step 4: Wire the All button** in `buildModal` (mirrors the One button, ported from Claude `:1059-1070`):

```ts
allBtn.addEventListener("click", () => {
  runExport(allBtn, ALL_LABEL, async () => {
    const { exported, failed } = await exportAllConversations((done, total) => {
      setProgress(`Exporting ${done}/${total}…`);
    });
    return failed > 0
      ? `Done (${exported}, ${failed} failed)`
      : `Done (${exported})`;
  });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm build && pnpm test` → Expected: `zip signature`, `zip has 2 files` PASS.

- [ ] **Step 6: Commit**

```bash
git add gemini-chat-exporter/src/main.ts gemini-chat-exporter/test/run.mjs
git commit -m "feat(gemini-chat-exporter): store-only ZIP + Export-All (serial navigate+scrape)"
```

---

## Task 7: Native UI injection + re-mount

Replace the minimal body button with a native sidebar trigger + the settings modal on `<body>`, and a debounced/guarded `MutationObserver` that re-mounts the trigger after Gemini's SPA tears it down. Mount points must be verified live.

**Files:**

- Modify: `gemini-chat-exporter/src/main.ts` (`buildTrigger`, `mountUI`, observer)
- Modify: `gemini-chat-exporter/test/run.mjs` (trigger-mount assertion)

**Interfaces:**

- Consumes: `buildModal`, `openModal`, `TRIGGER_ID`, `MODAL_ID`, `SEL.sidebar`.
- Produces: `buildTrigger(floating: boolean): HTMLButtonElement`; `mountUI()` idempotent; observer on `document.documentElement`.

- [ ] **Step 1: Live-verify the sidebar mount anchor.** Using the browser (or ask the operator), confirm the selector for Gemini's sidebar container that persists across navigation and where a native "Export" row fits near the conversation list or bottom actions. Candidates seen live: `bard-sidenav-container`, `mat-nav-list`, `[data-test-id="conversations-list"]`. Update `SEL.sidebar` (and a `SEL.sidebarInsertPoint` if needed) to the confirmed value. Record the confirmed selector in a comment. **Do not skip this — the mount point is the only Gemini-DOM coupling and must be real.**

- [ ] **Step 2: Replace `mountUI` + add `buildTrigger`** (ported/adapted from Claude `:1086-1158`):

`DL_SVG` is a **static constant** (no user/DOM input), so `icon.innerHTML = DL_SVG` is XSS-safe — same pattern as the Claude exporter. Never assign scraped conversation content via `innerHTML`; all conversation text flows through `textContent`/Markdown strings only.

```ts
const DL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>`;

function buildTrigger(floating: boolean): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.id = TRIGGER_ID;
  btn.type = "button";
  if (floating) {
    btn.className = "gce-floating";
    btn.textContent = "⬇ Export";
  } else {
    const icon = elc("span", "gce-lead");
    icon.innerHTML = DL_SVG;
    const label = elc("span");
    label.textContent = "Export";
    btn.appendChild(icon);
    btn.appendChild(label);
  }
  btn.addEventListener("click", openModal);
  return btn;
}

function mountUI(): void {
  if (!document.getElementById(MODAL_ID)) {
    document.body.appendChild(buildModal());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
    });
  }
  const sidebar = document.querySelector(SEL.sidebar);
  const existing = document.getElementById(TRIGGER_ID);
  if (existing) {
    if (!existing.classList.contains("gce-floating") || !sidebar) return;
    existing.remove();
  }
  if (sidebar) sidebar.appendChild(buildTrigger(false));
  else document.body.appendChild(buildTrigger(true));
}
mountUI();

let remountQueued = false;
const observer = new MutationObserver(() => {
  const trigger = document.getElementById(TRIGGER_ID);
  const canUpgrade =
    trigger?.classList.contains("gce-floating") === true &&
    document.querySelector(SEL.sidebar) !== null;
  if (trigger && document.getElementById(MODAL_ID) && !canUpgrade) return;
  if (remountQueued) return;
  remountQueued = true;
  setTimeout(() => {
    remountQueued = false;
    mountUI();
  }, 200);
});
observer.observe(document.documentElement, { childList: true, subtree: true });

// Belt-and-suspenders (chatgpt-exporter pattern): the debounced observer catches
// most re-renders, but Gemini's Angular sidebar can fully remount in ways it
// misses. A low-frequency reconciliation loop re-mounts when our trigger or modal
// is no longer in the document. getElementById only returns connected nodes, so a
// null result already means "disconnected → re-mount". mountUI is idempotent.
setInterval(() => {
  if (
    !document.getElementById(TRIGGER_ID) ||
    !document.getElementById(MODAL_ID)
  )
    mountUI();
}, 1000);
```

Delete the old minimal `mountUI` and its `ONE_ID` body button from Task 1. Update the harness (which relied on `__gce_export_btn` on the body) to instead click the modal's `__gce_export_btn` action button (the modal is built in `buildModal`; the sandbox's `document.querySelector(SEL.sidebar)` returns null → floating fallback path, and `buildModal` still creates all action/settings controls into the captured element list, same as the Claude harness relies on).

- [ ] **Step 3: Update the harness** so `document.querySelector` returns `null` for the sidebar (forcing the floating + modal path) and the export is driven via the modal's `__gce_export_btn` element's captured `click` handler (as the Claude harness does at its export step). Re-run the Task 1/3/5 assertions through this path. **Add a `setInterval: () => 0` stub to the sandbox globals** — the built script now calls `setInterval` for the reconciliation loop, and without a stub the sandbox throws `setInterval is not defined` (it must be a no-op returning a fake handle, NOT the immediate-invoke used for `setTimeout`, or it would loop).

Run: `pnpm build && pnpm test` → Expected: all green.

- [ ] **Step 4: Add a trigger/modal presence assertion**:

```js
check(
  "trigger mounted (floating fallback)",
  createdEls.some((e) => e._id === "__gce_export_trigger"),
);
check(
  "modal built",
  createdEls.some((e) => e._id === "__gce_modal"),
);
```

Run: `pnpm build && pnpm test` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gemini-chat-exporter/src/main.ts gemini-chat-exporter/test/run.mjs
git commit -m "feat(gemini-chat-exporter): native sidebar trigger + settings modal + re-mount"
```

---

## Task 8: Live verification, docs, and pipeline check

Verify the built script in a real browser (the harness can't cover live DOM/UI), write docs, and confirm the release pipeline is wired.

**Files:**

- Create: `gemini-chat-exporter/README.md`
- Create: `gemini-chat-exporter/AGENTS.md`
- Modify: `CLAUDE.md` (add gemini-chat-exporter to "Current scripts" + a Key Design section)

- [ ] **Step 1: Build the release-shaped artifact**

Run: `cd gemini-chat-exporter && SCRIPT_VERSION=$(date +%F) pnpm build`
Expected: `dist/gemini-chat-exporter.user.js` header shows `@version <today>` and `@match https://gemini.google.com/*`.

- [ ] **Step 2: Live-verify in the browser** (operator-driven or via Claude-in-Chrome). Install the built `.user.js` in Tampermonkey (or `pnpm dev` and install the printed URL), then on gemini.google.com confirm, checking each off:
  - Export trigger appears in the sidebar (not just the floating pill) on a conversation page.
  - Settings modal opens, renders correctly in light AND dark, persists a format/toggle change across reload.
  - "Export this chat" downloads Markdown that contains the turns, a code block, and (if present) a table — spot-check fidelity against the on-screen conversation.
  - JSON format exports valid JSON.
  - Thinking toggle: with it on, a conversation that has reasoning includes the `🧠 Thinking` block.
  - A **long** conversation exports **all** turns (this validates the Task 4 completeness path against real virtualization — create a long chat if none exists).
  - "Export all" produces a ZIP; open it and confirm one file per conversation. If enumeration under-collects, confirm the fallback (currently-loaded ids) still produces a valid partial ZIP and the progress count is truthful.
  - Navigate between chats: the trigger re-mounts without duplicates or console `DOMException`.

  Record any selector that didn't match and fix it in `SEL` before proceeding. **If a live check fails, treat it as a bug (systematic-debugging), not a doc note.**

- [ ] **Step 3: Write `gemini-chat-exporter/README.md`** — model on `claude-chat-exporter/README.md`: what it does, install, usage (current + all), settings, the Deep-Research/image limitations, and that it scrapes the DOM (no API).

- [ ] **Step 4: Write `gemini-chat-exporter/AGENTS.md`** — model on `claude-chat-exporter/AGENTS.md`: purpose, layout, commands, and Design Notes covering: DOM-scraping rationale (no clean API, batchexecute is fragile), the `SEL` seam, HTML→Markdown converter, completeness (`ensureAllTurnsLoaded` + Map), CSP/sandbox grant, settings shape (`gce_settings`), Export-All enumeration + fallback, and the out-of-scope list.

- [ ] **Step 5: Update root `CLAUDE.md`** — add `gemini-chat-exporter/` to the "Current scripts" list with a one-line description, and a `### gemini-chat-exporter Key Design` subsection summarizing: DOM scraping via `SEL`, HTML→MD converter, virtualization-safe turn loading, `gce_settings`, serial Export-All, GM_addStyle CSP sandbox.

- [ ] **Step 6: Final full verification**

Run: `cd .. && pnpm typecheck && pnpm -r build && pnpm -r test`
Expected: all packages typecheck, build, and pass their harnesses.

- [ ] **Step 7: Commit docs**

```bash
git add gemini-chat-exporter/README.md gemini-chat-exporter/AGENTS.md CLAUDE.md
git commit -m "docs(gemini-chat-exporter): README, AGENTS, and CLAUDE.md entry"
```

- [ ] **Step 8: Verify release wiring** — confirm `pnpm-workspace.yaml` and `.github/workflows/release.yml` both list `gemini-chat-exporter` (done in Task 1; re-verify). A `feat(gemini-chat-exporter):` commit on `main` must trigger a `gemini-chat-exporter-<date>` release. Do NOT push or tag unless the operator asks.

---

## Self-Review

**Spec coverage:**

- DOM-scraping rationale → Task 1 (design), Task 8 docs. ✓
- Per-turn extraction (`.conversation-container`/`user-query`/`model-response`) → Task 1, 3, 4. ✓
- HTML→Markdown converter (paragraphs, headings, lists, code, tables, links, emphasis, blockquote) → Task 2. ✓
- Completeness / virtualization mitigation (incremental scroll + Map by turn identity) → Task 4. ✓
- Thinking (`thinking-overlay`, expand-then-read) → Task 3. ✓
- Attachments (names only) → Task 3. ✓
- Settings (`gce_settings`: format/frontmatter/includeThinking/includeAttachments) → Task 1 (type) + Task 5 (modal). ✓
- MD + JSON renderers sharing predicates → Task 1/3 (MD), Task 5 (JSON). ✓
- Store-only ZIP (no dependency) → Task 6. ✓
- Export-All (enumerate + serial navigate+scrape + fallback) → Task 6. ✓
- Native UI injection + dual-persistence re-mount (MutationObserver + 1s reconciliation interval) + floating fallback → Task 7. ✓
- CSP/sandbox grant, download plumbing → Task 1. ✓
- Pipeline wiring (workspace + release matrix + Node harness) → Task 1 + Task 8. ✓
- Out of scope (Deep Research immersive, image bytes) → documented, Task 8. ✓

**Placeholder scan:** The Task 1 harness Step 9 intentionally ships a `placeholder — see Step 10` check that Step 10 replaces with real assertions; this is a deliberate two-step (scaffold sandbox, then wire the click) not an unfilled TODO — Step 11 asserts the real checks pass. No `TBD`/`implement later` remain. Ported blocks cite exact source line ranges.

**Type consistency:** `scrapeCurrentConversation` returns `Promise<Conversation>` from Task 4 on (async); every caller (`exportCurrentConversation`, `exportAllConversations`) awaits it. `htmlToMarkdown(root: Element | null)` signature stable Task 1→2. `Settings` keys (`format`, `frontmatter`, `includeThinking`, `includeAttachments`) consistent across `swRow`'s `Exclude<keyof Settings,"format">`, `toMarkdown`, `toJSON`. Control ids (`__gce_fmt_md/json`, `__gce_frontmatter`, `__gce_thinking`, `__gce_attachments`, `__gce_export_btn`, `__gce_export_all_btn`, `__gce_modal`, `__gce_export_trigger`) consistent between `main.ts` and harness assertions.

## Execution Handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task with review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.
