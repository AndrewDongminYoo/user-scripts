# Gemini Export-All (v1.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]` checkboxes.
> **Design source:** `docs/plans/2026-07-12-gemini-export-all-batchexecute-blueprint.md` (verified reconnaissance). Read it first.

**Goal:** Add "Export all conversations" to `gemini-chat-exporter/` via Gemini's own `batchexecute` API, driven by an observe-replay interceptor (self-healing against build rotation), packed into a store-only ZIP — no navigation, no page reloads.

**Architecture:** A `document-start` XHR interceptor learns the current `list` and `content` batchexecute request templates from Gemini's own traffic. Export-All replays them (list → all conversation ids; per id → content) with the conversation id substituted, parses the `)]}'`-chunked responses, renders via the existing `toMarkdown`/`toJSON`, and packs the results into a dependency-free store-only ZIP.

**Tech Stack:** same as v1 — TypeScript strict, Vite 8, vite-plugin-monkey 8, GM\_\* grants, Node stub harness. Adds `@grant unsafeWindow` (to read `WIZ_global_data` tokens) if the sandbox proxy hides them; verify during Task 1.

## Global Constraints

- import-free `src/main.ts`; NO runtime dependencies. TypeScript strict. pnpm only.
- **Trusted Types**: no `innerHTML` anywhere; scraped/parsed content flows through `textContent`/strings only (already the v1 rule).
- **Observe-replay, never reconstruct**: the interceptor stores the app's REAL request (url params incl. rotating `bl`/`rpcids`, headers, `f.req` body + `at`) and replays it with only the conversation id swapped. Do NOT hardcode `rpcids`/`bl`/payload shapes — a manually reconstructed request returned empty in testing; a faithful replay of a captured request works.
- **Politeness / scope**: exports only the operator's own conversations; one request at a time (or small bounded concurrency); no detection evasion.
- Conventional commits, split by concern. NO Co-Author/Claude-Session trailer. Korean user-facing strings intentional.
- **Live-iteration tasks (1–4) must be validated against real gemini.google.com responses** — a Node stub can't model the `batchexecute` envelope. The controller (browser access) pins the parser and confirms replays; subagents get real captured samples, not guesses.

## Verified facts (from the blueprint — ground truth)

- Endpoint `POST /_/BardChatUi/data/batchexecute?rpcids=<RPCID>&bl=<BUILD>&f.sid=<SID>&...`; body `f.req=[[["<RPCID>","<json-args>",null,"generic"]]]&at=<AT>`; header `x-same-domain: 1`. Same-origin credentialed → 200.
- Tokens: `unsafeWindow.WIZ_global_data.SNlM0e` (at), `.FdrFJe` (f.sid), `.cfb2h` (bl).
- **All batchexecute traffic is XHR** (patch `XMLHttpRequest.prototype.open`/`send`; patch `fetch` defensively).
- **Content rpcid `hNvQHb`**, args `["c_<CONVID>",10,null,1,[1],[4],null,1]` — id is `c_` + the `/app/{id}` id; substitute only that. ~232 KB response for a 4-turn chat; `data[0]` is the per-turn array.
- **List rpcid `VxUbXb`** (empty args seen) and/or a paginated variant `[20,"<cursor>",[0,null,1]]` — confirm which returns `{id,title}` pairs and page through the cursor.
- Response envelope: `)]}'\n` prefix, newline length-prefixed chunks; the data row is `["wrb.fr","<RPCID>",<json-string>,…]` → `JSON.parse(row[2])` is the payload.

---

## Task 1 — batchexecute transport + observe-replay interceptor

Install a `document-start` XHR/fetch interceptor that records every `batchexecute` call (url params, headers, request `f.req`+`at`, and on load the response), and a `batchexecute(templateName, argsOverride)` replay function that fires a stored template and returns the decoded RPC payload.

