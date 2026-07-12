# claude-chat-exporter Content Fidelity Design

**Date**: 2026-07-11
**Status**: Completed

## Goal

Stop dropping content when exporting a Claude conversation.
Today the renderer keeps only `content[].text`, silently discarding extended
thinking, tool calls / results, and uploaded-document text.
This phase captures those in both Markdown and JSON export, for single-conversation
and Export All flows, with per-category toggles.

## Scope

In scope (verified present in live data — 50-60 conversations scanned 2026-07-11):

- **Extended thinking** — `thinking` content blocks (text in `block.thinking`).
- **Tool calls / results** — `tool_use` + `tool_result` content blocks, rendered
  in one generic compact format (no per-tool special-casing).
- **Attachments** — message-level `attachments[]` (pasted / uploaded documents),
  rendered from their `extracted_content` text.
- Three settings toggles (default on), persisted with the existing `cce_settings`.

Out of scope (conscious drops, not oversights):

- **Uploaded image files** (`message.files[]`) — binary, referenced by short-lived
  signed asset URLs (`thumbnail_url` / `preview_url` / `document_asset`).
  Downloading them is heavy and the URLs expire; same lens that excluded PNG
  screenshots. Not rendered.
- **`text` block `citations`** — present on text blocks; not rendered.
- **`tool_use.display_content`** — present but polymorphic (varies across
  `code` / `table` / `json_block` / `text` shapes). We render from `input`
  (always present) instead of building a shape-specific branch.
- **Branch / tree export** — we continue to export the active leaf path only
  (`rendering_mode=messages`). Full branch export is a separate future phase.
- HTML output, PDF, `{model_name}` — unchanged from the prior phase's decisions.

## Data facts (verified live 2026-07-11, structure only — no values extracted)

- Content block types and counts (50 convs): `text` 526, `tool_use` 255,
  `tool_result` 255, `thinking` 42.
- **`tool_use` and its `tool_result` always co-locate in the same message's
  `content[]`** (85 messages had both; 0 split across messages). → Render blocks
  in document order; **no `tool_use_id` pairing map is needed.**
- **Senders are exactly `human` and `assistant`.** The existing binary role label
  is correct; no system / tool sender to mislabel.
- `thinking` block keys: `thinking`, `summaries`, `cut_off`, `truncated`,
  `hidden`, `thinking_hidden`. In scanned data all four flags were `false`.
  Skip predicate (defensive): skip a thinking block when `hidden === true` or
  `thinking_hidden === true` or `thinking` is empty/whitespace.
- `tool_use` keys include `name`, `input` (always), `display_content` (166/292,
  polymorphic — dropped). Render `name` + `input`.
- **`tool_result.content` is always an array.** Element shapes observed:
  `{type:'text', text, uuid}` (most common), `{type, title, url, metadata,
is_missing}` (search/fetch), and file references (`file_path` / `name` /
  `file_uuid`). Extraction: join `text` from `type:'text'` elements; for a
  non-text element emit a one-line descriptor (`title (url)` or file name).
- Attachment keys: `file_name`, `file_size`, `file_type`, `extracted_content`,
  `created_at`. `extracted_content` is text — no download needed.

## Settings model

Extend `cce_settings` with three booleans (defaults on). Read at startup with
defaults; each toggle writes immediately (same pattern as the existing panel).

| Key                  | Type      | Default | Meaning                                |
| -------------------- | --------- | ------- | -------------------------------------- |
| `includeThinking`    | `boolean` | `true`  | Emit extended-thinking blocks          |
| `includeToolCalls`   | `boolean` | `true`  | Emit tool_use / tool_result blocks     |
| `includeAttachments` | `boolean` | `true`  | Emit message attachment extracted text |

The settings panel gains three checkboxes below the existing controls (format,
frontmatter, messageTimestamps). No new grants.

## Markdown rendering

Replace the single "join `content[].text`" step with a per-message block walk
that emits blocks **in document order**. Message-level attachments (user uploads)
render at the top of the message body, before the block walk.

Per block:

- `text` → the trimmed text (unchanged behavior).
- `thinking` (when `includeThinking`, not hidden, non-empty):

  ```markdown
  <details><summary>🧠 Extended thinking</summary>

  {thinking text}

  </details>
  ```

- `tool_use` (when `includeToolCalls`):

  ````markdown
  <details><summary>🔧 {name}</summary>

  ```json
  {JSON.stringify(input, null, 2), truncated}
  ```

  </details>
  ````

- `tool_result` (when `includeToolCalls`):

  ```markdown
  <details><summary>↳ Result{ · error when is_error}</summary>

  {extracted text, truncated}

  </details>
  ```

