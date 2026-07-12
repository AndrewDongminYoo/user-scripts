import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIST = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "claude-chat-exporter.user.js",
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

// Build a fresh DOM/GM/network sandbox and run the built userscript in it.
export function makeSandbox({ cookieOrg, pathname, settings, fetchImpl }) {
  const allEls = [];
  let lastBlob = null;
  let resolveDownload;
  const downloaded = new Promise((r) => (resolveDownload = r));
  const el = (tag) => {
    const e = {
      tagName: tag,
      style: {},
      _on: {},
      children: [],
      addEventListener(t, cb) {
        this._on[t] = cb;
      },
      appendChild(c) {
        this.children.push(c);
      },
      remove() {},
      classList: {
        toggle() {},
        add() {},
        remove() {},
      },
      click() {
        if (this.tagName === "a")
          resolveDownload({ name: this.download, blob: lastBlob });
      },
    };
    allEls.push(e);
    return e;
  };
  const gmStore = { cce_settings: settings };
  const globals = {
    window: { location: { pathname } },
    document: {
      cookie: `lastActiveOrg=${cookieOrg}`,
      documentElement: {},
      getElementById: () => null,
      createElement: el,
      createTextNode: (t) => ({ nodeValue: t }),
      body: { appendChild() {} },
    },
    MutationObserver: class {
      observe() {}
    },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    Blob: class {
      constructor(parts, opts) {
        lastBlob = { parts, type: opts?.type ?? "" };
      }
    },
    fetch: fetchImpl,
    console,
    setTimeout: () => {},
    GM_addStyle: () => {},
    GM_getValue: (k, d) => (k in gmStore ? gmStore[k] : d),
    GM_setValue: (k, v) => {
      gmStore[k] = v;
    },
  };
  const run = new Function(...Object.keys(globals), src);
  run(...Object.values(globals));
  return { allEls, downloaded, gmStore };
}

const CHAT = "0198f1a2-3b4c-7d8e-9f00-112233445566";
const ORG = "abcdef01-2345-6789-abcd-ef0123456789";
const jsonRes = (d) =>
  Promise.resolve({ ok: true, status: 200, json: async () => d });

const detail = {
  uuid: CHAT,
  name: "Hello: World",
  chat_messages: [
    {
      sender: "human",
      content: [{ type: "text", text: "Hi" }],
      created_at: "2026-07-11T08:40:00Z",
    },
    {
      sender: "assistant",
      content: [{ type: "text", text: "**Yo**" }],
      created_at: "2026-07-11T08:41:00Z",
    },
  ],
};

async function testSingleMarkdownDefault() {
  const s = makeSandbox({
    cookieOrg: ORG,
    pathname: `/chat/${CHAT}`,
    settings: undefined, // defaults
    fetchImpl: (url) => {
      if (url.includes("/chat_conversations/")) return jsonRes(detail);
      throw new Error("unexpected " + url);
    },
  });
  const btn = s.allEls.find((e) => e.id === "__claude_export_btn");
  check("single button mounted", !!btn);
  btn._on.click();
  const dl = await s.downloaded;
  const text = String(dl.blob.parts[0]);
  check("md extension", dl.name.endsWith(".md"));
  check("has user header", text.includes("## 👤 User"));
  check("has claude header", text.includes("## 🤖 Claude"));
}

await testSingleMarkdownDefault();

async function testSettingsDefaultsAndPersist() {
  const s = makeSandbox({
    cookieOrg: ORG,
    pathname: "/new",
    settings: { format: "json" }, // partial -> merged with defaults
    fetchImpl: () => {
      throw new Error("no fetch expected");
    },
  });
  check(
    "partial settings merged (stored format json kept)",
    s.gmStore.cce_settings.format === "json",
  );
}
await testSettingsDefaultsAndPersist();

