"use strict";

/**
 * Claude Chat Exporter
 *
 * Adds floating buttons on claude.ai to export the current conversation — or
 * every conversation — to Markdown, read through Claude's own web API
 * (same-origin, cookie-authenticated).
 *
 * API shape (verified live against claude.ai):
 *   GET /api/organizations                              -> [{ uuid }]
 *   GET /api/organizations/{org}/chat_conversations     -> [{ uuid, name, updated_at, is_starred }]
 *   GET /api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=messages&render_all_tools=true
 *       -> { name, chat_messages: [{ sender, text, content: [{ text }] }] }
 */

/** ---------- Types ---------- */
interface ContentBlock {
  type?: string;
  text?: string;
  // thinking blocks
  thinking?: string;
  hidden?: boolean;
  thinking_hidden?: boolean;
  // tool_use blocks
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result blocks (content is an array of sub-blocks, or a string)
  content?: ContentBlock[] | string;
  tool_use_id?: string;
  is_error?: boolean;
  // tool_result sub-block descriptors
  title?: string;
  url?: string;
  file_path?: string;
}

interface Attachment {
  file_name?: string;
  file_size?: number;
  file_type?: string;
  extracted_content?: string;
}

interface ChatMessage {
  uuid?: string;
  sender?: string;
  text?: string;
  content?: ContentBlock[];
  attachments?: Attachment[];
  created_at?: string;
}

interface Conversation {
  uuid?: string;
  name?: string;
  model?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ChatMessage[];
  messages?: ChatMessage[];
}

interface ConversationSummary {
  uuid: string;
  name?: string;
  model?: string;
  created_at?: string;
  updated_at?: string;
  is_starred?: boolean;
}

interface Organization {
  uuid?: string;
}

const CONCURRENCY = 4;

/** ---------- Settings ---------- */
type Format = "md" | "json";
interface Settings {
  format: Format;
  frontmatter: boolean;
  messageTimestamps: boolean;
  includeThinking: boolean;
  includeToolCalls: boolean;
  includeAttachments: boolean;
}

const SETTINGS_KEY = "cce_settings";
const DEFAULT_SETTINGS: Settings = {
  format: "md",
  frontmatter: true,
  messageTimestamps: false,
  includeThinking: true,
  includeToolCalls: true,
  includeAttachments: true,
};

const MD_BLOCK_CAP = 2000;

interface BlockOpts {
  includeThinking: boolean;
  includeToolCalls: boolean;
  includeAttachments: boolean;
}

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

