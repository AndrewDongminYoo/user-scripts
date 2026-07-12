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
  // The sidebar is a collapsible drawer, absent from the DOM while closed.
  // mat-nav-list is the confirmed mount container: it holds the
  // gem-nav-list-item conversation rows plus the top ("새 채팅"/"채팅 검색")
  // and bottom (account) rows, and was live-verified visible with 33 nav
  // items when the drawer is open (2026-07-12).
  sidebar: "mat-nav-list",
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

/** Quotes a YAML scalar, escaping backslashes before quotes (order matters). */
function yamlStr(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** ---------- Batchexecute transport (observe-replay) ---------- */
// Gemini's data API is `batchexecute` over XHR — there is no clean REST
// endpoint. We NEVER reconstruct a request: an interceptor records the app's
// own batchexecute calls (the full URL incl. rotating `rpcids`/`bl`/`f.sid`,
// the request headers, and the `f.req` body which already carries the session
// `at` XSRF token), then Export-All REPLAYS a stored template with only the
// conversation id and `_reqid` changed. Because the replay reuses the app's
// real, current request material, it self-heals across Gemini build rotation —
// only a payload-structure change needs a parser refresh. (Verified live
// 2026-07-12: a same-origin credentialed replay returns the full payload.)

interface BxTemplate {
  url: string;
  headers: Record<string, string>;
  // "f.req=<url-encoded outer>&at=<token>" — replayed with only the args swapped.
  body: string;
}

// Latest APP-originated template per rpcid. Our own replays go through the
// saved original fetch (below) so they are never recorded as templates.
const bxTemplates = new Map<string, BxTemplate>();

// `_reqid` is a global monotonic counter in the app: every batchexecute call
// increments it by exactly +100000 (offset tied to `f.sid`). Replays MUST
// continue the sequence — a random `_reqid` yields empty/throttled responses
// (verified live). We track the highest observed and hand out max + 100000.
let bxMaxReqid = 0;
const BX_REQID_STEP = 100000;

// Saved originals: replays use these so the interceptor never records them,
// and so a page that later re-patches fetch/XHR cannot shadow our transport.
const bxOrigFetch = typeof fetch === "function" ? fetch.bind(globalThis) : null;

function bxIsBatch(u: string | null | undefined): u is string {
  return typeof u === "string" && u.indexOf("/batchexecute") !== -1;
}
function bxRpcids(u: string): string | null {
  try {
    return new URL(u, location.origin).searchParams.get("rpcids");
  } catch {
    return null;
  }
}
function bxNoteReqid(u: string): void {
  try {
    const n = Number(new URL(u, location.origin).searchParams.get("_reqid"));
    if (Number.isFinite(n) && n > bxMaxReqid) bxMaxReqid = n;
  } catch {
    /* not a parseable url */
  }
}
function bxNextReqid(): number {
  bxMaxReqid += BX_REQID_STEP;
  return bxMaxReqid;
}

// Record a template from an app-originated batchexecute request. We keep the
// request body (which contains `at`) verbatim; the response is not stored —
// replays fetch fresh.
function bxRecord(
  url: string,
  headers: Record<string, string>,
  body: string | null,
): void {
  const rpcids = bxRpcids(url);
  bxNoteReqid(url);
  if (!rpcids || typeof body !== "string") return;
  bxTemplates.set(rpcids, { url, headers, body });
}

interface XhrMeta {
  __bxUrl?: string;
  __bxHeaders?: Record<string, string>;
}

// Normalize a fetch `HeadersInit` into a plain object (defensive fetch path).
function bxHeadersToObject(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k] = v;
  } else if (typeof (h as Headers).forEach === "function") {
    (h as Headers).forEach((v, k) => {
      out[k] = v;
    });
  } else {
    Object.assign(out, h as Record<string, string>);
  }
  return out;
}

