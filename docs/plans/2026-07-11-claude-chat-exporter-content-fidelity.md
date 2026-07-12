# claude-chat-exporter Content Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture extended thinking, tool calls/results, and attachment text in both Markdown and JSON export instead of dropping everything but `content[].text`.

**Architecture:** Replace the single "join text blocks" step with two shared per-message helpers — `renderBlocks` (Markdown, document-order `<details>` blocks) and `collectStructured` (JSON, typed arrays). Both take a `BlockOpts` derived from three new settings toggles. Attachments render at the top of a message body; tool_use/tool_result pair by document order (no id map). Markdown truncates long blocks; JSON keeps them whole.

**Tech Stack:** TypeScript, `vite-plugin-monkey` (v7 toolchain), Tampermonkey GM APIs, Node test harness (`test/run.mjs`), pnpm.

## Global Constraints

- `src/main.ts` stays **import-free** — one self-contained bundle (Tampermonkey provides GM globals).
- **No new dependencies**; no new `@grant` (reuse `GM_addStyle` / `GM_getValue` / `GM_setValue`).
- Never edit `dist/*.user.js` by hand — `vite-plugin-monkey` generates the header.
- Build on the **v7 toolchain on `main`**; do not fold in `chore/deps-bump-vpm8`.
- Settings persist under the single existing key `cce_settings`.
- `MD_BLOCK_CAP = 2000` — Markdown-only per-block char cap; JSON is never truncated.
- Verify each task with: `pnpm --filter claude-chat-exporter build && pnpm --filter claude-chat-exporter test`.
- Comments/strings that already exist stay as-is; match surrounding style.

---

### Task 1: Types, settings, and shared block walkers (thinking first)

Introduces the two shared helpers wired into `toMarkdown`/`toJSON`, handling `text` (unchanged behavior) + `thinking`. Tools and attachments are added in Tasks 2–3.

**Files:**

- Modify: `claude-chat-exporter/src/main.ts`
- Test: `claude-chat-exporter/test/run.mjs`

**Interfaces:**

- Consumes: existing `ChatMessage`, `Conversation`, `Settings`, `toMarkdown`, `toJSON`, `renderConversation`.
- Produces:
  - `interface BlockOpts { includeThinking: boolean; includeToolCalls: boolean; includeAttachments: boolean }`
  - `truncate(s: string, cap: number): string`
  - `isRenderableThinking(block: ContentBlock): boolean`
  - `renderBlocks(msg: ChatMessage, opts: BlockOpts): string`
  - `collectStructured(msg: ChatMessage, opts: BlockOpts): StructuredMessage`
  - `StructuredMessage`, `ToolRecord`, `JsonAttachment` (defined here; `tools`/`attachments` populated in later tasks)

- [ ] **Step 1: Write the failing tests**

Append to `claude-chat-exporter/test/run.mjs` (before the final `if (failures)` block):

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter claude-chat-exporter build && pnpm --filter claude-chat-exporter test`
Expected: FAIL — thinking `<details>` not present; `obj.messages[0].thinking` undefined.

- [ ] **Step 3: Extend types and settings**

In `src/main.ts`, replace the `ContentBlock` interface (lines 18–21):

```typescript
interface ContentBlock {
  type?: string;
  text?: string;
  // thinking blocks
  thinking?: string;
  hidden?: boolean;
  thinking_hidden?: boolean;
  // tool_use blocks
  name?: string;
  input?: unknown;
  // tool_result blocks (content is an array of sub-blocks, or a string)
  content?: ContentBlock[] | string;
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
```

Add `attachments` to `ChatMessage` (currently lines 23–29) so it reads:

```typescript
interface ChatMessage {
  uuid?: string;
  sender?: string;
  text?: string;
  content?: ContentBlock[];
  attachments?: Attachment[];
  created_at?: string;
}
```

Replace the `Settings` interface and `DEFAULT_SETTINGS` (lines 58–69) with:

```typescript
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
```

- [ ] **Step 4: Add shared helpers and rewire the renderers**

In `src/main.ts`, replace `extractText` (lines 141–151) with the helpers below. Keep `roleLabel` and everything after it:

```typescript
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

// Markdown body for one message: attachments first, then blocks in document order.
function renderBlocks(msg: ChatMessage, opts: BlockOpts): string {
  const out: string[] = [];
  for (const block of msg.content ?? []) {
    if (block.type === "text") {
      if (typeof block.text === "string" && block.text.trim())
        out.push(block.text.trim());
    } else if (block.type === "thinking") {
      if (opts.includeThinking && isRenderableThinking(block)) {
        const body = truncate((block.thinking as string).trim(), MD_BLOCK_CAP);
        out.push(
          `<details><summary>🧠 Extended thinking</summary>\n\n${body}\n\n</details>`,
        );
      }
    }
  }
  let joined = out.join("\n\n").trim();
  if (!joined && typeof msg.text === "string") joined = msg.text.trim();
  return joined;
}

interface ToolRecord {
  name: string;
  input: unknown;
  result: string;
  is_error: boolean;
}

interface JsonAttachment {
  file_name?: string;
  file_size?: number;
  file_type?: string;
  extracted_content?: string;
}

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
  for (const block of msg.content ?? []) {
    if (block.type === "text") {
      if (typeof block.text === "string" && block.text.trim())
        textParts.push(block.text.trim());
    } else if (block.type === "thinking") {
      if (opts.includeThinking && isRenderableThinking(block))
        thinking.push((block.thinking as string).trim());
    }
  }
  let text = textParts.join("\n\n").trim();
  if (!text && typeof msg.text === "string") text = msg.text.trim();
  return { text, thinking, tools, attachments: [] };
}
```

Rewrite the message loop in `toMarkdown` (currently lines 233–243) to use `renderBlocks`:

```typescript
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
```

Extend `toMarkdown`'s `opts` type (line 225) to carry the block toggles:

```typescript
  opts: {
    frontmatter: boolean;
    messageTimestamps: boolean;
    meta: ConvMeta;
    includeThinking: boolean;
    includeToolCalls: boolean;
    includeAttachments: boolean;
  },