/** ---------- Conversation id from URL ---------- */
function getConversationId(): string | null {
  const m = window.location.pathname.match(/\/chat\/([^/?#]+)/);
  return m ? m[1] : null;
}

/** ---------- Organization id ---------- */
function getOrgFromCookie(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/);
  if (!m) return null;
  const val = decodeURIComponent(m[1]);
  // Only trust a UUID-shaped value; otherwise fall back to /api/organizations.
  return /^[0-9a-f-]{36}$/i.test(val) ? val : null;
}

async function getOrgId(): Promise<string> {
  const cookieOrg = getOrgFromCookie();
  if (cookieOrg) return cookieOrg;

  const res = await fetch("/api/organizations", { credentials: "include" });
  if (!res.ok) throw new Error(`organizations ${res.status}`);
  const data: unknown = await res.json();
  const list: Organization[] = Array.isArray(data)
    ? (data as Organization[])
    : ((data as { organizations?: Organization[] }).organizations ?? []);
  const uuid = list[0]?.uuid;
  if (!uuid) throw new Error("no organization found");
  return uuid;
}

/** ---------- Fetch conversation(s) ---------- */
async function fetchConversation(
  orgId: string,
  chatId: string,
): Promise<Conversation> {
  const url =
    `/api/organizations/${orgId}/chat_conversations/${chatId}` +
    `?tree=True&rendering_mode=messages&render_all_tools=true`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`conversation ${res.status}`);
  return res.json() as Promise<Conversation>;
}

async function fetchConversationList(
  orgId: string,
): Promise<ConversationSummary[]> {
  const res = await fetch(`/api/organizations/${orgId}/chat_conversations`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`conversation list ${res.status}`);
  const data: unknown = await res.json();
  return Array.isArray(data) ? (data as ConversationSummary[]) : [];
}

/** ---------- Markdown rendering ---------- */
function truncate(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}\n… (truncated)` : s;
}

function isRenderableThinking(block: ContentBlock): boolean {
  if (block.hidden === true || block.thinking_hidden === true) return false;
  return typeof block.thinking === "string" && block.thinking.trim().length > 0;
}

// Extract readable text from a tool_result's `content` (array of sub-blocks or a string).
function extractToolResultText(
  content: ContentBlock[] | string | undefined,
): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const el of content) {
    if (typeof el.text === "string" && el.text.trim())
      parts.push(el.text.trim());
    else if (el.url) parts.push(el.title ? `${el.title} (${el.url})` : el.url);
    else if (el.file_path ?? el.name)
      parts.push((el.file_path ?? el.name) as string);
  }
  return parts.join("\n\n").trim();
}

// Treat a block as message text when it is a `text` block — or, per the legacy
// documented shape `content: [{ text }]`, an untyped block carrying a string.
// Both walkers share this predicate so Markdown and JSON never disagree.
function textBlockContent(block: ContentBlock): string | null {
  if (block.type != null && block.type !== "text") return null;
  return typeof block.text === "string" && block.text.trim()
    ? block.text.trim()
    : null;
}

// Markdown body for one message: attachments first, then blocks in document order.
function renderBlocks(msg: ChatMessage, opts: BlockOpts): string {
  const out: string[] = [];
  if (opts.includeAttachments) {
    for (const a of msg.attachments ?? []) {
      const body = (a.extracted_content ?? "").trim();
      if (!body) continue;
      const size =
        typeof a.file_size === "number" ? ` (${a.file_size} bytes)` : "";
      out.push(
        `<details><summary>📎 ${a.file_name ?? "attachment"}${size}</summary>\n\n${truncate(body, MD_BLOCK_CAP)}\n\n</details>`,
      );
    }
  }
  let emittedText = false;
  for (const block of msg.content ?? []) {
    const textContent = textBlockContent(block);
    if (textContent !== null) {
      out.push(textContent);
      emittedText = true;
    } else if (block.type === "thinking") {
      if (opts.includeThinking && isRenderableThinking(block)) {
        const body = truncate((block.thinking as string).trim(), MD_BLOCK_CAP);
        out.push(
          `<details><summary>🧠 Extended thinking</summary>\n\n${body}\n\n</details>`,
        );
      }
    } else if (block.type === "tool_use") {
      if (opts.includeToolCalls) {
        const input =
          block.input === undefined ? "" : JSON.stringify(block.input, null, 2);
        const body = truncate(input, MD_BLOCK_CAP);
        out.push(
          `<details><summary>🔧 ${block.name ?? "tool"}</summary>\n\n\`\`\`json\n${body}\n\`\`\`\n\n</details>`,
        );
      }
    } else if (block.type === "tool_result") {
      if (opts.includeToolCalls) {
        const body = truncate(
          extractToolResultText(block.content),
          MD_BLOCK_CAP,
        );
        if (body) {
          const err = block.is_error ? " · error" : "";
          out.push(
            `<details><summary>↳ Result${err}</summary>\n\n${body}\n\n</details>`,
          );
        }
      }
    }
  }
  if (!emittedText && typeof msg.text === "string" && msg.text.trim())
    out.push(msg.text.trim());
  return out.join("\n\n").trim();
}

interface ToolRecord {
  name: string;
  input: unknown;
  result: string;
  is_error: boolean;
}

type JsonAttachment = Attachment;

interface StructuredMessage {
  text: string;
  thinking: string[];
  tools: ToolRecord[];
  attachments: JsonAttachment[];
}