// Install the observe-replay interceptor. All batchexecute traffic is XHR, so
// XHR is the primary patch; fetch is patched defensively. No-ops when the host
// lacks XHR/fetch (e.g. the Node test sandbox), so the bundle still loads.
function bxInstallInterceptor(): void {
  if (typeof XMLHttpRequest !== "undefined") {
    const proto = XMLHttpRequest.prototype;
    const open = proto.open;
    const send = proto.send;
    const setHeader = proto.setRequestHeader;
    proto.open = function (
      this: XMLHttpRequest & XhrMeta,
      _method: string,
      url: string | URL,
    ): void {
      this.__bxUrl = typeof url === "string" ? url : url.href;
      this.__bxHeaders = {};
      // eslint-disable-next-line prefer-rest-params
      return open.apply(this, arguments as never);
    };
    proto.setRequestHeader = function (
      this: XMLHttpRequest & XhrMeta,
      name: string,
      value: string,
    ): void {
      if (this.__bxHeaders) this.__bxHeaders[name] = value;
      return setHeader.call(this, name, value);
    };
    proto.send = function (
      this: XMLHttpRequest & XhrMeta,
      body?: Document | XMLHttpRequestBodyInit | null,
    ): void {
      if (bxIsBatch(this.__bxUrl)) {
        bxRecord(
          this.__bxUrl,
          this.__bxHeaders ?? {},
          typeof body === "string" ? body : null,
        );
      }
      return send.call(this, body ?? null);
    };
  }
  if (typeof fetch === "function" && bxOrigFetch) {
    globalThis.fetch = function (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (bxIsBatch(url) && init && typeof init.body === "string") {
        bxRecord(url, bxHeadersToObject(init.headers), init.body);
      }
      return bxOrigFetch(input as RequestInfo, init);
    };
  }
}
bxInstallInterceptor();

// Decode a batchexecute envelope into its rows. Format: `)]}'` guard, then
// repeating `<byteLen>\n<jsonChunk>\n`. The byte-length prefix is UNSAFE to
// slice against a UTF-16 string (multibyte chars overrun), so instead we split
// on newlines and JSON.parse each line that begins with `[` — the JSON chunks
// never contain a raw newline (they are escaped as `\n`). (Verified live.)
function bxDecode(text: string): unknown[] {
  const rows: unknown[] = [];
  const body = text.replace(/^\)\]\}'/, "");
  for (const line of body.split("\n")) {
    const s = line.trim();
    if (s[0] !== "[") continue;
    try {
      const arr: unknown = JSON.parse(s);
      if (Array.isArray(arr)) for (const r of arr) rows.push(r);
    } catch {
      /* a length-prefix line, not JSON */
    }
  }
  return rows;
}

