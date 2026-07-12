# Gemini Chat Exporter — Design

Date: 2026-07-12
Status: Draft (awaiting review)
Package: `gemini-chat-exporter/` (new)

## Goal

A Tampermonkey userscript that exports gemini.google.com conversations — the current one, or every one — to Markdown/JSON, modeled on the existing `claude-chat-exporter/`.
It reuses that script's proven shape (dependency-free single-file IIFE, GM sandbox, native UI injection, settings panel, store-only ZIP) but replaces the extraction layer, because Gemini exposes no clean API.

## Why DOM scraping, not an API

Investigated live on gemini.google.com (2026-07-12, logged-in session):

- **No REST API.** Conversation data is delivered only through Google's `batchexecute` RPC (`POST /_/BardChatUi/data/batchexecute?rpcids=...`).
  The `rpcids` are per-build obfuscated hashes (observed `MaZiqc`, `qpEbW`, `aPya6c`, `L5adhe`), bound to a rotating build label (`bl=boq_assistant-bard-web-server_20260709.09_p0`), `f.sid`, and an `at` XSRF token in the POST body.
  The response is the nested `)]}'`-prefixed array-of-JSON-strings format.
  This is fragile: any Gemini build can rotate the rpcids and break the script.
- **The rendered DOM is clean and semantic.** Custom Angular elements are stable across builds and map 1:1 to conversation structure:
  - `.conversation-container` — one per turn.
  - `user-query` → `.query-text` (prompt) + `.file-preview-container` (attachment chips).
  - `model-response` → `structured-content-container.model-response-text` → `.markdown` (rendered HTML body).
  - `thinking-overlay` — the model's reasoning, collapsed by default.
  - `infinite-scroller.chat-history` — the scroll container for the turn list.

Decision: **scrape the DOM.** Semantic selectors are the more maintainable target and preserve the "local repair, not rewrite" resilience the Claude exporter was built on.
This mirrors that exporter's philosophy (an isolated extraction seam), only the seam reads the DOM instead of an API.

## Architecture

Inherit the Claude exporter's skeleton verbatim; only the extraction and rendering internals are Gemini-specific.

- **Single file** `src/main.ts`, import-free, IIFE. `vite-plugin-monkey` prepends the metadata header.
- **Toolchain** mirrors `claude-chat-exporter/`: `vite ^8`, `vite-plugin-monkey ^8`, `typescript ~6`, strict mode, `src/env.d.ts` GM bridge.
- **Grants** `@grant GM_addStyle, GM_getValue, GM_setValue`. Gemini also ships a strict CSP; a real `GM_*` grant forces Tampermonkey's sandboxed world (CSP-exempt) so the script runs and can inject styles. Metadata: `@match` `https://gemini.google.com/*`, `run-at` `document-idle`.
- **Persistence** `GM_getValue`/`GM_setValue` under key `gce_settings`.
- **Download** `Blob` + temporary anchor (works in the sandbox). Export-All packs into a dependency-free **store-only ZIP** (ported from the Claude exporter, no zip library).

### Modules (single file, clear seams)

1. **Extraction seam** (Gemini-specific, new):
   - `scrapeCurrentConversation()` → `Conversation` by walking `.conversation-container` nodes in document order.
   - `ensureAllTurnsLoaded(scroller)` — incremental scroll-to-top until the turn set stops growing, accumulating turns into a `Map` keyed by turn identity (see Completeness below). Robust whether or not Gemini virtualizes DOM nodes.
   - `expandCollapsed(container)` — expand `thinking-overlay` (and any "show more") before reading, when the thinking setting is on.
2. **HTML→Markdown converter** (new, dependency-free): walks the `.markdown` subtree and emits Markdown for paragraphs, headings, ordered/unordered lists, `pre`/`code` blocks (with language class when present), tables, links, `strong`/`em`, blockquotes. Unknown nodes fall back to `textContent`. This is the piece the Claude exporter never needed (its API returned structured blocks).
3. **Renderers** (ported pattern): `toMarkdown(conversation, settings)` and `toJSON(conversation, settings)` share predicates so MD and JSON stay coherent (thinking/attachments included per settings).
4. **UI layer** (ported pattern): native trigger injected into Gemini's sidebar + a body-mounted settings modal, styled with Gemini's own CSS variables where available; a floating fallback when the sidebar is absent; a debounced, guarded `MutationObserver` re-mounts the trigger when Angular tears it down.
5. **Export-All orchestrator** (new): enumerate conversation IDs, then serial `navigate → wait → scrape` per conversation with bounded pacing; pack into the store-only ZIP.

## Data model