// Structured collection for JSON: typed arrays, document-order tool pairing.
function collectStructured(
  msg: ChatMessage,
  opts: BlockOpts,
): StructuredMessage {
  const textParts: string[] = [];
  const thinking: string[] = [];
  const tools: ToolRecord[] = [];
  const byId = new Map<string, number>(); // tool_use.id -> index in tools
  const pendingQueue: number[] = []; // FIFO of unmatched tool_use indices (id-less fallback)
  for (const block of msg.content ?? []) {
    const textContent = textBlockContent(block);
    if (textContent !== null) {
      textParts.push(textContent);
    } else if (block.type === "thinking") {
      if (opts.includeThinking && isRenderableThinking(block))
        thinking.push((block.thinking as string).trim());
    } else if (block.type === "tool_use") {
      if (opts.includeToolCalls) {
        tools.push({
          name: block.name ?? "tool",
          input: block.input ?? null,
          result: "",
          is_error: false,
        });
        const idx = tools.length - 1;
        if (typeof block.id === "string" && block.id) byId.set(block.id, idx);
        pendingQueue.push(idx);
      }
    } else if (block.type === "tool_result") {
      if (opts.includeToolCalls) {
        const result = extractToolResultText(block.content);
        let matchedIdx: number | undefined;
        if (typeof block.tool_use_id === "string" && block.tool_use_id) {
          matchedIdx = byId.get(block.tool_use_id);
        }
        if (matchedIdx !== undefined) {
          // id match: consume it from both the id map and the FIFO queue
          byId.delete(block.tool_use_id as string);
          const qi = pendingQueue.indexOf(matchedIdx);
          if (qi !== -1) pendingQueue.splice(qi, 1);
        } else {
          // id-less (or unknown id): pair with the oldest unmatched tool_use
          matchedIdx = pendingQueue.shift();
        }
        if (matchedIdx !== undefined) {
          const rec = tools[matchedIdx] as ToolRecord;
          rec.result = result;
          rec.is_error = block.is_error === true;
        } else {
          tools.push({
            name: block.name ?? "tool",
            input: null,
            result,
            is_error: block.is_error === true,
          });
        }
      }
    }
  }
  let text = textParts.join("\n\n").trim();
  if (!text && typeof msg.text === "string") text = msg.text.trim();
  const attachments: JsonAttachment[] = [];
  if (opts.includeAttachments) {
    for (const a of msg.attachments ?? []) {
      if ((a.extracted_content ?? "").trim()) {
        attachments.push({
          file_name: a.file_name,
          file_size: a.file_size,
          file_type: a.file_type,
          extracted_content: a.extracted_content,
        });
      }
    }
  }
  return { text, thinking, tools, attachments };
}

function roleLabel(sender: string | undefined): string {
  return sender === "human" ? "## 👤 User" : "## 🤖 Claude";
}

interface ConvMeta {
  model?: string;
  createdAt?: string;
  updatedAt?: string;
}

function resolveMeta(
  conv: Conversation,
  summary?: ConversationSummary,
): ConvMeta {
  return {
    model: conv.model ?? summary?.model,
    createdAt: conv.created_at ?? summary?.created_at,
    updatedAt: conv.updated_at ?? summary?.updated_at,
  };
}

// Always double-quote — valid YAML for any string (URLs, colons, unicode).
function yamlStr(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// "2026-07-11T08:40:00Z" -> "2026-07-11 08:40"
function fmtTime(iso: string | undefined): string | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : null;
}

function frontmatterBlock(
  title: string,
  chatId: string,
  meta: ConvMeta,
): string {
  const now = new Date();
  const lines = [
    "---",
    `title: ${yamlStr(title)}`,
    `source: ${yamlStr(`https://claude.ai/chat/${chatId}`)}`,
  ];
  if (meta.model) lines.push(`model: ${yamlStr(meta.model)}`);
  if (meta.createdAt) lines.push(`create_time: ${yamlStr(meta.createdAt)}`);
  if (meta.updatedAt) lines.push(`update_time: ${yamlStr(meta.updatedAt)}`);
  lines.push(
    `date: ${now.toISOString().slice(0, 10)}`,
    `timestamp: ${yamlStr(now.toISOString())}`,
    "---",
    "",
  );
  return lines.join("\n");
}

function roleHeader(
  sender: string | undefined,
  createdAt: string | undefined,
  withTime: boolean,
): string {
  const base = roleLabel(sender);
  if (withTime) {
    const t = fmtTime(createdAt);
    if (t) return `${base} · ${t}`;
  }
  return base;
}