// Extract a single RPC's payload: the row `["wrb.fr", rpcid, <jsonString>, ...]`.
function bxPayload(text: string, rpcid: string): unknown {
  for (const r of bxDecode(text)) {
    if (
      Array.isArray(r) &&
      r[0] === "wrb.fr" &&
      r[1] === rpcid &&
      typeof r[2] === "string"
    ) {
      try {
        return JSON.parse(r[2]);
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Rebuild a template's `f.req=...&at=...` body, mutating the target rpc's args
// (the JSON string at `outer[0][<rpc>][1]`). Only the args are touched; `at`
// and every other field are replayed verbatim.
function bxBuildBody(
  templateBody: string,
  rpcid: string,
  mutate: (args: unknown[]) => void,
): string {
  const atIdx = templateBody.indexOf("&at=");
  const freqPart = atIdx >= 0 ? templateBody.slice(0, atIdx) : templateBody;
  const atPart = atIdx >= 0 ? templateBody.slice(atIdx) : "";
  const outer: unknown = JSON.parse(
    decodeURIComponent(freqPart.replace(/^f\.req=/, "")),
  );
  if (!Array.isArray(outer) || !Array.isArray(outer[0]))
    throw new Error("unexpected f.req shape");
  const calls = outer[0] as unknown[];
  const entry = (calls.find((e) => Array.isArray(e) && e[0] === rpcid) ??
    calls[0]) as unknown[];
  if (!Array.isArray(entry) || typeof entry[1] !== "string")
    throw new Error("unexpected f.req call shape");
  const args: unknown = JSON.parse(entry[1]);
  if (!Array.isArray(args)) throw new Error("unexpected args shape");
  mutate(args);
  entry[1] = JSON.stringify(args);
  return "f.req=" + encodeURIComponent(JSON.stringify(outer)) + atPart;
}

function bxSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Replay a learned template with the target rpc's args mutated, returning the
// decoded payload (or null). Retries once on an empty/undecodable response —
// rapid replays are non-deterministic and can return an empty body (verified
// live); a fresh `_reqid` on retry recovers it.
async function bxReplay(
  rpcid: string,
  mutate: (args: unknown[]) => void,
): Promise<unknown> {
  const tpl = bxTemplates.get(rpcid);
  if (!tpl) throw new Error(`batchexecute template not learned: ${rpcid}`);
  if (!bxOrigFetch) throw new Error("fetch unavailable");
  const body = bxBuildBody(tpl.body, rpcid, mutate);
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = new URL(tpl.url, location.origin);
    url.searchParams.set("_reqid", String(bxNextReqid()));
    const resp = await bxOrigFetch(url.toString(), {
      method: "POST",
      headers: tpl.headers,
      body,
      credentials: "include",
    });
    const text = await resp.text();
    const payload = bxPayload(text, rpcid);
    if (payload != null) return payload;
    await bxSleep(600);
  }
  return null;
}

/** ---------- Export-All: content parser (hNvQHb -> Conversation) ---------- */
// `args[1]` is a TURN page-size cap (verified live: size N returns at most N of
// the conversation's turns). We request more than any real conversation has so
// short conversations return in a single call. `payload[1]` is a continuation
// cursor: a non-null value means the conversation has MORE turns than we
// fetched — i.e. it was truncated — which we surface per-conversation rather
// than silently dropping turns. (At this page size no real conversation
// truncates; the cursor is a guard, not a paging driver.)
const CONTENT_RPCID = "hNvQHb";
const CONTENT_PAGE_SIZE = 1000;

interface ParsedTurns {
  turns: Turn[];
  truncated: boolean;
  skipped: number;
}

// Read a nested string leaf by index path; null if any hop is missing or the
// leaf is not a string. Pinned paths (verified live against real payloads):
//   prompt   = turn[2][0][0]
//   response = turn[3][0][0][1][0]   (Markdown source)
function bxLeafString(root: unknown, path: number[]): string | null {
  let cur: unknown = root;
  for (const i of path) {
    if (!Array.isArray(cur)) return null;
    cur = cur[i];
  }
  return typeof cur === "string" ? cur : null;
}

// Parse an `hNvQHb` payload into the existing Turn[] shape. `payload[0]` is the
// per-turn array; each turn is defensively read at the pinned leaf paths, and a
// turn whose shape matches neither prompt nor response is skipped and counted
// (never silently dropped).
function parseContentPayload(payload: unknown): ParsedTurns {
  const turns: Turn[] = [];
  let skipped = 0;
  if (!Array.isArray(payload)) return { turns, truncated: false, skipped };
  const rawTurns = Array.isArray(payload[0]) ? (payload[0] as unknown[]) : [];
  const truncated = typeof payload[1] === "string" && payload[1].length > 0;
  for (const rt of rawTurns) {
    const prompt = bxLeafString(rt, [2, 0, 0]);
    const response = bxLeafString(rt, [3, 0, 0, 1, 0]);
    if (prompt == null && response == null) {
      skipped++;
      continue;
    }
    turns.push({
      index: turns.length,
      prompt: prompt ?? "",
      attachments: [],
      // Image-generation turns carry a render tree, not Markdown; keep the
      // prompt and mark the response rather than dropping the whole turn.
      responseMarkdown: response ?? "_[non-text response]_",
    });
  }
  return { turns, truncated, skipped };
}

interface FetchedConversation {
  conv: Conversation;
  truncated: boolean;
  skipped: number;
}

// Replay the learned content template for one conversation id (swapping only
// `c_<id>` and bumping the page size). Returns the existing Conversation shape,
// so toMarkdown/toJSON/renderConversation are reused unchanged.
async function fetchConversationContent(
  convId: string,
  title: string,
): Promise<FetchedConversation> {
  const payload = await bxReplay(CONTENT_RPCID, (args) => {
    args[0] = "c_" + convId;
    if (typeof args[1] === "number") args[1] = CONTENT_PAGE_SIZE;
  });
  const { turns, truncated, skipped } = parseContentPayload(payload);
  return {
    conv: {
      id: convId,
      title,
      url: `https://gemini.google.com/app/${convId}`,
      turns,
    },
    truncated,
    skipped,
  };
}

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

function listMd(el: Element, ordered: boolean, depth = 0): string {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  let n = 1;
  el.childNodes.forEach((c) => {
    if (c.nodeType === 1 && (c as Element).nodeName === "LI") {
      const li = c as Element;
      const marker = ordered ? `${n++}.` : "-";
      let inline = "";
      const nested: string[] = [];
      li.childNodes.forEach((child) => {
        const name = child.nodeType === 1 ? (child as Element).nodeName : "";
        if (name === "UL" || name === "OL") {
          nested.push(listMd(child as Element, name === "OL", depth + 1));
        } else {
          inline += inlineMd(child);
        }
      });
      lines.push(`${indent}${marker} ${inline.trim()}`);
      nested.forEach((n2) => {
        if (n2) lines.push(n2);
      });
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

/** Joins an element's block-level children with blank lines (recursive block walk). */
function blocksOf(el: Element): string {
  const blocks: string[] = [];
  el.childNodes.forEach((node) => {
    if (node.nodeType === 3) {
      const t = (node.textContent ?? "").trim();
      if (t) blocks.push(t);
    } else if (node.nodeType === 1) {
      const child = node as Element;
      if (BLOCK_TAGS.has(child.nodeName)) blocks.push(blockMd(child));
      else {
        const inline = inlineMd(child).trim();
        if (inline) blocks.push(inline);
      }
    }
  });
  return blocks.filter(Boolean).join("\n\n").trim();
}

/** True if any direct child is a block-level element (see BLOCK_TAGS). */
function hasBlockChildren(el: Element): boolean {
  let found = false;
  el.childNodes.forEach((c) => {
    if (c.nodeType === 1 && BLOCK_TAGS.has((c as Element).nodeName))
      found = true;
  });
  return found;
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
      return `\`\`\`${lang}\n${body.replace(/\n+$/, "")}\n\`\`\``;
    }
    case "P":
      return childrenInline(el).trim();
    default:
      return hasBlockChildren(el) ? blocksOf(el) : childrenInline(el).trim();
  }
}

function htmlToMarkdown(root: Element | null): string {
  if (!root) return "";
  return blocksOf(root);
}

/** ---------- Extraction ---------- */
// Gemini collapses reasoning behind a toggle; expand before reading so the
// text is in the DOM. Best-effort: click a control if the overlay is collapsed.
function expandCollapsed(container: Element): void {
  const overlay = container.querySelector(SEL.thinking);
  if (!overlay) return;
  // If reasoning text is already in the DOM, it is inline/expanded — do not
  // toggle (a click could collapse it). Only click a toggle when there is
  // nothing to read yet. (Live-verified: thinking-overlay carries no
  // aria-expanded on the container, and is an empty placeholder when the
  // response used no reasoning.)
  if ((overlay.textContent ?? "").trim()) return;
  const btn = overlay.querySelector("button, [role='button']");
  if (btn) (btn as HTMLElement).click();
}

// Gemini's <infinite-scroller> lazy-loads older turns on upward scroll but
// does NOT evict rendered nodes (live-verified 2026-07-12: a 4-turn chat
// overflowing its viewport 91x kept all nodes across scroll). So scrolling
// to top until the count stabilizes, then a single document-order collect,
// captures every turn. Assumes no DOM eviction.
async function ensureAllTurnsLoaded(): Promise<void> {
  const scroller = document.querySelector(SEL.scroller);
  if (!scroller) return;
  let prev = -1;
  let stable = 0;
  for (let i = 0; i < 60 && stable < 2; i++) {
    const count = document.querySelectorAll(SEL.turn).length;
    stable = count === prev ? stable + 1 : 0;
    prev = count;
    scroller.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function scrapeCurrentConversation(): Promise<Conversation> {
  const id = getConversationId() ?? "";
  await ensureAllTurnsLoaded();
  // Expand every thinking overlay up front, then let expansion settle,
  // before reading textContent below. expandCollapsed only clicks a toggle;
  // if Gemini renders the expanded reasoning asynchronously, reading
  // immediately after the click could capture stale/empty text, so the
  // expand pass and the read pass are split with a settle delay between them.
  if (settings.includeThinking) {
    document.querySelectorAll(SEL.turn).forEach((c) => expandCollapsed(c));
  }
  await new Promise((r) => setTimeout(r, 300));
  const turns: Turn[] = [];
  document.querySelectorAll(SEL.turn).forEach((c) => {
    // Scope query/response/attachment lookups to their parent element
    // (user-query / model-response). An unscoped `.markdown` query would
    // return the FIRST such node in document order anywhere in the
    // container, which could be a thinking-overlay's own `.markdown` if
    // one ever precedes the response — scoping under model-response
    // guarantees we read the actual response body.
    const prompt = (
      c.querySelector(`${SEL.userQuery} ${SEL.queryText}`)?.textContent ?? ""
    ).trim();
    const responseMarkdown = htmlToMarkdown(
      c.querySelector(`${SEL.modelResponse} ${SEL.responseMarkdown}`),
    );
    const thinking = settings.includeThinking
      ? (c.querySelector(SEL.thinking)?.textContent ?? "").trim()
      : "";
    const attachments = settings.includeAttachments
      ? Array.from(c.querySelectorAll(`${SEL.userQuery} ${SEL.attachmentChip}`))
          .map((a) => (a.textContent ?? "").trim())
          .filter(Boolean)
      : [];
    if (!prompt && !responseMarkdown && !thinking && !attachments.length)
      return;
    const turn: Turn = {
      index: turns.length,
      prompt,
      attachments,
      responseMarkdown,
    };
    if (thinking) turn.thinking = thinking;
    turns.push(turn);
  });
  return {
    id,
    title: getTitle(),
    url: `https://gemini.google.com/app/${id}`,
    turns,
  };
}

/** ---------- Markdown renderer ---------- */
function toMarkdown(conv: Conversation, s: Settings): string {
  const out: string[] = [];
  if (s.frontmatter) {
    out.push(
      "---",
      `title: ${yamlStr(conv.title)}`,
      `source: ${yamlStr(conv.url)}`,
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

/** ---------- JSON renderer ---------- */
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

/** ---------- Render dispatch ---------- */
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
  const conv = await scrapeCurrentConversation();
  if (!conv.turns.length) throw new Error("No conversation turns found.");
  const { text, extension, mime } = renderConversation(conv, settings);
  downloadBlob(
    `${sanitizeFilename(conv.title)}.${extension}`,
    new Blob([text], { type: mime }),
  );
}

/** ---------- Store-only ZIP (no dependency) ---------- */
// Ported verbatim from claude-chat-exporter. Each userscript is a standalone,
// import-free single file, so this cross-package duplication is the mandated
// architecture, not a DRY defect.
const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = (CRC_TABLE[(c ^ bytes[i]) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n: number): number[] => [
  n & 0xff,
  (n >>> 8) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 24) & 0xff,
];
interface ZipEntry {
  name: string;
  data: Uint8Array;
}
function zipStore(files: ZipEntry[]): Blob {
  const enc = new TextEncoder();
  const parts: Array<Uint8Array | number[]> = [];
  const central: number[] = [];
  let offset = 0;
  const dosDate = 0x0021; // 1980-01-01, avoids "invalid date" warnings
  const dosTime = 0x0000;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const local: number[] = [
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0x0800),
      ...u16(0),
      ...u16(dosTime),
      ...u16(dosDate),
      ...u32(crc),
      ...u32(size),
      ...u32(size),
      ...u16(nameBytes.length),
      ...u16(0),
      ...nameBytes,
    ];
    parts.push(local, f.data);
    central.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0x0800),
      ...u16(0),
      ...u16(dosTime),
      ...u16(dosDate),
      ...u32(crc),
      ...u32(size),
      ...u32(size),
      ...u16(nameBytes.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offset),
      ...nameBytes,
    );
    offset += local.length + size;
  }
  const eocd: number[] = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(files.length),
    ...u16(files.length),
    ...u32(central.length),
    ...u32(offset),
    ...u16(0),
  ];
  const blobParts: BlobPart[] = [];
  for (const p of parts) blobParts.push(new Uint8Array(p));
  blobParts.push(new Uint8Array(central), new Uint8Array(eocd));
  return new Blob(blobParts, { type: "application/zip" });
}
function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base.toLowerCase())) {
    used.add(base.toLowerCase());
    return base;
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let i = 1;
  let name = `${stem} (${i})${ext}`;
  while (used.has(name.toLowerCase())) {
    i++;
    name = `${stem} (${i})${ext}`;
  }
  used.add(name.toLowerCase());
  return name;
}

/** ---------- Export-All: conversation list enumeration ---------- */
// (Task 3) The full conversation list loads at page boot via batchexecute
// (observed live: rpcids CNgdBe first, then MaZiqc pages; the /search box then
// filters client-side). The document-start interceptor learns that template;
// Export-All replays it to enumerate every conversation.
//
// UNVERIFIED: the exact {id,title} leaf paths in the list payload are NOT yet
// pinned — the list fires only at boot, which recon tooling cannot capture
// before injection; only the document-start userscript sees it. `extractList`
// below is a best-effort generic walker to be tightened once a real list
// payload is captured with the script loaded. Content transport + parsing
// (Tasks 1-2) ARE live-verified; this enumeration is the one unverified seam.
const LIST_RPCIDS = ["CNgdBe", "MaZiqc"];
const CONV_ID_RE = /^[0-9a-f]{12,}$/i;

// Best-effort walk: collect entries that pair a conversation id with a title.
// A conversation id appears as `c_<hex>` (content args) or bare `<hex>` (list);
// the nearest short human string in the same node is taken as the title.
function extractList(payload: unknown): { id: string; title: string }[] {
  const found = new Map<string, string>();
  const visit = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    let id: string | null = null;
    let title: string | null = null;
    for (const el of node) {
      if (typeof el !== "string") continue;
      const bare = el.startsWith("c_") ? el.slice(2) : el;
      if (CONV_ID_RE.test(bare)) {
        if (!id) id = bare;
      } else if (!title && el.trim() && el.length <= 200) {
        title = el.trim();
      }
    }
    if (id && !found.has(id)) found.set(id, title ?? id);
    for (const el of node) visit(el);
  };
  visit(payload);
  return [...found].map(([id, title]) => ({ id, title }));
}

async function listAllConversations(): Promise<
  { id: string; title: string }[]
> {
  const rpcid = LIST_RPCIDS.find((r) => bxTemplates.has(r));
  if (!rpcid)
    throw new Error(
      "대화 목록을 아직 학습하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도하세요.",
    );
  const payload = await bxReplay(rpcid, () => {
    /* replay list template as-is (cursor paging TODO once shape is pinned) */
  });
  const list = extractList(payload);
  if (!list.length)
    throw new Error("대화 목록을 해석하지 못했습니다 (목록 파서 검증 필요).");
  return list;
}

/** ---------- Export-All: orchestrator ---------- */
interface ExportAllResult {
  exported: number;
  failed: number;
  truncated: number;
}

// Serial, paced fetches: batchexecute replays are non-deterministic under
// bursts (verified live), so one-at-a-time with a small delay is both the
// safest for the endpoint and the most reliable. Snapshots current settings.
async function exportAllConversations(
  list: { id: string; title: string }[],
  onProgress: (done: number, total: number) => void,
): Promise<ExportAllResult> {
  const used = new Set<string>();
  const entries: ZipEntry[] = [];
  const enc = new TextEncoder();
  let exported = 0;
  let failed = 0;
  let truncated = 0;
  const date = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item) continue;
    onProgress(i, list.length);
    try {
      const { conv, truncated: tr } = await fetchConversationContent(
        item.id,
        item.title,
      );
      if (!conv.turns.length) {
        failed++;
      } else {
        if (tr) truncated++;
        const { text, extension } = renderConversation(conv, settings);
        const name = uniqueName(
          `${date} ${sanitizeFilename(item.title)}.${extension}`,
          used,
        );
        entries.push({ name, data: enc.encode(text) });
        exported++;
      }
    } catch (err) {
      console.error("[gemini-chat-exporter]", err);
      failed++;
    }
    await bxSleep(400);
  }
  if (entries.length)
    downloadBlob(`gemini-conversations-${date}.zip`, zipStore(entries));
  return { exported, failed, truncated };
}

