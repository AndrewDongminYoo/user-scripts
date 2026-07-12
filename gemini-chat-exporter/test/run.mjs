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
function node({ text = "", query = {}, queryAll = {}, attrs = {} } = {}) {
  return {
    textContent: text,
    querySelector: (sel) => query[sel] ?? null,
    querySelectorAll: (sel) => queryAll[sel] ?? [],
    getAttribute: (k) => attrs[k] ?? null,
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

function makeSandbox({ pathname, title, turns, settings, revealSchedule }) {
  let lastBlob = null;
  let resolveDownload;
  const downloaded = new Promise((r) => (resolveDownload = r));
  // Tracks every element ever created via document.createElement, regardless
  // of where (or whether) it ends up attached — modal controls are nested
  // several levels below <body>, so tests find them by id via this list
  // rather than by walking appendChild trees.
  const allEls = [];
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
    allEls.push(e);
    return e;
  };
  const turnNodes = turns.map((t) =>
    node({
      query: {
        // Extraction queries are scoped to their parent element
        // (user-query / model-response), so fixtures key on the scoped
        // selector string the extractor actually issues.
        "user-query .query-text": node({ text: t.prompt }),
        // model-response .markdown is real converter input: an element tree
        // with childNodes/nodeType, either a caller-supplied fixture
        // (responseNode) or a plain text response wrapped in a single text
        // node.
        "model-response .markdown":
          t.responseNode ??
          elNode("div", t.response ? [textNode(t.response)] : []),
        // thinkingNode lets a test supply a custom fixture (e.g. one whose
        // querySelector exposes a clickable toggle) instead of the plain
        // text-only node built from `thinking`.
        "thinking-overlay":
          t.thinkingNode ?? (t.thinking ? node({ text: t.thinking }) : null),
        // decoyMarkdownNode lets a regression test prove the response query
        // is scoped under model-response, not the bare ".markdown" selector.
        ...(t.decoyMarkdownNode ? { ".markdown": t.decoyMarkdownNode } : {}),
      },
      queryAll: {
        "user-query .file-preview-container": (t.attachments ?? []).map(
          (name) => node({ text: name }),
        ),
      },
    }),
  );
  // Mock lazy-load scroller: when revealSchedule (an array of [start, end)
  // index pairs into turnNodes) is supplied, querySelectorAll(".conversation-container")
  // reveals a growing slice each time scrollTop is set to 0, simulating
  // Gemini's infinite-scroller loading older turns upward. Tests that omit
  // revealSchedule keep the old always-return-everything behavior.
  let revealLevel = 0;
  const revealSlices = revealSchedule?.map(([s, e]) => turnNodes.slice(s, e));
  const scrollerMock = revealSlices
    ? {
        scrollHeight: 1000,
        get scrollTop() {
          return this._scrollTop ?? 0;
        },
        set scrollTop(v) {
          this._scrollTop = v;
          if (v === 0 && revealLevel < revealSlices.length - 1) revealLevel++;
        },
      }
    : null;

  const gmStore = { gce_settings: settings };
  const globals = {
    window: { location: { pathname } },
    document: {
      title,
      documentElement: {},
      getElementById: () => null,
      querySelector: (sel) =>
        scrollerMock && sel === "infinite-scroller.chat-history"
          ? scrollerMock
          : null,
      querySelectorAll: (sel) => {
        if (sel !== ".conversation-container") return [];
        return revealSlices ? revealSlices[revealLevel] : turnNodes;
      },
      addEventListener: () => {},
      createElement: el,
      body: {
        appendChild() {},
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
    // Reconciliation loop's interval must NOT auto-fire like setTimeout above
    // (that would recurse into mountUI forever); a no-op returning a fake
    // handle matches real setInterval semantics closely enough for tests.
    setInterval: () => 0,
    GM_addStyle: () => {},
    GM_getValue: (k, d) => (k in gmStore ? gmStore[k] : d),
    GM_setValue: (k, v) => {
      gmStore[k] = v;
    },
    // Export-All transport uses TextEncoder (zipStore) and the standard
    // Uint8Array; expose them to the vm context.
    TextEncoder,
    Uint8Array,
  };
  globals.globalThis = globals;
  vm.createContext(globals);
  vm.runInContext(src, globals);
  return { globals, downloaded, allEls, gmStore };
}

// --- Test: basic 2-turn Markdown export ---
{
  const { downloaded, allEls } = makeSandbox({
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

  const btn = allEls.find((c) => c.id === "__gce_export_btn");
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

  const { downloaded, allEls } = makeSandbox({
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

  const btn = allEls.find((c) => c.id === "__gce_export_btn");
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

  const { downloaded, allEls } = makeSandbox({
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

  const btn = allEls.find((c) => c.id === "__gce_export_btn");
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

  const { downloaded, allEls } = makeSandbox({
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

  const btn = allEls.find((c) => c.id === "__gce_export_btn");
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

// --- Test: response query is scoped to model-response, not the bare
// ".markdown" selector (guards against a stray .markdown elsewhere in the
// container, e.g. inside a thinking-overlay, being mistaken for the response) ---
{
  const decoy = elNode("div", [textNode("DECOY THINKING")]);
  const real = elNode("div", [textNode("REAL RESPONSE")]);

  const { downloaded, allEls } = makeSandbox({
    pathname: "/app/scope001",
    title: "Scoping test - Google Gemini",
    settings: {
      format: "md",
      frontmatter: false,
      includeThinking: true,
      includeAttachments: true,
    },
    turns: [{ prompt: "Q", responseNode: real, decoyMarkdownNode: decoy }],
  });

  const btn = allEls.find((c) => c.id === "__gce_export_btn");
  btn._on.click();
  const { blob } = await downloaded;
  const out = blob.text;
  check("scoped query reads the real response", out.includes("REAL RESPONSE"));
  check(
    "scoped query ignores the decoy .markdown",
    !out.includes("DECOY THINKING"),
  );
}

// --- Test: thinking + attachments capture ---
{
  const { downloaded, allEls } = makeSandbox({
    pathname: "/app/mno345",
    title: "Thinking test - Google Gemini",
    settings: {
      format: "md",
      frontmatter: false,
      includeThinking: true,
      includeAttachments: true,
    },
    turns: [
      {
        prompt: "Analyze this",
        response: "Here's the analysis",
        thinking: "reasoning step one",
        attachments: ["report.pdf"],
      },
    ],
  });

  const btn = allEls.find((c) => c.id === "__gce_export_btn");
  btn._on.click();
  const { blob } = await downloaded;
  const out = blob.text;
  check(
    "thinking captured",
    out.includes("Thinking") && out.includes("reasoning step"),
  );
  check("attachment name listed", out.includes("report.pdf"));
}

// --- Test: thinking omitted when includeThinking=false ---
{
  const { downloaded, allEls } = makeSandbox({
    pathname: "/app/pqr678",
    title: "Thinking off - Google Gemini",
    settings: {
      format: "md",
      frontmatter: false,
      includeThinking: false,
      includeAttachments: true,
    },
    turns: [
      {
        prompt: "Analyze this",
        response: "Here's the analysis",
        thinking: "reasoning step one",
      },
    ],
  });

  const btn = allEls.find((c) => c.id === "__gce_export_btn");
  btn._on.click();
  const { blob } = await downloaded;
  const outOff = blob.text;
  check("thinking omitted when off", !outOff.includes("reasoning step"));
}

// --- Test: attachments omitted when includeAttachments=false ---
{
  const { downloaded, allEls } = makeSandbox({
    pathname: "/app/stu901",
    title: "Attachments off - Google Gemini",
    settings: {
      format: "md",
      frontmatter: false,
      includeThinking: true,
      includeAttachments: false,
    },
    turns: [
      {
        prompt: "Analyze this",
        response: "Here's the analysis",
        attachments: ["report.pdf"],
      },
    ],
  });

  const btn = allEls.find((c) => c.id === "__gce_export_btn");
  btn._on.click();
  const { blob } = await downloaded;
  const outOff = blob.text;
  check("attachment name omitted when off", !outOff.includes("report.pdf"));
}

// --- Test: frontmatter title/source escape backslashes before quotes (YAML) ---
{
  const { downloaded, allEls } = makeSandbox({
    pathname: "/app/vwx234",
    // title contains both a backslash and a double-quote
    title: 'C:\\path\\to "file" - Google Gemini',
    settings: {
      format: "md",
      frontmatter: true,
      includeThinking: true,
      includeAttachments: true,
    },
    turns: [{ prompt: "Q", response: "A" }],
  });

  const btn = allEls.find((c) => c.id === "__gce_export_btn");
  btn._on.click();
  const { blob } = await downloaded;
  const out = blob.text;
  // Correct order: backslashes escaped first, then quotes.
  // Source title: C:\path\to "file"
  // Expected YAML: "C:\\path\\to \"file\""
  check(
    "frontmatter title escapes backslashes before quotes",
    out.includes('title: "C:\\\\path\\\\to \\"file\\""'),
  );
}

// --- Test: expandCollapsed does not click when overlay already has text ---
{
  let clicked = false;
  const overlay = {
    textContent: "already expanded reasoning",
    getAttribute: () => null,
    querySelector: (sel) =>
      sel === "button, [role='button']"
        ? {
            click: () => {
              clicked = true;
            },
          }
        : null,
  };

  const { downloaded, allEls } = makeSandbox({
    pathname: "/app/yz1234",
    title: "Expand branch already-open - Google Gemini",
    settings: {
      format: "md",
      frontmatter: false,
      includeThinking: true,
      includeAttachments: true,
    },
    turns: [{ prompt: "Q", response: "A", thinkingNode: overlay }],
  });

  const btn = allEls.find((c) => c.id === "__gce_export_btn");
  btn._on.click();
  await downloaded;
  check("already-expanded overlay: toggle NOT clicked", !clicked);
}

// --- Test: expandCollapsed clicks toggle when overlay is empty ---
{
  let clicked = false;
  const overlay = {
    textContent: "",
    getAttribute: () => null,
    querySelector: (sel) =>
      sel === "button, [role='button']"
        ? {
            click: () => {
              clicked = true;
            },
          }
        : null,
  };

  const { downloaded, allEls } = makeSandbox({
    pathname: "/app/ab5678",
    title: "Expand branch collapsed - Google Gemini",
    settings: {
      format: "md",
      frontmatter: false,
      includeThinking: true,
      includeAttachments: true,
    },
    turns: [{ prompt: "Q", response: "A", thinkingNode: overlay }],
  });

  const btn = allEls.find((c) => c.id === "__gce_export_btn");
  btn._on.click();
  await downloaded;
  check("empty overlay: toggle clicked", clicked);
}

// --- Test: completeness — lazy-loaded turns must all be scraped ---
{
  const turns = [0, 1, 2, 3, 4, 5].map((i) => ({
    prompt: `q${i}`,
    response: `a${i}`,
  }));

  const { downloaded, allEls } = makeSandbox({
    pathname: "/app/lazy001",
    title: "Lazy load - Google Gemini",
    settings: {
      format: "md",
      frontmatter: false,
      includeThinking: true,
      includeAttachments: true,
    },
    turns,
    // reveal schedule: pass0 -> turns[4..5], pass1 -> [2..5], pass2 -> [0..5], stable
    revealSchedule: [
      [4, 6],
      [2, 6],
      [0, 6],
    ],
  });

  const btn = allEls.find((c) => c.id === "__gce_export_btn");
  btn._on.click();
  const { blob } = await downloaded;
  const out = blob.text;
  check(
    "all 6 turns exported",
    ["q0", "q1", "q2", "q3", "q4", "q5"].every((q) => out.includes(q)),
  );
}

// --- Test: JSON format export ---
{
  const { downloaded, allEls } = makeSandbox({
    pathname: "/app/json001",
    title: "Test chat - Google Gemini",
    settings: {
      format: "json",
      frontmatter: false,
      includeThinking: true,
      includeAttachments: true,
    },
    turns: [
      { prompt: "Hello", response: "Hi there" },
      { prompt: "Bye", response: "Goodbye" },
    ],
  });

  const btn = allEls.find((c) => c.id === "__gce_export_btn");
  check("export button mounted (json)", !!btn);
  btn._on.click();
  const { blob } = await downloaded;
  const data = JSON.parse(blob.text);
  check("json has title", data.title === "Test chat");
  check("json turns", Array.isArray(data.turns) && data.turns.length === 2);
  check("json prompt", data.turns[0].prompt === "Hello");
  check("json mime", blob.type.startsWith("application/json"));
}

// --- Test: settings modal controls drive settings + persist ---
{
  const { allEls, gmStore } = makeSandbox({
    pathname: "/app/settings001",
    title: "Settings test - Google Gemini",
    settings: {
      format: "md",
      frontmatter: true,
      includeThinking: true,
      includeAttachments: true,
    },
    turns: [{ prompt: "Hello", response: "Hi there" }],
  });

  const trigger = allEls.find((c) => c.id === "__gce_export_trigger");
  check("export trigger mounted", !!trigger);

  const fmtJson = allEls.find((e) => e.id === "__gce_fmt_json");
  check("json radio exists", !!fmtJson);
  fmtJson.checked = true;
  fmtJson._on.change();
  check("format persisted", gmStore.gce_settings.format === "json");

  const thinkingSw = allEls.find((e) => e.id === "__gce_thinking");
  check("thinking switch exists", !!thinkingSw);
  thinkingSw.checked = false;
  thinkingSw._on.change();
  check(
    "thinking toggle persisted",
    gmStore.gce_settings.includeThinking === false,
  );

  const attachSw = allEls.find((e) => e.id === "__gce_attachments");
  check("attachments switch exists", !!attachSw);

  const fmRow = allEls.find((e) => e.id === "__gce_frontmatter");
  check("frontmatter switch exists", !!fmRow);
}

// --- Test: native UI mount (sidebar absent -> floating trigger + modal on body) ---
{
  const { allEls } = makeSandbox({
    pathname: "/app/mount001",
    title: "Mount test - Google Gemini",
    settings: {
      format: "md",
      frontmatter: true,
      includeThinking: true,
      includeAttachments: true,
    },
    turns: [{ prompt: "Hello", response: "Hi there" }],
  });

  const trigger = allEls.find((e) => e.id === "__gce_export_trigger");
  check("trigger mounted (floating fallback)", !!trigger);
  check(
    "modal built",
    allEls.some((e) => e.id === "__gce_modal"),
  );
}

// --- Test: Export-All button mounted ---
{
  const { allEls } = makeSandbox({
    pathname: "/app/all001",
    title: "All test - Google Gemini",
    settings: {
      format: "md",
      frontmatter: true,
      includeThinking: true,
      includeAttachments: true,
    },
    turns: [{ prompt: "Hello", response: "Hi there" }],
  });
  check(
    "export-all button mounted",
    allEls.some((e) => e.id === "__gce_export_all_btn"),
  );
}

// --- Test: batchexecute transport + hNvQHb content parser (verified shape) ---
// The internals seam exposes the observe-replay decoder/parser so the pinned
// payload paths (prompt = turn[2][0][0], response = turn[3][0][0][1][0]) and the
// `)]}'` envelope decode are unit-tested against synthetic fixtures that mirror
// the real structure captured live 2026-07-12.
{
  const { globals } = makeSandbox({
    pathname: "/app/int001",
    title: "internals - Google Gemini",
    settings: {
      format: "md",
      frontmatter: false,
      includeThinking: true,
      includeAttachments: true,
    },
    turns: [],
  });
  const I = globals.__gceInternals;
  check("internals seam exposed", !!I && typeof I.bxDecode === "function");

  // Real-shape turn: prompt at [2][0][0], response Markdown at [3][0][0][1][0].
  const mkTurn = (prompt, resp) => [
    [["a", "b"]],
    null,
    [[prompt, null, null, null, null]],
    [[[null, [resp]]]],
    [0, 0],
  ];
  const wrap = (payload) => {
    const row = JSON.stringify([
      ["wrb.fr", "hNvQHb", JSON.stringify(payload), null, null, "generic"],
    ]);
    // )]}' guard, blank line, byte-length prefix, JSON chunk, a trailing chunk.
    return `)]}'\n\n${Buffer.byteLength(row)}\n${row}\n10\n[["di",7]]\n`;
  };

  // Envelope decode -> payload -> parse.
  const env = wrap([[mkTurn("Hello world", "**Hi** there")], null, null, [1]]);
  const payload = I.bxPayload(env, "hNvQHb");
  check("envelope decodes to payload array", Array.isArray(payload));
  const parsed = I.parseContentPayload(payload);
  check("parse: 1 turn", parsed.turns.length === 1);
  check("parse: prompt pinned", parsed.turns[0].prompt === "Hello world");
  check(
    "parse: response markdown pinned",
    parsed.turns[0].responseMarkdown === "**Hi** there",
  );
  check("parse: not truncated (cursor null)", parsed.truncated === false);

  // payload[1] non-null cursor => truncation flagged, not silently dropped.
  const tr = I.parseContentPayload([[mkTurn("Q", "A")], "CURSOR", null, [1]]);
  check(
    "parse: truncation detected via payload[1] cursor",
    tr.truncated === true,
  );

  // Multibyte content: byte-length prefix must not corrupt the UTF-16 decode.
  const uni = wrap([
    [mkTurn("안녕하세요 세계 🌍", "**한글** 응답")],
    null,
    null,
    [1],
  ]);
  const uniParsed = I.parseContentPayload(I.bxPayload(uni, "hNvQHb"));
  check(
    "parse: multibyte prompt intact",
    uniParsed.turns[0].prompt === "안녕하세요 세계 🌍",
  );

  // Image-gen style turn: no response leaf -> keep prompt + placeholder.
  const img = I.parseContentPayload([
    [[[["a"]], null, [["Draw a cat"]], [["render", "tree"]], [0]]],
    null,
    null,
    [1],
  ]);
  check(
    "parse: image turn keeps prompt",
    img.turns.length === 1 && img.turns[0].prompt === "Draw a cat",
  );
  check(
    "parse: image turn response placeholder",
    img.turns[0].responseMarkdown.includes("non-text"),
  );

  // Malformed turn -> skipped and counted, never thrown.
  const bad = I.parseContentPayload([
    [[null, null, null, null]],
    null,
    null,
    [1],
  ]);
  check(
    "parse: malformed turn skipped + counted",
    bad.turns.length === 0 && bad.skipped === 1,
  );

  // Wrong rpcid in the envelope -> null payload (not a throw).
  check("bxPayload: missing rpcid -> null", I.bxPayload(env, "ZZZZ") === null);

  // Store-only ZIP: verbatim port from claude-chat-exporter; smoke-check it runs.
  const zip = I.zipStore([
    { name: "a.md", data: new TextEncoder().encode("alpha") },
    { name: "b.md", data: new TextEncoder().encode("beta") },
  ]);
  check("zipStore returns a blob", !!zip);

  // MaZiqc list page (shape verified live 2026-07-12): payload[2] = entries,
  // entry[0] = "c_<id>", entry[1] = title; payload[1] = next-page cursor.
  const idA = "a".repeat(16);
  const idB = "b".repeat(16);
  const page = I.parseListPage([
    null,
    "CURSOR_TOKEN",
    [
      ["c_" + idA, "First chat", 0, 0],
      ["c_" + idB, "Second chat", 0, 0],
    ],
  ]);
  check("parseListPage: 2 refs", page.refs.length === 2);
  check("parseListPage: strips c_ prefix", page.refs[0].id === idA);
  check("parseListPage: pairs title", page.refs[0].title === "First chat");
  check("parseListPage: cursor extracted", page.cursor === "CURSOR_TOKEN");

  // Last page: null cursor ends pagination.
  const last = I.parseListPage([null, null, [["c_" + idA, "Only", 0]]]);
  check("parseListPage: null cursor at end", last.cursor === null);

  // Malformed entry (non-id) is skipped, not thrown.
  const mixed = I.parseListPage([
    null,
    "X",
    [
      ["not-an-id", "Bad"],
      ["c_" + idB, "Good", 0],
    ],
  ]);
  check(
    "parseListPage: skips non-id entry",
    mixed.refs.length === 1 && mixed.refs[0].title === "Good",
  );

  // A null payload (bxReplay failed even after its retry) parses to an empty,
  // cursor-less page — indistinguishable from a legitimate last page at this
  // layer. This is why listAllConversations guards `payload == null` and throws
  // instead of breaking, so a failed list fetch surfaces rather than silently
  // truncating the conversation list.
  const nullPage = I.parseListPage(null);
  check(
    "parseListPage: null -> empty + no cursor (caller must guard)",
    nullPage.refs.length === 0 && nullPage.cursor === null,
  );

  // Export-All summary must surface skipped turns (partial-parse degradation),
  // not silently drop them, and omit any zero-valued count.
  const line = I.formatExportSummary({
    exported: 3,
    failed: 1,
    truncated: 2,
    skipped: 5,
  });
  check("summary lists exported", line.includes("3 exported"));
  check("summary surfaces skipped turns", line.includes("5 turns skipped"));
  check(
    "summary lists failed + truncated",
    line.includes("1 failed") && line.includes("2 truncated"),
  );
  const clean = I.formatExportSummary({
    exported: 2,
    failed: 0,
    truncated: 0,
    skipped: 0,
  });
  check("summary omits zero counts", clean === "2 exported");
}

// --- Test: Export-All arming miss surfaces the guidance (not a bare "Failed") ---
// With no batchexecute template learned (no chat opened this session), clicking
// Export-All throws the Korean "open a chat to arm" guidance; runExport must
// show that message in the progress line so the expected first-run state is
// actionable, not a silent failure only visible in the console.
{
  const { allEls } = makeSandbox({
    pathname: "/app/arm001",
    title: "Arm test - Google Gemini",
    settings: {
      format: "md",
      frontmatter: false,
      includeThinking: true,
      includeAttachments: true,
    },
    turns: [{ prompt: "Hi", response: "Hello" }],
  });
  const allBtn = allEls.find((e) => e.id === "__gce_export_all_btn");
  check("export-all button present", !!allBtn);
  allBtn._on.click();
  // Drain the runExport promise chain (a real macrotask flushes vm microtasks).
  await new Promise((r) => setTimeout(r, 0));
  const progress = allEls.find((e) => e.className === "gce-progress");
  check(
    "arming miss surfaces guidance in progress",
    !!progress && String(progress.textContent).includes("활성화"),
  );
  check(
    "arming miss is not a bare Failed",
    !!progress && progress.textContent !== "Failed",
  );
}

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall green");
