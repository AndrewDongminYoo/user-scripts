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

/** Quotes a YAML scalar, escaping backslashes before quotes (order matters). */
function yamlStr(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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

function scrapeCurrentConversation(): Conversation {
  const id = getConversationId() ?? "";
  const turns: Turn[] = [];
  const containers = document.querySelectorAll(SEL.turn);
  containers.forEach((c, i) => {
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
    const turn: Turn = { index: i, prompt, attachments, responseMarkdown };
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