function toMarkdown(
  conv: Conversation,
  chatId: string,
  opts: {
    frontmatter: boolean;
    messageTimestamps: boolean;
    meta: ConvMeta;
    includeThinking: boolean;
    includeToolCalls: boolean;
    includeAttachments: boolean;
  },
): string {
  const messages = conv.chat_messages ?? conv.messages ?? [];
  const title = (conv.name ?? "").trim() || "Claude conversation";
  const convUrl = `https://claude.ai/chat/${chatId}`;

  const turns: string[] = [];
  let rendered = 0;
  for (const msg of messages) {
    const body = renderBlocks(msg, {
      includeThinking: opts.includeThinking,
      includeToolCalls: opts.includeToolCalls,
      includeAttachments: opts.includeAttachments,
    });
    if (!body) continue;
    rendered++;
    turns.push(
      roleHeader(msg.sender, msg.created_at, opts.messageTimestamps),
      "",
      body,
      "",
    );
  }

  const header: string[] = opts.frontmatter
    ? [frontmatterBlock(title, chatId, opts.meta), `# ${title}`, ""]
    : [
        `# ${title}`,
        "",
        `> Exported from [Claude.ai](${convUrl})`,
        `> ${rendered} messages · ${new Date().toISOString()}`,
        "",
        "---",
        "",
      ];

  return header.concat(turns).join("\n");
}

interface JsonMessage {
  role: "user" | "assistant";
  text: string;
  created_at: string | null;
  thinking?: string[];
  tools?: ToolRecord[];
  attachments?: JsonAttachment[];
}

function toJSON(
  conv: Conversation,
  chatId: string,
  meta: ConvMeta,
  opts: BlockOpts,
): string {
  const messages = conv.chat_messages ?? conv.messages ?? [];
  const out = {
    title: (conv.name ?? "").trim() || "Claude conversation",
    source: `https://claude.ai/chat/${chatId}`,
    model: meta.model ?? null,
    create_time: meta.createdAt ?? null,
    update_time: meta.updatedAt ?? null,
    exported_at: new Date().toISOString(),
    messages: [] as JsonMessage[],
  };
  for (const msg of messages) {
    const st = collectStructured(msg, opts);
    if (
      !st.text &&
      !st.thinking.length &&
      !st.tools.length &&
      !st.attachments.length
    )
      continue;
    const m: JsonMessage = {
      role: msg.sender === "human" ? "user" : "assistant",
      text: st.text,
      created_at: msg.created_at ?? null,
    };
    if (st.thinking.length) m.thinking = st.thinking;
    if (st.tools.length) m.tools = st.tools;
    if (st.attachments.length) m.attachments = st.attachments;
    out.messages.push(m);
  }
  return JSON.stringify(out, null, 2);
}

function renderConversation(
  conv: Conversation,
  chatId: string,
  meta: ConvMeta,
  s: Settings,
): { text: string; extension: string; mime: string } {
  const blockOpts: BlockOpts = {
    includeThinking: s.includeThinking,
    includeToolCalls: s.includeToolCalls,
    includeAttachments: s.includeAttachments,
  };
  if (s.format === "json") {
    return {
      text: toJSON(conv, chatId, meta, blockOpts),
      extension: "json",
      mime: "application/json;charset=utf-8",
    };
  }
  return {
    text: toMarkdown(conv, chatId, {
      frontmatter: s.frontmatter,
      messageTimestamps: s.messageTimestamps,
      meta,
      ...blockOpts,
    }),
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
      .slice(0, 120) || "claude-conversation"
  );
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

/** ---------- Store-only ZIP (no dependency) ---------- */
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
  // DOS date 1980-01-01, time 00:00 (avoids "invalid date" warnings).
  const dosDate = 0x0021;
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

/** ---------- Concurrency ---------- */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress: (done: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx] as T, idx);
      done++;
      onProgress(done, items.length);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/** ---------- Export flows ---------- */
async function exportCurrentConversation(): Promise<void> {
  const chatId = getConversationId();
  if (!chatId) {
    throw new Error("Open a conversation first (no /chat/<id> in URL).");
  }
  const orgId = await getOrgId();
  const conv = await fetchConversation(orgId, chatId);
  const title = (conv.name ?? "").trim() || "Claude conversation";
  const meta = resolveMeta(conv);
  const { text, extension, mime } = renderConversation(
    conv,
    chatId,
    meta,
    settings,
  );
  downloadBlob(
    `${sanitizeFilename(title)}.${extension}`,
    new Blob([text], { type: mime }),
  );
}