async function testMarkdownFrontmatterAndTimestamps() {
  const s = makeSandbox({
    cookieOrg: ORG,
    pathname: `/chat/${CHAT}`,
    settings: { format: "md", frontmatter: true, messageTimestamps: true },
    fetchImpl: (url) => {
      if (url.includes("/chat_conversations/"))
        return jsonRes({
          ...detail,
          model: "claude-opus-4",
          created_at: "2026-07-01T00:00:00Z",
          updated_at: "2026-07-11T08:41:00Z",
        });
      throw new Error("unexpected " + url);
    },
  });
  const btn = s.allEls.find((e) => e.id === "__claude_export_btn");
  btn._on.click();
  const text = String((await s.downloaded).blob.parts[0]);
  check("frontmatter opens", text.startsWith("---\n"));
  check("frontmatter title quoted", text.includes('title: "Hello: World"'));
  check("frontmatter model", text.includes('model: "claude-opus-4"'));
  check(
    "frontmatter source url",
    text.includes('source: "https://claude.ai/chat/' + CHAT + '"'),
  );
  check(
    "message timestamp on header",
    text.includes("## 👤 User · 2026-07-11 08:40"),
  );
}
await testMarkdownFrontmatterAndTimestamps();

async function testJsonOutput() {
  const s = makeSandbox({
    cookieOrg: ORG,
    pathname: `/chat/${CHAT}`,
    settings: { format: "json" },
    fetchImpl: (url) => {
      if (url.includes("/chat_conversations/"))
        return jsonRes({ ...detail, model: "claude-opus-4" });
      throw new Error("unexpected " + url);
    },
  });
  const btn = s.allEls.find((e) => e.id === "__claude_export_btn");
  btn._on.click();
  const dl = await s.downloaded;
  check("json extension", dl.name.endsWith(".json"));
  const obj = JSON.parse(String(dl.blob.parts[0]));
  check("json title", obj.title === "Hello: World");
  check("json model", obj.model === "claude-opus-4");
  check("json first role user", obj.messages[0].role === "user");
  check("json second role assistant", obj.messages[1].role === "assistant");
  check("json message text", obj.messages[0].text === "Hi");
}
await testJsonOutput();

async function testExportAllJson() {
  const list = [
    {
      uuid: "id1",
      name: "Alpha",
      updated_at: "2026-07-11T00:00:00Z",
      model: "claude-opus-4",
    },
    {
      uuid: "id2",
      name: "Alpha",
      updated_at: "2026-07-11T00:00:00Z",
      model: "claude-opus-4",
    },
  ];
  const s = makeSandbox({
    cookieOrg: ORG,
    pathname: "/new",
    settings: { format: "json" },
    fetchImpl: (url) => {
      const m = url.match(/chat_conversations\/([^?]+)/);
      if (m)
        return jsonRes({
          name: m[1],
          chat_messages: [
            { sender: "human", content: [{ type: "text", text: "hi" }] },
          ],
        });
      return jsonRes(list);
    },
  });
  const allBtn = s.allEls.find((e) => e.id === "__claude_export_all_btn");
  allBtn._on.click();
  const dl = await s.downloaded;
  check("zip filename", dl.name.endsWith(".zip"));
  const bytes = Buffer.concat(dl.blob.parts.map((p) => Buffer.from(p)));
  const asText = bytes.toString("latin1");
  check("zip contains .json entries", asText.includes(".json"));
  check("zip has no .md entries", !asText.includes(".md"));
  check("zip dedups same date+name", asText.includes("Alpha (1).json"));
  // Persist for the manual ditto spot-check.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(new URL("./_all.zip", import.meta.url), bytes);
}
await testExportAllJson();

async function testSettingsPanel() {
  const s = makeSandbox({
    cookieOrg: ORG,
    pathname: "/new",
    settings: undefined,
    fetchImpl: () => {
      throw new Error("no fetch");
    },
  });
  const cfg = s.allEls.find((e) => e.id === "__claude_export_cfg_btn");
  check("gear button mounted", !!cfg);
  const jsonCtl = s.allEls.find((e) => e.id === "__cce_fmt_json");
  check("json control exists", !!jsonCtl);
  jsonCtl.checked = true;
  jsonCtl._on.change?.();
  check("selecting json persists", s.gmStore.cce_settings.format === "json");
  const tsCtl = s.allEls.find((e) => e.id === "__cce_timestamps");
  tsCtl.checked = true;
  tsCtl._on.change?.();
  check(
    "toggling timestamps persists",
    s.gmStore.cce_settings.messageTimestamps === true,
  );
}
await testSettingsPanel();

