# Gemini Export-All via batchexecute (observe-replay) — Reconnaissance Blueprint

Date: 2026-07-12
Status: Verified reconnaissance (not yet implemented). Feeds the v1.1 Export-All build.
Context: Export-All was descoped from v1 because DOM navigation is infeasible from a userscript; this blueprint is the alternative that IS feasible.

## Why this exists

Every DOM-navigation path for iterating conversations was live-verified as blocked (2026-07-12):

- Hard nav (`location.href`/`location.assign`) loads the conversation but triggers a full page reload → destroys the userscript's execution context → any serial loop dies.
- `history.pushState` + synthetic `popstate` preserves context but Angular's router does NOT load the conversation (0 turns render).
- A **trusted** click on a sidebar `gem-nav-list-item` DOES do a client-side navigation that preserves context and renders the conversation — but a userscript cannot synthesize a trusted event; synthetic `dispatchEvent(MouseEvent('click'))` on the item does not trigger Angular's router.
- Same-origin `<iframe>` to `/app/{id}` is blocked (`contentDocument` null — X-Frame-Options/frame-ancestors).

So the only programmatic path is Gemini's own data API (`batchexecute`), the same one its frontend uses. This is the ChatGPT-exporter equivalent (it reads ChatGPT's backend API); Gemini's backend is `batchexecute`.

## Verified transport facts

- Endpoint: `POST https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=<RPCID>&source-path=/app&bl=<BUILD>&f.sid=<SID>&_reqid=<n>&rt=c`
- A same-origin **credentialed** request returns **200** (auth rides the page's cookies). A sandboxed userscript can do this and can read the required tokens via `unsafeWindow`.
- **All batchexecute calls go over XHR**, not `fetch`. An observe-replay interceptor MUST patch `XMLHttpRequest.prototype.open`/`send` (patch `fetch` too, defensively).
- Required page tokens (from `unsafeWindow.WIZ_global_data`):
  - `at` (XSRF) = `WIZ_global_data.SNlM0e`
  - `f.sid` = `WIZ_global_data.FdrFJe`
  - `bl` (build label) = `WIZ_global_data.cfb2h` (e.g. `boq_assistant-bard-web-server_20260709.09_p0`)
- Request body: `f.req=[[["<RPCID>","<json-string-of-args>",null,"generic"]]]&at=<AT>`, header `x-same-domain: 1`, content-type `application/x-www-form-urlencoded;charset=UTF-8`.
- Response: `)]}'\n` prefix, then newline-delimited length-prefixed chunks; each data chunk is a JSON array of rows; the row of interest is `["wrb.fr","<RPCID>",<json-string-payload>,...]` — `JSON.parse(row[2])` gives the RPC's data.

## The two RPCs (verified by intercepting the app's own XHR)

### Conversation content — `hNvQHb`

- Request args (captured, id redacted): `["c_<CONVID>",10,null,1,[1],[4],null,1]`
  - **The conversation id is prefixed with `c_`**: for `/app/ba0a7c235d0b68ec` the arg is `"c_ba0a7c235d0b68ec"`. Substitute only this; keep the rest of the args as captured.
- Response size: ~232 KB for a 4-turn conversation (this is the real message payload).
- Response shape (`JSON.parse(row[2])`, top-level lengths; leaves elided): `data[0]` is the turn array — one entry per turn (`[2:[turn],[turn]]` for a 2-turn chat). Each turn is roughly `[ [ids], object, [content…], [big-render-tree…], [numbers] ]`. The prompt text and the model response text live inside these per-turn subtrees; the exact leaf indices must be pinned by inspecting a real response during implementation (do NOT hardcode from guesses — capture and walk).

### Conversation list — `VxUbXb` (candidate) / paginated variant

- `VxUbXb` was observed with empty args `[]` (small responses). A paginated history call was also seen with args shaped like `[20,"<cursor>",[0,null,1]]` (page size 20 + opaque cursor). Confirm which returns the id+title list, and page through the cursor to enumerate ALL conversations. Capture this the same observe-replay way before implementing.

## Observe-replay design (self-healing against build rotation)

The rpcids and `bl` build label rotate when Google redeploys (~weekly). Do NOT hardcode them. Instead:

1. At `document-start`, install an XHR interceptor that records, for every `batchexecute` call: the full URL (rpcids, bl, sid), request headers, request body (the `f.req` template + `at`), and — on load — the response text.
2. Learn templates from the app's OWN traffic:
   - **content template** = the call whose `f.req` args contain the current conversation id (the `c_<id>`) and whose response is large. Store its URL params + headers + body template, marking where `c_<id>` sits.
   - **list template** = the call whose response decodes to many `{id,title}` pairs. Store it + its pagination cursor position.
   - Learning requires the app to have made each call once. The content template is learned automatically the first time the user opens any conversation after the script loads; the list template on sidebar load. If a template is missing when Export-All starts, prompt the user to open any chat once (or open the sidebar) to "arm" it.
3. Export-All replays the learned templates: page the list template to collect all ids; for each id, replay the content template with `c_<id>` substituted; parse each response; render via the existing `toMarkdown`/`toJSON`; pack into the existing store-only ZIP.
4. Because it replays the app's real, current request (rpcid/bl/headers included), it survives build rotation without code changes.

## Parser

Write a small, defensive walker over `JSON.parse(row[2])` for `hNvQHb` that extracts, per turn, the user prompt text and the model response text (and, if cleanly reachable, thinking). Pin the leaf paths against a REAL captured response during implementation (privacy: analyze structure/lengths, do not log conversation content). Fall back gracefully (skip a turn) if the shape doesn't match, and surface a count of skipped turns rather than silently dropping.

## Implementation notes

- Reuse the existing `renderConversation`/`toMarkdown`/`toJSON`, `sanitizeFilename`, `downloadBlob`, and the store-only ZIP (the ZIP was deferred with Export-All; bring it back for this).
- Progress UI + snapshot settings mirror the Claude exporter's Export-All.
- Politeness: bounded concurrency / paced requests (single-request-at-a-time is fine and safest).
- This is the ONE fragile part of the script; keep it isolated behind a clear seam and document the observe-replay contract in AGENTS.md.
