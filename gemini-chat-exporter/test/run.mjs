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

// Element/text node fixtures for the HTML->MD converter.
function textNode(s) {
  return { nodeType: 3, textContent: s, childNodes: [] };
}
// Depth-first descendant search by tag name (uppercase nodeName), mirroring
// the subset of querySelector/querySelectorAll the converter relies on
// (single tag-name selectors only: "code", "tr").
function findDescendants(root, tagName) {
  const upper = tagName.toUpperCase();
  const results = [];
  for (const c of root.childNodes ?? []) {
    if (c.nodeType === 1) {
      if (c.nodeName === upper) results.push(c);
      results.push(...findDescendants(c, tagName));
    }
  }
  return results;
}
function elNode(name, children = [], attrs = {}) {
  const elem = {
    nodeType: 1,
    nodeName: name.toUpperCase(),
    childNodes: children,
    getAttribute: (k) => attrs[k] ?? null,
    classList: { contains: (c) => (attrs.class ?? "").split(" ").includes(c) },
    get textContent() {
      return children.map((c) => c.textContent).join("");
    },
    querySelector: (sel) => findDescendants(elem, sel)[0] ?? null,
    querySelectorAll: (sel) => findDescendants(elem, sel),
  };
  return elem;
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
        // .markdown is real converter input: an element tree with
        // childNodes/nodeType, either a caller-supplied fixture (responseNode)
        // or a plain text response wrapped in a single text node.
        ".markdown":
          t.responseNode ??
          elNode("div", t.response ? [textNode(t.response)] : []),
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

// --- Test: HTML->Markdown converter fidelity ---
{
  // .markdown containing: <h2>, <p><strong>, <ul><li>, <pre><code class="language-js">, <p><a>
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

  const { downloaded, bodyChildren } = makeSandbox({
    pathname: "/app/def456",
    title: "MD fidelity - Google Gemini",
    settings: {
      format: "md",
      frontmatter: false,
      includeThinking: true,
      includeAttachments: true,
    },
    turns: [{ prompt: "Show me", responseNode: md }],
  });

  const btn = bodyChildren.find((c) => c.id === "__gce_export_btn");
  btn._on.click();
  const { blob } = await downloaded;
  const out = blob.text;
  check("h2 -> ##", out.includes("## Heading"));
  check("bold -> **", out.includes("**bold**"));
  check("ul -> - ", out.includes("- one") && out.includes("- two"));
  check(
    "code fence + lang",
    out.includes("```js") && out.includes("const x = 1;"),
  );
  check("link -> []()", out.includes("[link](https://x.dev)"));
}

// --- Test: nested list + table edge cases (must not crash) ---
{
  const md = elNode("div", [
    elNode("ul", [
      elNode("li", [textNode("outer one")]),
      elNode("li", [
        textNode("outer two"),
        elNode("ul", [
          elNode("li", [textNode("inner a")]),
          elNode("li", [textNode("inner b")]),
        ]),
      ]),
    ]),
    elNode("table", [
      elNode("tr", [
        elNode("th", [textNode("Col A")]),
        elNode("th", [textNode("Col B")]),
      ]),
      elNode("tr", [
        elNode("td", [textNode("r1c1")]),
        elNode("td", [textNode("r1c2")]),
      ]),
      elNode("tr", [
        elNode("td", [textNode("r2c1")]),
        elNode("td", [textNode("r2c2")]),
      ]),
    ]),
  ]);

  const { downloaded, bodyChildren } = makeSandbox({
    pathname: "/app/ghi789",
    title: "Edge cases - Google Gemini",
    settings: {
      format: "md",
      frontmatter: false,
      includeThinking: true,
      includeAttachments: true,
    },
    turns: [{ prompt: "Edge", responseNode: md }],
  });

  const btn = bodyChildren.find((c) => c.id === "__gce_export_btn");
  btn._on.click();
  const { blob } = await downloaded;
  const out = blob.text;
  check(
    "nested list doesn't crash",
    out.includes("outer one") &&
      out.includes("outer two") &&
      out.includes("inner a") &&
      out.includes("inner b"),
  );
  check("table separator row", out.includes("| --- | --- |"));
  check("table header row", out.includes("Col A") && out.includes("Col B"));
  check(
    "table data rows",
    out.includes("r1c1") &&
      out.includes("r1c2") &&
      out.includes("r2c1") &&
      out.includes("r2c2"),
  );
}

// --- Test: nested lists, div-wrapped blocks, OL/blockquote/em, code fence trailing newlines ---
{
  const md = elNode("div", [
    // nested list: marker + 2-space indent per depth level (review finding #1)
    elNode("ul", [
      elNode("li", [
        textNode("outer"),
        elNode("ul", [elNode("li", [textNode("inner")])]),
      ]),
    ]),
    // div wrapping block children must recurse, not flatten (review finding #2)
    elNode("div", [
      elNode("p", [textNode("wrapped paragraph")]),
      elNode("h3", [textNode("Wrapped Heading")]),
    ]),
    // ordered list markers (review finding #3)
    elNode("ol", [
      elNode("li", [textNode("first")]),
      elNode("li", [textNode("second")]),
    ]),
    // blockquote prefix (review finding #3)
    elNode("blockquote", [textNode("quoted text")]),
    // em/i italic (review finding #3)
    elNode("p", [
      textNode("An "),
      elNode("em", [textNode("italic")]),
      textNode(" word."),
    ]),
    // multiple trailing newlines inside a code fence must collapse (minor fix)
    elNode("pre", [
      elNode("code", [textNode("const y = 2;\n\n\n")], {
        class: "language-js",
      }),
    ]),
  ]);

  const { downloaded, bodyChildren } = makeSandbox({
    pathname: "/app/jkl012",
    title: "Review fixes - Google Gemini",
    settings: {
      format: "md",
      frontmatter: false,
      includeThinking: true,
      includeAttachments: true,
    },
    turns: [{ prompt: "Fixes", responseNode: md }],
  });

  const btn = bodyChildren.find((c) => c.id === "__gce_export_btn");
  btn._on.click();
  const { blob } = await downloaded;
  const out = blob.text;
  check("nested list: outer marker", out.includes("- outer"));
  check("nested list: inner indented 2 spaces", out.includes("\n  - inner"));
  check(
    "div-wrapped blocks recurse (paragraph)",
    out.includes("wrapped paragraph"),
  );
  check(
    "div-wrapped blocks recurse (heading)",
    out.includes("### Wrapped Heading"),
  );
  check(
    "div-wrapped blocks keep block separation",
    out.includes("wrapped paragraph\n\n### Wrapped Heading"),
  );
  check(
    "ordered list markers",
    out.includes("1. first") && out.includes("2. second"),
  );
  check("blockquote prefix", out.includes("> quoted text"));
  check("em -> *italic*", out.includes("*italic*"));
  check(
    "code fence collapses trailing blank lines",
    out.includes("const y = 2;\n```") && !out.includes("const y = 2;\n\n\n```"),
  );
}

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall green");