- [ ] Interceptor stores, per rpcid seen: `{ urlParams, requestHeaders, freqTemplate, responseSample }`. Keep the LATEST successful (200, non-empty) sample per rpcid.
- [ ] Token reader: `unsafeWindow.WIZ_global_data` (fall back to `window.WIZ_global_data`); verify `@grant unsafeWindow` is needed under Tampermonkey sandbox — add it to `vite.config.ts` grants if so.
- [ ] Envelope decoder: strip `)]}'`, walk newline chunks, find `["wrb.fr", rpcid, payloadJson, …]`, return `JSON.parse(payloadJson)`. Handle multi-chunk + the length-prefix lines.
- [ ] `replay(rpcid, transform)`: rebuild the POST from the stored template, apply `transform(freq)` (e.g. swap `c_<id>`), fire same-origin credentialed with the stored headers, decode, return payload.
- [ ] **`_reqid` sequencing + pacing (verified critical):** replays are NON-deterministic with a random `_reqid` — a live test returned the full 253 KB payload once, then empty 138-byte responses on rapid repeats. The real app increments `_reqid` monotonically (base tied to `f.sid`, step ~100000). The interceptor MUST capture the app's `_reqid` and continue the sequence (increment per replay), AND pace calls (one at a time, small delay) to avoid the empty/throttled response. Retry-once on an empty decode.
- [ ] **Live-verify (controller):** replaying a captured `hNvQHb` for a KNOWN conversation returns its real ~253 KB payload — CONFIRMED working (2026-07-12). Node test: envelope decoder against a captured fixture string (chunk-splitting, `wrb.fr` extraction) + empty-response handling.
- [ ] Commit.

## Task 2 — content parser (`hNvQHb` → Conversation)

Parse a real `hNvQHb` payload into the existing `Conversation`/`Turn` shape (reuse `toMarkdown`/`toJSON` unchanged).

- [ ] **Live-pin (controller):** capture a real `hNvQHb` response for a conversation with known text; walk the parsed array to find the exact index path of (a) the user prompt string and (b) the model response text per turn — analyze structure/lengths, do NOT log private content. Record the paths in a comment.
- [ ] Implement `parseContent(payload): Turn[]` defensively: `data[0]` is the turn array; per turn extract prompt + response (Markdown-ish or plain — decide from the real data whether the response arrives as Markdown source or needs light formatting). Skip a turn whose shape doesn't match; count skips.
- [ ] Node test: `parseContent` against a captured fixture payload (sanitized) → asserts turn count + that prompt/response strings are extracted at the pinned paths. Include a malformed-shape fixture → asserts graceful skip, not a throw.
- [ ] Commit.

## Task 3 — conversation list enumeration

- [ ] **Live-confirm (controller):** which rpcid (`VxUbXb` vs paginated) returns `{id,title,updated}` pairs; capture a real list response; find the id/title paths and the pagination cursor.
- [ ] Implement `listAllConversations(): {id,title,updated}[]` — replay the list template, page through the cursor until exhausted (bounded), dedupe by id.
- [ ] Node test against a captured list fixture → asserts id/title extraction + pagination stop.
- [ ] Commit.

## Task 4 — store-only ZIP + Export-All orchestrator + UI

- [ ] Port the store-only ZIP + `uniqueName` verbatim from `claude-chat-exporter/src/main.ts:579-717` (blueprint says reuse; the v1 ZIP was deferred with Export-All).
- [ ] `exportAllConversations(onProgress)`: `listAllConversations()` → for each id, `replay(hNvQHb, swap c_<id>)` → `parseContent` → `renderConversation` (snapshot settings) → ZIP entry (date-prefixed filename); pack + download; return `{exported,failed}`. One request at a time; skip+count failures.
- [ ] Re-add the Export-All button (`__gce_export_all_btn`) to `buildModal` + progress wiring (mirror v1's `runExport`). If a template hasn't been learned yet (interceptor cold), the button prompts: "open any chat once to enable Export-All" (the content template is learned on first conversation open; the list template on sidebar/history load).
- [ ] Node test: orchestrator against stubbed `replay`/`listAllConversations` → asserts a ZIP with N entries (PK signature + local-header count).
- [ ] **Live-verify (controller):** run Export-All on the real account; open the ZIP; confirm one file per conversation, content matches. Verify the "learn template first" prompt path.
- [ ] Commit.

## Task 5 — docs + finalize

- [ ] Update `gemini-chat-exporter/README.md` + `AGENTS.md`: Export-All now shipped; document the observe-replay contract + the "open a chat once to arm" requirement + its fragility (batchexecute is build-coupled; self-healing via observe-replay but the parser paths may need refresh if Gemini restructures the payload).
- [ ] Update root `CLAUDE.md` + `AGENTS.md` gemini design notes.
- [ ] `pnpm typecheck && pnpm -r build && pnpm -r test` green. Commit.

## Self-Review

- Transport/interceptor → Task 1. Content parse → Task 2. Enumeration → Task 3. ZIP+orchestrator+UI → Task 4. Docs → Task 5.
- The four live-iteration points (replay confirm, content paths, list rpcid/cursor, end-to-end ZIP) are explicitly assigned to the controller because a Node stub cannot model the `batchexecute` envelope.
- Fragility is isolated behind the interceptor/replay/parse seam and documented; the observe-replay design means rpcid/`bl` rotation self-heals, only a payload-structure change needs a parser refresh.
