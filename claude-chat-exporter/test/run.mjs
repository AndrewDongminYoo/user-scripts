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

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