async function testExportAllSnapshotsSettings() {
  // Deterministic: ONE conversation -> mapPool runs a single worker, so the
  // order is fetch -> flip -> render. Start md; the panel flips to JSON during
  // the conversation fetch (after the pre-loop snapshot is captured). The
  // snapshot must keep the export md-only; reading the live global would emit
  // a .json entry instead.
  const list = [{ uuid: "a", name: "A", updated_at: "2026-07-11T00:00:00Z" }];
  let sandbox;
  sandbox = makeSandbox({
    cookieOrg: ORG,
    pathname: "/new",
    settings: { format: "md" },
    fetchImpl: (url) => {
      const m = url.match(/chat_conversations\/([^?]+)/);
      if (!m) return jsonRes(list);
      // Flip inside json() — the last await before the render — so the global
      // is JSON at the exact moment the (buggy) code would read it, with no
      // concurrency-ordering ambiguity.
      return {
        ok: true,
        status: 200,
        json: async () => {
          const jsonCtl = sandbox.allEls.find((e) => e.id === "__cce_fmt_json");
          jsonCtl.checked = true;
          jsonCtl._on.change();
          return {
            name: m[1],
            chat_messages: [
              { sender: "human", content: [{ type: "text", text: "hi" }] },
            ],
          };
        },
      };
    },
  });
  const allBtn = sandbox.allEls.find((e) => e.id === "__claude_export_all_btn");
  allBtn._on.click();
  const dl = await sandbox.downloaded;
  const asText = Buffer.concat(
    dl.blob.parts.map((p) => Buffer.from(p)),
  ).toString("latin1");
  check(
    "global settings did flip mid-export (sanity)",
    sandbox.gmStore.cce_settings.format === "json",
  );
  check(
    "snapshot kept the entry md (no leak)",
    asText.includes(".md") && !asText.includes(".json"),
  );
}
await testExportAllSnapshotsSettings();

const thinkingDetail = {
  uuid: CHAT,
  name: "Thinking",
  chat_messages: [
    {
      sender: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "step by step",
          hidden: false,
          thinking_hidden: false,
        },
        { type: "thinking", thinking: "  ", hidden: false }, // empty -> skipped
        { type: "thinking", thinking: "secret", hidden: true }, // hidden -> skipped
        { type: "text", text: "Answer" },
      ],
      created_at: "2026-07-11T09:00:00Z",
    },
  ],
};

async function testThinkingMarkdown() {
  const s = makeSandbox({
    cookieOrg: ORG,
    pathname: `/chat/${CHAT}`,
    settings: { format: "md", frontmatter: false },
    fetchImpl: (url) => {
      if (url.includes("/chat_conversations/")) return jsonRes(thinkingDetail);
      throw new Error("unexpected " + url);
    },
  });
  s.allEls.find((e) => e.id === "__claude_export_btn")._on.click();
  const text = String((await s.downloaded).blob.parts[0]);
  check(
    "thinking details rendered",
    text.includes("<details><summary>🧠 Extended thinking</summary>"),
  );
  check("thinking body present", text.includes("step by step"));
  check(
    "empty thinking skipped",
    !text.includes("<summary>🧠 Extended thinking</summary>\n\n  "),
  );
  check("hidden thinking skipped", !text.includes("secret"));
  check("text still rendered", text.includes("Answer"));
}
await testThinkingMarkdown();

async function testThinkingToggleOffAndJson() {
  const off = makeSandbox({
    cookieOrg: ORG,
    pathname: `/chat/${CHAT}`,
    settings: { format: "md", frontmatter: false, includeThinking: false },
    fetchImpl: (url) =>
      url.includes("/chat_conversations/")
        ? jsonRes(thinkingDetail)
        : (() => {
            throw new Error(url);
          })(),
  });
  off.allEls.find((e) => e.id === "__claude_export_btn")._on.click();
  const offText = String((await off.downloaded).blob.parts[0]);
  check("thinking omitted when toggle off", !offText.includes("🧠"));

  const js = makeSandbox({
    cookieOrg: ORG,
    pathname: `/chat/${CHAT}`,
    settings: { format: "json" },
    fetchImpl: (url) =>
      url.includes("/chat_conversations/")
        ? jsonRes(thinkingDetail)
        : (() => {
            throw new Error(url);
          })(),
  });
  js.allEls.find((e) => e.id === "__claude_export_btn")._on.click();
  const obj = JSON.parse(String((await js.downloaded).blob.parts[0]));
  check(
    "json thinking array",
    Array.isArray(obj.messages[0].thinking) &&
      obj.messages[0].thinking[0] === "step by step",
  );
  check(
    "json thinking excludes hidden/empty",
    obj.messages[0].thinking.length === 1,
  );
}
await testThinkingToggleOffAndJson();