```ts
interface Turn {
  index: number;
  prompt: string; // user-query .query-text
  attachments: string[]; // file-preview chip names (text only)
  responseMarkdown: string; // converted from model-response .markdown
  thinking?: string; // thinking-overlay text, when enabled
}
interface Conversation {
  id: string; // /app/{id}
  title: string; // document.title minus " - Google Gemini"
  url: string;
  turns: Turn[];
}
```

## Completeness (the load-bearing risk)

Gemini renders chat history inside `<infinite-scroller class="chat-history">`, which lazy-loads older turns on upward scroll.
Whether it _recycles_ (virtualizes) DOM nodes for very long conversations was **not** confirmed live — the operator's own conversations are short (2–4 turns, single-viewport, no recycling observed, first-turn node persisted across scroll).

Mitigation, chosen so the unresolved detail cannot cause data loss:
`ensureAllTurnsLoaded` scrolls the scroller to top in a loop until the accumulated turn count is stable across two passes, accumulating each turn into a `Map` keyed by a stable turn identity (prompt-hash + ordinal), and only then renders.
This is correct whether nodes persist (map fills once) or recycle (map fills incrementally as turns pass through the viewport).

Implementation-time verification: exercise against a genuinely long conversation (create one if needed) and confirm the final turn count equals the true history length.

## Export-All (in scope for v1)

Heavier on Gemini than on Claude: the sidebar is Angular-router-driven with no stable `href`/list endpoint, so there is no clean "list conversations" call.

Mechanism:

1. **Enumerate IDs** from the sidebar: scroll `mat-nav-list` to load all `gem-nav-list-item[data-test-id="conversation"]` entries and harvest each item's target conversation id.
   The exact harvest path (anchor `href` on cold load vs. reading the router target vs. click-and-capture) must be hardened at implementation time — router-driven items do not always expose a stable `href`.
2. **Serial scrape**: for each id, `navigate(/app/{id})` → `ensureAllTurnsLoaded` → `scrapeCurrentConversation`, with bounded pacing (one at a time, polite) since each conversation is a full route load.
3. **Pack** every conversation into the store-only ZIP, filename-sanitized, plus an index.

Known risk: enumeration reliability. If cold-load harvesting proves unstable, fall back to "export the conversations currently loaded in the sidebar" and surface the count to the user rather than silently truncating.

## Settings (`gce_settings`)

Mirror the Claude exporter's shape, minus options that don't apply:

```ts
interface Settings {
  format: "md" | "json";
  frontmatter: boolean; // YAML frontmatter in MD
  includeThinking: boolean; // capture thinking-overlay
  includeAttachments: boolean; // list attachment names
}
```

(No `messageTimestamps`/`includeToolCalls`: Gemini's DOM does not surface per-message timestamps or Claude-style tool blocks. Add later only if a DOM source is found.)

## Deliberately out of scope (v1)

- **Deep Research immersive reports.** The full report opens in a separate canvas/immersive panel, not inline in `model-response`; capturing it is a distinct effort. v1 exports the inline conversation only; note this limitation in the README.
- **Uploaded image bytes / generated images.** Only attachment _names_ are recorded (parity with the Claude exporter, which skips image `files[]`).
- **Citations / grounding source chips** beyond what appears as links in the response body.

## Pipeline wiring (easy-to-forget steps)

1. Scaffold `gemini-chat-exporter/` mirroring `claude-chat-exporter/` (package.json, tsconfig.json, vite.config.ts, src/env.d.ts, test/run.mjs).
2. Add `gemini-chat-exporter` to `pnpm-workspace.yaml` `packages`.
3. Add `gemini-chat-exporter` to the `matrix.package` list in `.github/workflows/release.yml`.
4. Add a Node test harness (`test/run.mjs`) driving the built dist against a stubbed DOM/GM sandbox, so `pnpm -r test` covers it. Use fixture DOM snapshots of `.conversation-container` for the extraction + HTML→MD converter.

## Testing

- **Unit-ish (Node harness)**: feed fixture HTML of `user-query`/`model-response`/`thinking-overlay` through the extractor + HTML→Markdown converter + renderers; assert MD/JSON output. This is the layer that most needs regression coverage (the converter has the most edge cases).
- **Live (manual)**: current-conversation export in light/dark; a long conversation for completeness; Export-All on a small account; trigger re-mount after SPA navigation. The harness cannot cover live DOM/UI, same as the Claude exporter.

## Open risks carried into implementation

1. Virtualization behavior on long conversations — mitigated by design, verify live.
2. Export-All ID enumeration reliability — primary strategy defined, needs live hardening + a safe fallback.
3. HTML→Markdown fidelity on Gemini-specific structures (nested lists, code blocks, tables) — cover with fixtures.
4. `thinking-overlay` expansion timing (must expand before read) — verify.