/** ---------- UI ---------- */
const ONE_ID = "__gce_export_btn";
const ONE_LABEL = "⬇ Export this chat";
const ALL_ID = "__gce_export_all_btn";
const ALL_LABEL = "⬇ Export all chats (ZIP)";
const MODAL_ID = "__gce_modal";
const TRIGGER_ID = "__gce_export_trigger";

// GM_addStyle both styles the UI and, as a real @grant, forces Tampermonkey into
// its sandboxed world so the script is exempt from Gemini's CSP. Gemini exposes
// no themeable custom properties like Claude's --bg-*/--text-*, so these use
// Material-style literal colors with a prefers-color-scheme dark override.
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
  #${MODAL_ID} .gce-actions { display:flex; flex-direction:column; gap:8px; margin-top:8px; }
  #${MODAL_ID} .gce-btn { flex:1; padding:10px; border:none; border-radius:8px; cursor:pointer; font-weight:600; font-size:14px; }
  #${MODAL_ID} .gce-btn:disabled { opacity:.6; cursor:default; }
  #${MODAL_ID} .gce-primary { background:#1a73e8; color:#fff; }
  #${MODAL_ID} .gce-progress { margin-top:10px; min-height:18px; font-size:13px; color:#5f6368; text-align:center; }
  #${TRIGGER_ID} { display:flex; align-items:center; gap:8px; width:calc(100% - 16px); margin:0 8px; height:40px; padding:0 12px; border:none; background:transparent; cursor:pointer; font:400 14px/1 "Google Sans", system-ui, sans-serif; color:#444746; border-radius:999px; text-align:left; }
  #${TRIGGER_ID}:hover { background:rgba(0,0,0,.06); }
  #${TRIGGER_ID} .gce-lead { flex:0 0 auto; display:flex; align-items:center; justify-content:center; width:20px; height:20px; }
  #${TRIGGER_ID} .gce-lead svg { width:20px; height:20px; }
  #${TRIGGER_ID}.gce-floating { position:fixed; bottom:20px; right:20px; z-index:2147483646; width:auto; height:auto; padding:10px 16px; margin:0; background:#1a73e8; color:#fff; font-weight:600; border-radius:999px; box-shadow:0 2px 8px rgba(0,0,0,.25); }
  @media (prefers-color-scheme: dark) {
    #${MODAL_ID} .gce-panel { background:#1e1f20; color:#e3e3e3; border-color:#444746; }
    #${MODAL_ID} .gce-seg { background:#2d2e30; }
    #${MODAL_ID} .gce-seg input:checked + label { background:#131314; color:#e3e3e3; }
    #${TRIGGER_ID} { color:#c4c7c5; }
    #${TRIGGER_ID}:hover { background:rgba(255,255,255,.08); }
  }