```

Replace `JsonMessage` and `toJSON` (lines 260–287) with:

```typescript
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
```

Update `renderConversation` (lines 289–311) to build `BlockOpts` and pass it to both renderers:

```typescript
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter claude-chat-exporter build && pnpm --filter claude-chat-exporter test`
Expected: PASS — all new thinking checks plus every pre-existing check (`all checks passed`).

- [ ] **Step 6: Commit**

```bash
git add claude-chat-exporter/src/main.ts claude-chat-exporter/test/run.mjs
git commit -m "feat(claude-chat-exporter): capture extended thinking in md and json export"
```

---

### Task 2: Tool calls / results (compact, document-order)

**Files:**

- Modify: `claude-chat-exporter/src/main.ts`
- Test: `claude-chat-exporter/test/run.mjs`

**Interfaces:**

- Consumes: `renderBlocks`, `collectStructured`, `truncate`, `extractToolResultText`, `ToolRecord`, `MD_BLOCK_CAP` from Task 1.
- Produces: `tool_use` / `tool_result` handling inside both walkers (no new exported symbols).

- [ ] **Step 1: Write the failing tests**

Append to `claude-chat-exporter/test/run.mjs` (before `if (failures)`):

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter claude-chat-exporter build && pnpm --filter claude-chat-exporter test`
Expected: FAIL — no `🔧` summary; `obj.messages[0].tools` undefined.

- [ ] **Step 3: Add tool branches to `renderBlocks`**

In `renderBlocks`, extend the `for` loop so it also handles tool blocks (add these `else if` branches after the `thinking` branch, before the loop closes):

```typescript
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
        const body = truncate(extractToolResultText(block.content), MD_BLOCK_CAP);
        if (body) {
          const err = block.is_error ? " · error" : "";
          out.push(`<details><summary>↳ Result${err}</summary>\n\n${body}\n\n</details>`);
        }
      }
    }
```

- [ ] **Step 4: Add tool pairing to `collectStructured`**

In `collectStructured`, add a `pending` cursor and tool branches. Replace the `for` loop with:

```typescript
let pending = -1; // index of the last tool_use awaiting its result
for (const block of msg.content ?? []) {
  if (block.type === "text") {
    if (typeof block.text === "string" && block.text.trim())
      textParts.push(block.text.trim());
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
      pending = tools.length - 1;
    }
  } else if (block.type === "tool_result") {
    if (opts.includeToolCalls) {
      const result = extractToolResultText(block.content);
      if (pending >= 0) {
        const rec = tools[pending] as ToolRecord;
        rec.result = result;
        rec.is_error = block.is_error === true;
        pending = -1;
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter claude-chat-exporter build && pnpm --filter claude-chat-exporter test`
Expected: PASS — all tool checks plus every prior check.

- [ ] **Step 6: Commit**

```bash
git add claude-chat-exporter/src/main.ts claude-chat-exporter/test/run.mjs
git commit -m "feat(claude-chat-exporter): render tool calls and results (compact, document order)"
```

---

### Task 3: Attachments (extracted text)

**Files:**

- Modify: `claude-chat-exporter/src/main.ts`
- Test: `claude-chat-exporter/test/run.mjs`

**Interfaces:**

- Consumes: `renderBlocks`, `collectStructured`, `truncate`, `JsonAttachment`, `MD_BLOCK_CAP`.
- Produces: attachment handling inside both walkers (no new exported symbols).

- [ ] **Step 1: Write the failing tests**