async function exportAllConversations(
  onProgress: (done: number, total: number) => void,
): Promise<{ exported: number; failed: number }> {
  const orgId = await getOrgId();
  const list = await fetchConversationList(orgId);
  const enc = new TextEncoder();
  // Snapshot settings: the panel stays interactive during a long run, so a
  // mid-export toggle must not mix formats/options within one ZIP.
  const snapshot = settings;

  const results = await mapPool(
    list,
    CONCURRENCY,
    async (c) => {
      try {
        const conv = await fetchConversation(orgId, c.uuid);
        const meta = resolveMeta(conv, c);
        const rendered = renderConversation(conv, c.uuid, meta, snapshot);
        return { summary: c, rendered, ok: true };
      } catch (err) {
        console.error("[claude-chat-exporter] skip", c.uuid, err);
        return { summary: c, rendered: null, ok: false };
      }
    },
    onProgress,
  );

  const used = new Set<string>();
  const files: ZipEntry[] = [];
  let failed = 0;
  for (const r of results) {
    if (!r.ok || !r.rendered) {
      failed++;
      continue;
    }
    const datePrefix = (r.summary.updated_at ?? "").slice(0, 10);
    const title = sanitizeFilename(
      (r.summary.name ?? "").trim() || "conversation",
    );
    const base =
      (datePrefix ? `${datePrefix} ` : "") + title + "." + r.rendered.extension;
    files.push({
      name: uniqueName(base, used),
      data: enc.encode(r.rendered.text),
    });
  }
  if (failed > 0) {
    files.push({
      name: "_errors.txt",
      data: enc.encode(`${failed} conversation(s) failed to export.\n`),
    });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(`claude-conversations-${stamp}.zip`, zipStore(files));
  return { exported: files.length - (failed > 0 ? 1 : 0), failed };
}

/** ---------- UI ---------- */
const UI_ID = "__claude_export_ui";
const ONE_ID = "__claude_export_btn";
const ALL_ID = "__claude_export_all_btn";
const ONE_LABEL = "⬇ Export MD";
const ALL_LABEL = "⬇ Export All";

// GM_addStyle both styles the UI and, as a real @grant, forces Tampermonkey into
// its sandboxed world so the script is exempt from claude.ai's CSP.
GM_addStyle(`
  #${UI_ID} {
    position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
    display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
  }
  #${UI_ID} button {
    padding: 8px 14px; border-radius: 999px; border: none;
    background: #d97757; color: #fff; font-size: 13px; font-weight: 600;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); cursor: pointer;
  }
  #${UI_ID} button:disabled { opacity: 0.6; cursor: default; }
  #${UI_ID} #__claude_export_panel {
    display: none; flex-direction: column; gap: 6px;
    background: #2b2b2b; color: #fff; padding: 10px 12px; border-radius: 10px;
    font-size: 12px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  #${UI_ID} #__claude_export_panel.open { display: flex; }
  #${UI_ID} #__claude_export_panel label {
    display: flex; gap: 6px; align-items: center; cursor: pointer;
  }
`);

function makeButton(id: string, label: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.id = id;
  btn.type = "button";
  btn.textContent = label;
  return btn;
}

function runExport(
  btn: HTMLButtonElement,
  defaultLabel: string,
  task: () => Promise<string>,
): void {
  btn.disabled = true;
  void (async (): Promise<void> => {
    try {
      const doneLabel = await task();
      btn.textContent = doneLabel;
    } catch (err) {
      console.error("[claude-chat-exporter]", err);
      btn.textContent = "Failed";
    } finally {
      setTimeout(() => {
        btn.textContent = defaultLabel;
        btn.disabled = false;
      }, 2000);
    }
  })();
}

function buildPanel(): HTMLDivElement {
  const panel = document.createElement("div");
  panel.id = "__claude_export_panel";

  const fmtMd = document.createElement("input");
  fmtMd.type = "radio";
  fmtMd.name = "cce_fmt";
  fmtMd.id = "__cce_fmt_md";
  fmtMd.checked = settings.format === "md";
  const fmtJson = document.createElement("input");
  fmtJson.type = "radio";
  fmtJson.name = "cce_fmt";
  fmtJson.id = "__cce_fmt_json";
  fmtJson.checked = settings.format === "json";
  fmtMd.addEventListener("change", () => {
    if (fmtMd.checked) {
      settings = { ...settings, format: "md" };
      saveSettings(settings);
    }
  });
  fmtJson.addEventListener("change", () => {
    if (fmtJson.checked) {
      settings = { ...settings, format: "json" };
      saveSettings(settings);
    }
  });

  const fm = document.createElement("input");
  fm.type = "checkbox";
  fm.id = "__cce_frontmatter";
  fm.checked = settings.frontmatter;
  fm.addEventListener("change", () => {
    settings = { ...settings, frontmatter: fm.checked };
    saveSettings(settings);
  });

  const ts = document.createElement("input");
  ts.type = "checkbox";
  ts.id = "__cce_timestamps";
  ts.checked = settings.messageTimestamps;
  ts.addEventListener("change", () => {
    settings = { ...settings, messageTimestamps: ts.checked };
    saveSettings(settings);
  });

  const mkCheck = (
    id: string,
    checked: boolean,
    apply: (v: boolean) => Settings,
  ): HTMLInputElement => {
    const c = document.createElement("input");
    c.type = "checkbox";
    c.id = id;
    c.checked = checked;
    c.addEventListener("change", () => {
      settings = apply(c.checked);
      saveSettings(settings);
    });
    return c;
  };

  const think = mkCheck("__cce_thinking", settings.includeThinking, (v) => ({
    ...settings,
    includeThinking: v,
  }));
  const tools = mkCheck("__cce_tools", settings.includeToolCalls, (v) => ({
    ...settings,
    includeToolCalls: v,
  }));
  const attach = mkCheck(
    "__cce_attachments",
    settings.includeAttachments,
    (v) => ({
      ...settings,
      includeAttachments: v,
    }),
  );

  const row = (ctrl: HTMLElement, text: string): HTMLLabelElement => {
    const l = document.createElement("label");
    l.appendChild(ctrl);
    l.appendChild(document.createTextNode(text));
    return l;
  };

  panel.appendChild(row(fmtMd, "Markdown"));
  panel.appendChild(row(fmtJson, "JSON"));
  panel.appendChild(row(fm, "Frontmatter (md)"));
  panel.appendChild(row(ts, "Message timestamps (md)"));
  panel.appendChild(row(think, "Extended thinking"));
  panel.appendChild(row(tools, "Tool calls"));
  panel.appendChild(row(attach, "Attachments"));
  return panel;
}

function mountUI(): void {
  if (document.getElementById(UI_ID)) return;

  const container = document.createElement("div");
  container.id = UI_ID;

  const panel = buildPanel();
  const cfgBtn = makeButton("__claude_export_cfg_btn", "⚙️");
  cfgBtn.addEventListener("click", () => {
    panel.classList.toggle("open");
  });

  const allBtn = makeButton(ALL_ID, ALL_LABEL);
  allBtn.addEventListener("click", () => {
    runExport(allBtn, ALL_LABEL, async () => {
      const { exported, failed } = await exportAllConversations(
        (done, total) => {
          allBtn.textContent = `Exporting ${done}/${total}…`;
        },
      );
      return failed > 0
        ? `Done (${exported}, ${failed} failed)`
        : `Done (${exported})`;
    });
  });

  const oneBtn = makeButton(ONE_ID, ONE_LABEL);
  oneBtn.addEventListener("click", () => {
    runExport(oneBtn, ONE_LABEL, async () => {
      await exportCurrentConversation();
      return "Done";
    });
  });

  container.appendChild(panel);
  container.appendChild(cfgBtn);
  container.appendChild(allBtn);
  container.appendChild(oneBtn);
  document.body.appendChild(container);
}

mountUI();

// Claude is a client-side SPA; re-mount the UI after navigations that may
// replace large parts of the DOM.
const observer = new MutationObserver(() => {
  if (!document.getElementById(UI_ID)) mountUI();
});
observer.observe(document.documentElement, { childList: true, subtree: true });