const bigOutput = "x".repeat(2500);
const toolDetail = {
  uuid: CHAT,
  name: "Tools",
  chat_messages: [
    {
      sender: "assistant",
      content: [
        { type: "text", text: "Running it" },
        { type: "tool_use", name: "bash_tool", input: { command: "ls" } },
        {
          type: "tool_result",
          is_error: false,
          content: [{ type: "text", text: bigOutput }],
        },
        { type: "tool_use", name: "web_search", input: { query: "q" } },
        {
          type: "tool_result",
          is_error: true,
          content: [{ type: "text", text: "boom" }],
        },
      ],
      created_at: "2026-07-11T09:10:00Z",
    },
  ],
};

async function testToolsMarkdown() {
  const s = makeSandbox({
    cookieOrg: ORG,
    pathname: `/chat/${CHAT}`,
    settings: { format: "md", frontmatter: false },
    fetchImpl: (url) =>
      url.includes("/chat_conversations/")
        ? jsonRes(toolDetail)
        : (() => {
            throw new Error(url);
          })(),
  });
  s.allEls.find((e) => e.id === "__claude_export_btn")._on.click();
  const text = String((await s.downloaded).blob.parts[0]);
  check(
    "tool_use summary rendered",
    text.includes("<details><summary>🔧 bash_tool</summary>"),
  );
  check("tool input as json fence", text.includes('"command": "ls"'));
  check(
    "tool_use precedes tool_result",
    text.indexOf("🔧 bash_tool") < text.indexOf("↳ Result"),
  );
  check(
    "tool_result error flagged",
    text.includes("<details><summary>↳ Result · error</summary>"),
  );
  check("long tool result truncated", text.includes("… (truncated)"));
  check("md cap respected", !text.includes("x".repeat(2100)));
}
await testToolsMarkdown();

async function testToolsJsonAndToggle() {
  const js = makeSandbox({
    cookieOrg: ORG,
    pathname: `/chat/${CHAT}`,
    settings: { format: "json" },
    fetchImpl: (url) =>
      url.includes("/chat_conversations/")
        ? jsonRes(toolDetail)
        : (() => {
            throw new Error(url);
          })(),
  });
  js.allEls.find((e) => e.id === "__claude_export_btn")._on.click();
  const obj = JSON.parse(String((await js.downloaded).blob.parts[0]));
  const tools = obj.messages[0].tools;
  check("json two tool records", Array.isArray(tools) && tools.length === 2);
  check(
    "json tool name+input",
    tools[0].name === "bash_tool" && tools[0].input.command === "ls",
  );
  check(
    "json tool result full (untruncated)",
    tools[0].result.length === 2500 && !tools[0].result.includes("truncated"),
  );
  check("json tool error flag", tools[1].is_error === true);

  const off = makeSandbox({
    cookieOrg: ORG,
    pathname: `/chat/${CHAT}`,
    settings: { format: "md", frontmatter: false, includeToolCalls: false },
    fetchImpl: (url) =>
      url.includes("/chat_conversations/")
        ? jsonRes(toolDetail)
        : (() => {
            throw new Error(url);
          })(),
  });
  off.allEls.find((e) => e.id === "__claude_export_btn")._on.click();
  const offText = String((await off.downloaded).blob.parts[0]);
  check(
    "tools omitted when toggle off",
    !offText.includes("🔧") && !offText.includes("↳ Result"),
  );
  check("text kept when tools off", offText.includes("Running it"));
}
await testToolsJsonAndToggle();

const attachDetail = {
  uuid: CHAT,
  name: "Attach",
  chat_messages: [
    {
      sender: "human",
      content: [{ type: "text", text: "See attached" }],
      attachments: [
        {
          file_name: "spec.txt",
          file_size: 42,
          file_type: "text/plain",
          extracted_content: "PASTED BODY",
        },
        { file_name: "empty.txt", file_size: 0, extracted_content: "   " }, // skipped
      ],
      created_at: "2026-07-11T09:20:00Z",
    },
  ],
};