`);

// Wired up when the modal is built; referenced by runExport + syncMdOnly.
let progressEl: HTMLDivElement | null = null;
let mdOnlyRows: HTMLDivElement[] = [];

function setProgress(text: string): void {
  if (progressEl) progressEl.textContent = text;
}

function elc<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function runExport(
  btn: HTMLButtonElement,
  defaultLabel: string,
  task: () => Promise<string>,
): void {
  btn.disabled = true;
  setProgress("");
  void (async (): Promise<void> => {
    try {
      const doneLabel = await task();
      btn.textContent = doneLabel;
      setProgress(doneLabel);
    } catch (err) {
      console.error("[gemini-chat-exporter]", err);
      btn.textContent = "Failed";
      setProgress("Failed");
    } finally {
      setTimeout(() => {
        btn.textContent = defaultLabel;
        btn.disabled = false;
      }, 2000);
    }
  })();
}

function openModal(): void {
  document.getElementById(MODAL_ID)?.classList.add("open");
}

function closeModal(): void {
  document.getElementById(MODAL_ID)?.classList.remove("open");
}

// frontmatter is the only md-only option (no message-timestamps row here) —
// it's meaningless for JSON, so dim it when format is json.
function syncMdOnly(): void {
  const dim = settings.format === "json";
  for (const r of mdOnlyRows) r.classList.toggle("gce-disabled", dim);
}

// A labeled switch backed by a real checkbox with a stable id. The test harness
// drives these by id, so keep real inputs and style the track/knob with CSS.
function swRow(
  id: string,
  label: string,
  key: Exclude<keyof Settings, "format">,
): HTMLDivElement {
  const row = elc("div", "gce-row");
  const text = elc("span");
  text.textContent = label;
  const sw = elc("label", "gce-sw");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = id;
  input.checked = settings[key];
  input.addEventListener("change", () => {
    settings = { ...settings, [key]: input.checked };
    saveSettings(settings);
  });
  const track = elc("span", "gce-track");
  sw.appendChild(input);
  sw.appendChild(track);
  row.appendChild(text);
  row.appendChild(sw);
  return row;
}

function buildModal(): HTMLDivElement {
  const modal = elc("div");
  modal.id = MODAL_ID;
  const backdrop = elc("div", "gce-backdrop");
  backdrop.addEventListener("click", closeModal);
  const panel = elc("div", "gce-panel");

  const head = elc("div", "gce-head");
  const title = elc("div", "gce-title");
  title.textContent = "Exporter Settings";
  const x = elc("button", "gce-x");
  x.type = "button";
  x.textContent = "✕";
  x.addEventListener("click", closeModal);
  head.appendChild(title);
  head.appendChild(x);

  // Format: real radios (stable ids) styled as a segmented control via CSS.
  const seg = elc("div", "gce-seg gce-section");
  const mkFmt = (id: string, val: Format, label: string): void => {
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "gce_fmt";
    input.id = id;
    input.checked = settings.format === val;
    input.addEventListener("change", () => {
      if (!input.checked) return;
      settings = { ...settings, format: val };
      saveSettings(settings);
      syncMdOnly();
    });
    const lab = document.createElement("label");
    lab.htmlFor = id;
    lab.textContent = label;
    seg.appendChild(input);
    seg.appendChild(lab);
  };
  mkFmt("__gce_fmt_md", "md", "Markdown");
  mkFmt("__gce_fmt_json", "json", "JSON");

  const opts = elc("div", "gce-section");
  const fmRow = swRow("__gce_frontmatter", "Frontmatter (md)", "frontmatter");
  mdOnlyRows = [fmRow];
  opts.appendChild(fmRow);
  opts.appendChild(
    swRow("__gce_thinking", "Extended thinking", "includeThinking"),
  );
  opts.appendChild(
    swRow("__gce_attachments", "Attachments", "includeAttachments"),
  );

  const actions = elc("div", "gce-actions");
  const oneBtn = elc("button", "gce-btn gce-primary");
  oneBtn.id = ONE_ID;
  oneBtn.type = "button";
  oneBtn.textContent = ONE_LABEL;
  progressEl = elc("div", "gce-progress");

  oneBtn.addEventListener("click", () => {
    runExport(oneBtn, ONE_LABEL, async () => {
      await exportCurrentConversation();
      return "Done";
    });
  });
  actions.appendChild(oneBtn);

  // Export-All reuses the observe-replay transport (learned from the app's own
  // batchexecute traffic). If no chat has been opened this session the content
  // template is not learned yet, so it prompts the user to open one first.
  const allBtn = elc("button", "gce-btn gce-primary");
  allBtn.id = ALL_ID;
  allBtn.type = "button";
  allBtn.textContent = ALL_LABEL;
  allBtn.addEventListener("click", () => {
    runExport(allBtn, ALL_LABEL, async () => {
      if (!bxTemplates.has(CONTENT_RPCID))
        throw new Error(
          "먼저 아무 대화나 한 번 열어 Export-All을 활성화하세요.",
        );
      const list = await listAllConversations();
      const result = await exportAllConversations(list, (done, total) => {
        setProgress(`${done}/${total} 내보내는 중…`);
      });
      const parts = [`${result.exported} exported`];
      if (result.failed) parts.push(`${result.failed} failed`);
      if (result.truncated) parts.push(`${result.truncated} truncated`);
      return parts.join(", ");
    });
  });
  actions.appendChild(allBtn);

  panel.appendChild(head);
  panel.appendChild(seg);
  panel.appendChild(opts);
  panel.appendChild(actions);
  panel.appendChild(progressEl);
  modal.appendChild(backdrop);
  modal.appendChild(panel);
  syncMdOnly();
  return modal;
}

function buildTrigger(floating: boolean): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.id = TRIGGER_ID;
  btn.type = "button";
  if (floating) {
    btn.className = "gce-floating";
    btn.textContent = "⬇ Export";
  } else {
    const icon = elc("span", "gce-lead");
    // Gemini enforces a Trusted Types CSP: assigning a string to innerHTML
    // throws a TrustedHTML error even for static, XSS-safe markup like this
    // glyph. Build the SVG via createElementNS instead — do not "simplify"
    // this back to innerHTML.
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", "M12 3v12m0 0l-4-4m4 4l4-4M4 21h16");
    svg.appendChild(path);
    icon.appendChild(svg);
    const label = elc("span");
    label.textContent = "Export";
    btn.appendChild(icon);
    btn.appendChild(label);
  }
  btn.addEventListener("click", openModal);
  return btn;
}

// mountUI can rebuild the modal across reconciliation passes; bind the
// Escape listener at most once so it doesn't accumulate duplicates.
let escBound = false;

function mountUI(): void {
  // The modal lives on <body> once and is toggled open/closed via CSS class.
  if (!document.getElementById(MODAL_ID)) {
    document.body.appendChild(buildModal());
    if (!escBound) {
      escBound = true;
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeModal();
      });
    }
  }
  // Gemini's sidebar is a collapsible drawer: mat-nav-list is only in the DOM
  // while the drawer is open (verified live 2026-07-12). Prepend the native
  // row as the first item so it sits near "새 채팅"; fall back to a floating
  // pill while the drawer is closed.
  const sidebar = document.querySelector(SEL.sidebar);
  const existing = document.getElementById(TRIGGER_ID);
  if (existing) {
    // Keep the native row as-is; only act when a floating fallback (mounted
    // while the drawer was closed) can now be upgraded into the sidebar.
    if (!existing.classList.contains("gce-floating") || !sidebar) return;
    existing.remove();
  }
  if (sidebar) sidebar.prepend(buildTrigger(false));
  else document.body.appendChild(buildTrigger(true));
}

let remountQueued = false;

// UI init is separated from the interceptor (which installs at module load) so
// the script can run at `document-start` — the interceptor must be live before
// Angular boots to learn the list template from the boot batchexecute traffic,
// but the UI cannot mount until <body> exists.
function initUI(): void {
  mountUI();

  // Gemini's Angular sidebar drawer opens/closes and re-renders, tearing down
  // our trigger. Debounced observer + guard so our own insertion doesn't
  // thrash it into a mount loop.
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
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Belt-and-suspenders (chatgpt-exporter pattern): the debounced observer
  // catches most re-renders, but Gemini's Angular sidebar can fully remount in
  // ways it misses. A low-frequency reconciliation loop re-mounts when our
  // trigger or modal is no longer in the document. getElementById only returns
  // connected nodes, so a null result already means "disconnected → re-mount".
  // mountUI is idempotent.
  setInterval(() => {
    if (
      !document.getElementById(TRIGGER_ID) ||
      !document.getElementById(MODAL_ID)
    )
      mountUI();
  }, 1000);
}

// At document-start <body> may not exist yet; defer UI until it does.
if (document.body) initUI();
else
  document.addEventListener("DOMContentLoaded", () => initUI(), { once: true });

// Test seam: exposes internal transport/orchestration for the Node harness.
// Inert in production — under Tampermonkey this is the sandboxed script global,
// invisible to the page (the interceptor and UI are the real entry points).
(globalThis as unknown as { __gceInternals?: unknown }).__gceInternals = {
  bxDecode,
  bxPayload,
  parseContentPayload,
  extractList,
  zipStore,
  fetchConversationContent,
  listAllConversations,
  exportAllConversations,
};