Append to `claude-chat-exporter/test/run.mjs` (before `if (failures)`):

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter claude-chat-exporter build && pnpm --filter claude-chat-exporter test`
Expected: FAIL — no `📎` summary; `obj.messages[0].attachments` undefined.

- [ ] **Step 3: Render attachments at the top of the message body**

In `renderBlocks`, insert this block **before** the `for (const block of msg.content ?? [])` loop:

```typescript
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
```

- [ ] **Step 4: Collect attachments in `collectStructured`**

In `collectStructured`, replace `return { text, thinking, tools, attachments: [] };` with:

```typescript
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter claude-chat-exporter build && pnpm --filter claude-chat-exporter test`
Expected: PASS — all attachment checks plus every prior check.

- [ ] **Step 6: Commit**

```bash
git add claude-chat-exporter/src/main.ts claude-chat-exporter/test/run.mjs
git commit -m "feat(claude-chat-exporter): export attachment extracted text (md and json)"
```

---

### Task 4: Settings panel checkboxes

**Files:**

- Modify: `claude-chat-exporter/src/main.ts` (`buildPanel`, lines 620–677)
- Test: `claude-chat-exporter/test/run.mjs`

**Interfaces:**

- Consumes: `settings`, `saveSettings`, the `row` helper inside `buildPanel`.
- Produces: three checkboxes with ids `__cce_thinking`, `__cce_tools`, `__cce_attachments`.

- [ ] **Step 1: Write the failing test**

Append to `claude-chat-exporter/test/run.mjs` (before `if (failures)`):

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter claude-chat-exporter build && pnpm --filter claude-chat-exporter test`
Expected: FAIL — `__cce_thinking` element not found.

- [ ] **Step 3: Add the three checkboxes**

In `buildPanel`, after the `ts` (timestamps) checkbox wiring (after line 663, before the `row` helper), add:

```typescript
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
```

Then, after the existing `panel.appendChild(row(ts, "Message timestamps (md)"));` (line 675), add:

```typescript
panel.appendChild(row(think, "Extended thinking"));
panel.appendChild(row(tools, "Tool calls"));
panel.appendChild(row(attach, "Attachments"));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter claude-chat-exporter build && pnpm --filter claude-chat-exporter test`
Expected: PASS — all toggle checks plus every prior check (`all checks passed`).

- [ ] **Step 5: Commit**

```bash
git add claude-chat-exporter/src/main.ts claude-chat-exporter/test/run.mjs
git commit -m "feat(claude-chat-exporter): add content-fidelity toggles to settings panel"
```

---

### Task 5: Docs and live verification

**Files:**

- Modify: `claude-chat-exporter/README.md`
- Modify: `claude-chat-exporter/AGENTS.md`

**Interfaces:**

- Consumes: the shipped behavior from Tasks 1–4.
- Produces: user + agent documentation. No code.

- [ ] **Step 1: Document the feature in `README.md`**

Add a bullet to the features list describing rich-content capture, and a settings-panel row listing the three new toggles. Example additions (adapt wording to the file's existing voice):

```markdown
- Captures **extended thinking**, **tool calls/results** (compact, collapsible),
  and **attachment text** — in both Markdown and JSON.
- Settings panel toggles: Extended thinking, Tool calls, Attachments (default on).
  Markdown wraps rich content in `<details>` and caps each block at ~2000 chars;
  JSON keeps the full content.
```

- [ ] **Step 2: Note the design seam in `AGENTS.md`**

Add a short note: rich content is split into `renderBlocks` (Markdown, document-order `<details>`, truncated at `MD_BLOCK_CAP`) and `collectStructured` (JSON typed arrays, untruncated); `tool_use`/`tool_result` pair by document order (verified 1:1, no id map); uploaded image `files[]` and text-block `citations` are intentionally not exported.

- [ ] **Step 3: Rebuild, run the full test suite, and lint**

Run:

```bash
rm -rf claude-chat-exporter/node_modules/.vite
pnpm --filter claude-chat-exporter build
pnpm --filter claude-chat-exporter test
pnpm typecheck
```

Expected: `all checks passed`; typecheck clean. Confirm the new code shipped:

```bash
grep -c "Extended thinking" claude-chat-exporter/dist/claude-chat-exporter.user.js
```

Expected: `1` or more.

- [ ] **Step 4: Live verification via the same-origin API**

On claude.ai (logged in), export a real conversation that contains thinking and tool blocks (single **⬇ Export MD**, then flip to JSON). Confirm: the Markdown has collapsible 🧠/🔧/↳ Result sections in document order and any 📎 attachment; the JSON carries `thinking` / `tools` / `attachments` arrays with full (untruncated) content. This exercises real API shapes the Node harness stubs.

- [ ] **Step 5: Commit**

```bash
git add claude-chat-exporter/README.md claude-chat-exporter/AGENTS.md
git commit -m "docs(claude-chat-exporter): document content-fidelity export options"
```

---

## Self-Review notes

- **Spec coverage:** thinking (Task 1), tools compact + document-order + truncation (Task 2), attachments (Task 3), three toggles (Tasks 1 settings + 4 panel), MD-truncate/JSON-full (Tasks 1–3 helpers/tests), backward-compatible JSON omitting empty arrays (Task 1 `toJSON`), docs (Task 5), live verification (Task 5). Out-of-scope items (files, citations, display_content, branch) are not implemented by design.
- **Type consistency:** `BlockOpts`, `StructuredMessage`, `ToolRecord`, `JsonAttachment` defined in Task 1 and reused verbatim in Tasks 2–4. `renderBlocks`/`collectStructured`/`truncate`/`extractToolResultText`/`isRenderableThinking` names are stable across tasks.
- **Order:** thinking → tools → attachments matches simplest → hardest; each task keeps the suite green.