async function testAttachmentsMarkdownAndJson() {
  const md = makeSandbox({
    cookieOrg: ORG,
    pathname: `/chat/${CHAT}`,
    settings: { format: "md", frontmatter: false },
    fetchImpl: (url) =>
      url.includes("/chat_conversations/")
        ? jsonRes(attachDetail)
        : (() => {
            throw new Error(url);
          })(),
  });
  md.allEls.find((e) => e.id === "__claude_export_btn")._on.click();
  const text = String((await md.downloaded).blob.parts[0]);
  check(
    "attachment summary rendered",
    text.includes("<details><summary>📎 spec.txt (42 bytes)</summary>"),
  );
  check("attachment body rendered", text.includes("PASTED BODY"));
  check(
    "attachment appears before message text",
    text.indexOf("📎 spec.txt") < text.indexOf("See attached"),
  );
  check("empty attachment skipped", !text.includes("empty.txt"));

  const js = makeSandbox({
    cookieOrg: ORG,
    pathname: `/chat/${CHAT}`,
    settings: { format: "json" },
    fetchImpl: (url) =>
      url.includes("/chat_conversations/")
        ? jsonRes(attachDetail)
        : (() => {
            throw new Error(url);
          })(),
  });
  js.allEls.find((e) => e.id === "__claude_export_btn")._on.click();
  const obj = JSON.parse(String((await js.downloaded).blob.parts[0]));
  const att = obj.messages[0].attachments;
  check("json attachments array", Array.isArray(att) && att.length === 1);
  check(
    "json attachment fields",
    att[0].file_name === "spec.txt" &&
      att[0].file_size === 42 &&
      att[0].extracted_content === "PASTED BODY",
  );

  const off = makeSandbox({
    cookieOrg: ORG,
    pathname: `/chat/${CHAT}`,
    settings: { format: "md", frontmatter: false, includeAttachments: false },
    fetchImpl: (url) =>
      url.includes("/chat_conversations/")
        ? jsonRes(attachDetail)
        : (() => {
            throw new Error(url);
          })(),
  });
  off.allEls.find((e) => e.id === "__claude_export_btn")._on.click();
  check(
    "attachments omitted when toggle off",
    !String((await off.downloaded).blob.parts[0]).includes("📎"),
  );
}
await testAttachmentsMarkdownAndJson();

async function testContentToggles() {
  const s = makeSandbox({
    cookieOrg: ORG,
    pathname: "/new",
    settings: undefined,
    fetchImpl: () => {
      throw new Error("no fetch");
    },
  });
  const think = s.allEls.find((e) => e.id === "__cce_thinking");
  const tools = s.allEls.find((e) => e.id === "__cce_tools");
  const attach = s.allEls.find((e) => e.id === "__cce_attachments");
  check("thinking checkbox exists", !!think);
  check("tools checkbox exists", !!tools);
  check("attachments checkbox exists", !!attach);
  check("thinking default checked", think.checked === true);
  think.checked = false;
  think._on.change?.();
  check(
    "unchecking thinking persists",
    s.gmStore.cce_settings.includeThinking === false,
  );
  tools.checked = false;
  tools._on.change?.();
  check(
    "unchecking tools persists",
    s.gmStore.cce_settings.includeToolCalls === false,
  );
  attach.checked = false;
  attach._on.change?.();
  check(
    "unchecking attachments persists",
    s.gmStore.cce_settings.includeAttachments === false,
  );
}
await testContentToggles();

const parallelToolsDetail = {
  uuid: CHAT,
  name: "Parallel Tools",
  chat_messages: [
    {
      sender: "assistant",
      content: [
        { type: "tool_use", id: "a", name: "t1", input: { x: 1 } },
        { type: "tool_use", id: "b", name: "t2", input: { y: 2 } },
        {
          type: "tool_result",
          tool_use_id: "a",
          content: [{ type: "text", text: "RA" }],
        },
        {
          type: "tool_result",
          tool_use_id: "b",
          content: [{ type: "text", text: "RB" }],
          is_error: true,
        },
      ],
      created_at: "2026-07-11T09:30:00Z",
    },
  ],
};

