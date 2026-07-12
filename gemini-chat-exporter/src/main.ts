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
    const prompt = (c.querySelector(SEL.queryText)?.textContent ?? "").trim();
    const responseMarkdown = htmlToMarkdown(
      c.querySelector(SEL.responseMarkdown),
    );
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

/** ---------- UI ---------- */
const ONE_ID = "__gce_export_btn";
const ALL_ID = "__gce_export_all_btn";
const ONE_LABEL = "⬇ Export this chat";
const ALL_LABEL = "⬇ Export all";
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
  #${MODAL_ID} .gce-actions { display:flex; gap:8px; margin-top:8px; }
  #${MODAL_ID} .gce-btn { flex:1; padding:10px; border:none; border-radius:8px; cursor:pointer; font-weight:600; font-size:14px; }
  #${MODAL_ID} .gce-btn:disabled { opacity:.6; cursor:default; }
  #${MODAL_ID} .gce-primary { background:#1a73e8; color:#fff; }
  #${MODAL_ID} .gce-secondary { background:#f1f3f4; color:#1f1f1f; }
  #${MODAL_ID} .gce-progress { margin-top:10px; min-height:18px; font-size:13px; color:#5f6368; text-align:center; }
  #${TRIGGER_ID} { display:flex; align-items:center; gap:8px; width:calc(100% - 16px); margin:0 8px; height:40px; padding:0 12px; border:none; background:transparent; cursor:pointer; font:400 14px/1 "Google Sans", system-ui, sans-serif; color:#444746; border-radius:999px; text-align:left; }
  #${TRIGGER_ID}:hover { background:rgba(0,0,0,.06); }
  #${TRIGGER_ID}.gce-floating { position:fixed; bottom:20px; right:20px; z-index:2147483646; width:auto; height:auto; padding:10px 16px; margin:0; background:#1a73e8; color:#fff; font-weight:600; border-radius:999px; box-shadow:0 2px 8px rgba(0,0,0,.25); }
  @media (prefers-color-scheme: dark) {
    #${MODAL_ID} .gce-panel { background:#1e1f20; color:#e3e3e3; border-color:#444746; }
    #${MODAL_ID} .gce-seg { background:#2d2e30; }
    #${MODAL_ID} .gce-seg input:checked + label { background:#131314; color:#e3e3e3; }
    #${MODAL_ID} .gce-secondary { background:#2d2e30; color:#e3e3e3; }
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
  const allBtn = elc("button", "gce-btn gce-secondary");
  allBtn.id = ALL_ID;
  allBtn.type = "button";
  allBtn.textContent = ALL_LABEL;
  // Multi-conversation export lands in Task 6; keep the control present
  // (stable id for the harness) but inert until it's wired up.
  allBtn.disabled = true;
  allBtn.title = "Coming soon";
  progressEl = elc("div", "gce-progress");

  oneBtn.addEventListener("click", () => {
    runExport(oneBtn, ONE_LABEL, async () => {
      await exportCurrentConversation();
      return "Done";
    });
  });
  actions.appendChild(oneBtn);
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

function mountUI(): void {
  // The modal lives on <body> once and is toggled open/closed via CSS class.
  if (!document.getElementById(MODAL_ID)) {
    document.body.appendChild(buildModal());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
    });
  }
  // Minimal floating trigger; a native sidebar entry point lands in Task 7.
  if (!document.getElementById(TRIGGER_ID)) {
    const trigger = elc("button", "gce-floating");
    trigger.id = TRIGGER_ID;
    trigger.type = "button";
    trigger.textContent = "⬇ Export";
    trigger.addEventListener("click", openModal);
    document.body.appendChild(trigger);
  }
}
mountUI();
