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
}

interface ChatMessage {
  uuid?: string;
  sender?: string;
  text?: string;
  content?: ContentBlock[];
  created_at?: string;
}

interface Conversation {
  uuid?: string;
  name?: string;
  chat_messages?: ChatMessage[];
  messages?: ChatMessage[];
}

interface ConversationSummary {
  uuid: string;
  name?: string;
  updated_at?: string;
  is_starred?: boolean;
}

interface Organization {
  uuid?: string;
}

const CONCURRENCY = 4;

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
function extractText(msg: ChatMessage): string {
  const parts: string[] = [];
  for (const block of msg.content ?? []) {
    if (typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text);
    }
  }
  let out = parts.join("\n\n").trim();
  if (!out && typeof msg.text === "string") out = msg.text.trim();
  return out;
}

function roleLabel(sender: string | undefined): string {
  return sender === "human" ? "## 👤 User" : "## 🤖 Claude";
}

function toMarkdown(conv: Conversation, chatId: string): string {
  const messages = conv.chat_messages ?? conv.messages ?? [];
  const title = (conv.name ?? "").trim() || "Claude conversation";
  const convUrl = `https://claude.ai/chat/${chatId}`;
  const exportedAt = new Date().toISOString();

  const turns: string[] = [];
  let rendered = 0;
  for (const msg of messages) {
    const body = extractText(msg);
    if (!body) continue;
    rendered++;
    turns.push(roleLabel(msg.sender), "", body, "");
  }

  const header: string[] = [
    `# ${title}`,
    "",
    `> Exported from [Claude.ai](${convUrl})`,
    `> ${rendered} messages · ${exportedAt}`,
    "",
    "---",
    "",
  ];

  return header.concat(turns).join("\n");
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
  let name = base;
  let i = 1;
  while (used.has(name.toLowerCase())) {
    name = base.replace(/\.md$/, "") + ` (${i++}).md`;
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
  const markdown = toMarkdown(conv, chatId);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  downloadBlob(`${sanitizeFilename(title)}.md`, blob);
}

async function exportAllConversations(
  onProgress: (done: number, total: number) => void,
): Promise<{ exported: number; failed: number }> {
  const orgId = await getOrgId();
  const list = await fetchConversationList(orgId);
  const enc = new TextEncoder();

  const results = await mapPool(
    list,
    CONCURRENCY,
    async (c) => {
      try {
        const conv = await fetchConversation(orgId, c.uuid);
        return { summary: c, markdown: toMarkdown(conv, c.uuid), ok: true };
      } catch (err) {
        console.error("[claude-chat-exporter] skip", c.uuid, err);
        return { summary: c, markdown: "", ok: false };
      }
    },
    onProgress,
  );

  const used = new Set<string>();
  const files: ZipEntry[] = [];
  let failed = 0;
  for (const r of results) {
    if (!r.ok) {
      failed++;
      continue;
    }
    const datePrefix = (r.summary.updated_at ?? "").slice(0, 10);
    const title = sanitizeFilename(
      (r.summary.name ?? "").trim() || "conversation",
    );
    const base = (datePrefix ? `${datePrefix} ` : "") + title + ".md";
    files.push({ name: uniqueName(base, used), data: enc.encode(r.markdown) });
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

function mountUI(): void {
  if (document.getElementById(UI_ID)) return;

  const container = document.createElement("div");
  container.id = UI_ID;

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
