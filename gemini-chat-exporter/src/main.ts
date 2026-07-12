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