async function testParallelToolPairingJson() {
  const s = makeSandbox({
    cookieOrg: ORG,
    pathname: `/chat/${CHAT}`,
    settings: { format: "json" },
    fetchImpl: (url) =>
      url.includes("/chat_conversations/")
        ? jsonRes(parallelToolsDetail)
        : (() => {
            throw new Error(url);
          })(),
  });
  s.allEls.find((e) => e.id === "__claude_export_btn")._on.click();
  const obj = JSON.parse(String((await s.downloaded).blob.parts[0]));
  const tools = obj.messages[0].tools;
  check(
    "parallel tool a paired correctly",
    tools[0].name === "t1" &&
      tools[0].result === "RA" &&
      tools[0].is_error === false,
  );
  check(
    "parallel tool b paired correctly",
    tools[1].name === "t2" &&
      tools[1].result === "RB" &&
      tools[1].is_error === true,
  );
}
await testParallelToolPairingJson();

const thinkingOnlyDetail = {
  uuid: CHAT,
  name: "Thinking Only",
  chat_messages: [
    {
      sender: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "reasoning here",
          hidden: false,
          thinking_hidden: false,
        },
      ],
      text: "FALLBACK BODY",
      created_at: "2026-07-11T09:40:00Z",
    },
  ],
};

async function testMsgTextFallbackConsistency() {
  const md = makeSandbox({
    cookieOrg: ORG,
    pathname: `/chat/${CHAT}`,
    settings: { format: "md", frontmatter: false },
    fetchImpl: (url) =>
      url.includes("/chat_conversations/")
        ? jsonRes(thinkingOnlyDetail)
        : (() => {
            throw new Error(url);
          })(),
  });
  md.allEls.find((e) => e.id === "__claude_export_btn")._on.click();
  const text = String((await md.downloaded).blob.parts[0]);
  check("markdown includes msg.text fallback", text.includes("FALLBACK BODY"));

  const js = makeSandbox({
    cookieOrg: ORG,
    pathname: `/chat/${CHAT}`,
    settings: { format: "json" },
    fetchImpl: (url) =>
      url.includes("/chat_conversations/")
        ? jsonRes(thinkingOnlyDetail)
        : (() => {
            throw new Error(url);
          })(),
  });
  js.allEls.find((e) => e.id === "__claude_export_btn")._on.click();
  const obj = JSON.parse(String((await js.downloaded).blob.parts[0]));
  check(
    "json includes msg.text fallback",
    obj.messages[0].text === "FALLBACK BODY",
  );
}
await testMsgTextFallbackConsistency();

// A `text` block without a `type` (the legacy documented shape
// `content: [{ text }]`) must still count as message text in both walkers —
// in document order, not via the msg.text fallback.
const untypedDetail = {
  uuid: CHAT,
  name: "Untyped",
  chat_messages: [
    {
      sender: "human",
      content: [{ text: "typeless question" }],
      created_at: "2026-07-11T10:00:00Z",
    },
    {
      sender: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { text: "typeless answer" },
      ],
      created_at: "2026-07-11T10:01:00Z",
    },
  ],
};

async function testUntypedTextBlocks() {
  const md = makeSandbox({
    cookieOrg: ORG,
    pathname: `/chat/${CHAT}`,
    settings: { format: "md", frontmatter: false },
    fetchImpl: (url) =>
      url.includes("/chat_conversations/")
        ? jsonRes(untypedDetail)
        : (() => {
            throw new Error(url);
          })(),
  });
  md.allEls.find((e) => e.id === "__claude_export_btn")._on.click();
  const text = String((await md.downloaded).blob.parts[0]);
  check(
    "untyped text block rendered (md, human)",
    text.includes("typeless question"),
  );
  check(
    "untyped text block rendered with rich block (md)",
    text.includes("typeless answer"),
  );
  check(
    "untyped text in document order (after thinking, not fallback)",
    text.indexOf("Extended thinking") < text.indexOf("typeless answer"),
  );

  const js = makeSandbox({
    cookieOrg: ORG,
    pathname: `/chat/${CHAT}`,
    settings: { format: "json" },
    fetchImpl: (url) =>
      url.includes("/chat_conversations/")
        ? jsonRes(untypedDetail)
        : (() => {
            throw new Error(url);
          })(),
  });
  js.allEls.find((e) => e.id === "__claude_export_btn")._on.click();
  const obj = JSON.parse(String((await js.downloaded).blob.parts[0]));
  check(
    "untyped text in json (human)",
    obj.messages[0].text === "typeless question",
  );
  check(
    "untyped text in json (assistant, with thinking)",
    obj.messages[1].text === "typeless answer",
  );
}
await testUntypedTextBlocks();

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
