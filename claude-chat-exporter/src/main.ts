"use strict";

/**
 * Claude Chat Exporter
 *
 * Injects a floating "Export MD" button on claude.ai conversation pages.
 * On click it reads the current conversation through Claude's own web API
 * (same-origin, cookie-authenticated) and downloads it as a Markdown file.
 *
 * API shape (based on open-source Claude exporters; pending live verification):
 *   GET /api/organizations                              -> [{ uuid }]
 *   GET /api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=messages&render_all_tools=true
 *       -> { name, chat_messages: [{ sender, text, content: [{ text }], created_at }] }
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

interface Organization {
  uuid?: string;
}

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

/** ---------- Fetch conversation ---------- */
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

/** ---------- Download ---------- */
function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[/\\?%*:|"<>]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "claude-conversation"
  );
}

function downloadMarkdown(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
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
  const chatId = getConversationId();
  if (!chatId) {
    throw new Error("Open a conversation first (no /chat/<id> in URL).");
  }
  const orgId = await getOrgId();
  const conv = await fetchConversation(orgId, chatId);
  const title = (conv.name ?? "").trim() || "Claude conversation";
  const markdown = toMarkdown(conv, chatId);
  downloadMarkdown(`${sanitizeFilename(title)}.md`, markdown);
}

/** ---------- UI ---------- */
const BTN_ID = "__claude_export_btn";
const DEFAULT_LABEL = "⬇ Export MD";

function setButtonState(
  btn: HTMLButtonElement,
  label: string,
  disabled: boolean,
): void {
  btn.textContent = label;
  btn.disabled = disabled;
  btn.style.opacity = disabled ? "0.6" : "1";
  btn.style.cursor = disabled ? "default" : "pointer";
}

function mountButton(): void {
  if (document.getElementById(BTN_ID)) return;

  const btn = document.createElement("button");
  btn.id = BTN_ID;
  btn.type = "button";
  btn.textContent = DEFAULT_LABEL;
  Object.assign(btn.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    zIndex: "2147483647",
    padding: "8px 14px",
    borderRadius: "999px",
    border: "none",
    background: "#d97757",
    color: "#fff",
    fontSize: "13px",
    fontWeight: "600",
    boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
    cursor: "pointer",
  } as Partial<CSSStyleDeclaration>);

  btn.addEventListener("click", () => {
    void (async (): Promise<void> => {
      setButtonState(btn, "Exporting...", true);
      try {
        await exportCurrentConversation();
        setButtonState(btn, "Done", true);
      } catch (err) {
        console.error("[claude-chat-exporter]", err);
        setButtonState(btn, "Failed", true);
      } finally {
        setTimeout(() => setButtonState(btn, DEFAULT_LABEL, false), 1500);
      }
    })();
  });

  document.body.appendChild(btn);
}

mountButton();

// Claude is a client-side SPA; re-mount the button after navigations that
// may replace large parts of the DOM.
const observer = new MutationObserver(() => {
  if (!document.getElementById(BTN_ID)) mountButton();
});
observer.observe(document.documentElement, { childList: true, subtree: true });