- attachment (when `includeAttachments`), at top of message body:

  ```markdown
  <details><summary>📎 {file_name} ({file_size} bytes)</summary>

  {extracted_content, truncated}

  </details>
  ```

`<details>` collapses in GitHub / Obsidian and degrades to visible, readable text
in plain renderers. A blank line after `<summary>` lets the inner Markdown render.

**Truncation (Markdown only).** A single cap `MD_BLOCK_CAP = 2000` characters
applies to each tool `input`, each tool `result`, and each attachment
`extracted_content`. Truncated text ends with `\n… (truncated)`. Unbounded
sources (`bash_tool`, `web_fetch`) are the reason this cap exists.

Empty blocks (e.g. an empty tool result) are skipped so no empty `<details>` is
emitted.

## JSON rendering (normalized schema, backward compatible)

Keep the existing per-message `{ role, text, created_at }`; add optional arrays
that are **omitted when empty** (small conversations serialize unchanged):

```json
{
  "role": "assistant",
  "text": "...",
  "thinking": ["..."],
  "tools": [
    { "name": "bash_tool", "input": {}, "result": "...", "is_error": false }
  ],
  "created_at": "..."
}
```

Message-level (typically the human turn):

```json
{
  "role": "user",
  "text": "...",
  "attachments": [
    {
      "file_name": "spec.pdf",
      "file_size": 12345,
      "file_type": "application/pdf",
      "extracted_content": "..."
    }
  ],
  "created_at": "..."
}
```

- `thinking`: array of block texts (skips hidden / empty).
- `tools[].input`: the raw input object (not stringified).
- `tools[].result`: extracted text, **full — no truncation** (JSON is the
  complete archive; Markdown is the readable view).
- `attachments[].extracted_content`: **full — no truncation.**
- Each array is emitted only when the corresponding toggle is on and it is
  non-empty.
- **Cross-type ordering is not preserved in JSON** (thinking / tools / text live
  in separate arrays); Markdown preserves document order. Conscious tradeoff to
  keep the normalized schema stable and backward compatible.

## Code structure (`src/main.ts`, import-free, currently 727 lines)

- Extend `Settings` + `loadSettings()` defaults with the three booleans.
- Add `renderBlocks(msg, opts)` → Markdown string for one message body (attachments
  first, then the document-order block walk). `toMarkdown` calls it per message.
- Add `collectStructured(msg, opts)` → `{ text, thinking[], tools[], attachments[] }`
  for JSON. `toJSON` uses it and omits empty arrays.
- Shared helpers: `extractToolResultText(content)`, `truncate(s, cap)`,
  `isRenderableThinking(block)`. Keep everything import-free in the single bundle.
- Add three checkboxes to the settings-panel mount.

## Testing (Node harness `test/run.mjs`, drives the built userscript)

Add a fixture conversation containing, in one assistant message, `thinking` +
`tool_use` + `tool_result` + `text` blocks (in that document order), plus a human
message with an `attachments[]` entry. Assert:

- **Markdown**: contains `🧠 Extended thinking`, `🔧 {name}`, `↳ Result`,
  `📎 {file_name}`; `tool_use` renders before its `tool_result` (document order);
  a >2000-char result is capped and ends with `… (truncated)`.
- **Toggles**: `includeThinking:false` omits the thinking `<details>`; likewise
  for tools and attachments.
- **JSON**: `thinking` / `tools` / `attachments` arrays present with the right
  shape; `tools[0].result` is the **full** (untruncated) text; empty arrays are
  omitted when a message has no such blocks.
- **Skip predicates**: a `hidden:true` or empty `thinking` block produces no
  output in either format; an empty tool result yields no `<details>`.
- Existing tests (frontmatter, timestamps, Export All zip via `ditto`) stay green.

## Verification

- `pnpm --filter claude-chat-exporter build` then `pnpm --filter
claude-chat-exporter test` (clear `node_modules/.vite` first if verifying the
  bundle, then `grep` `dist` to confirm the new code shipped).
- `pnpm typecheck` + `trunk check` clean.
- Live re-run via the same-origin API on a real conversation that has thinking +
  tool blocks; eyeball the Markdown collapsibles and the JSON arrays.

## Notes

- Build on the working v7 toolchain on `main`; independent of the deferred
  `vite-plugin-monkey` 8 bump (`chore/deps-bump-vpm8`). Do not fold it in.
- Export All snapshots settings before fan-out (existing behavior) — the new
  toggles are part of that snapshot, no extra work.
