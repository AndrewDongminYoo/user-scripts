# AGENTS.md (gemini-chat-exporter)

Subdirectory guide for `gemini-chat-exporter/`.

## Purpose

- TypeScript + Vite userscript that exports gemini.google.com conversations to Markdown/JSON: the currently open one (by scraping the rendered DOM) and **all** of them (Export-All, via the site's own `batchexecute` API using an observe-replay interceptor).
- Builds `dist/gemini-chat-exporter.user.js` via `vite-plugin-monkey`.

## Current Layout

```text
gemini-chat-exporter/
├── package.json
├── tsconfig.json
├── vite.config.ts   # monkey plugin: metadata header, match, run-at, grants
├── README.md
├── AGENTS.md
├── dist/            # build output (gitignored)
├── test/
│   └── run.mjs      # Node vm-sandbox harness against the built dist bundle
└── src/
    ├── main.ts      # DOM scrape + HTML->Markdown + batchexecute observe-replay (Export-All) + UI + download
    └── env.d.ts      # GM_* + unsafeWindow globals (see Grants note below)
```

## What To Change Here

- Extraction / conversion / export behavior: edit `src/main.ts`.
- Metadata (match globs, run-at, name, version fallback, grants): edit `vite.config.ts`.
- Regression coverage: extend `test/run.mjs` (it runs the **built** `dist` bundle in a Node `vm` sandbox with a stubbed DOM/GM surface — `pnpm build` must precede `pnpm test`).

## Commands

Run inside this directory:

```bash
pnpm install
pnpm dev
pnpm build
pnpm preview
pnpm test
```

## Design Notes

- **DOM-scraping rationale (single-conversation export):** Gemini exposes no
  clean, stable API for reading a conversation, so the **currently open**
  conversation is exported by scraping the rendered DOM's semantic Angular
  custom elements (`user-query`, `model-response`, `conversation-container`,
  …) — the stable extraction seam. Export-All cannot use the DOM (it would
  need to _enumerate_ and _open_ every conversation, and every DOM-navigation
  path was live-verified as blocked), so it uses the `batchexecute` API
  instead — see the next note and the blueprint at
  `../docs/plans/2026-07-12-gemini-export-all-batchexecute-blueprint.md`.
- **Export-All via `batchexecute` observe-replay (the fragile seam):**
  Gemini's data API is `batchexecute` over XHR; its `bl` build label rotates
  per deploy (and `rpcids` can rotate too), so we never reconstruct a request.
  A `document-start`
  interceptor (`bxInstallInterceptor`) patches **`unsafeWindow`'s**
  XMLHttpRequest/fetch — the page (main) world where Angular's XHR and the
  auth cookies live; a sandbox-only patch misses that traffic — and records
  the app's own batchexecute calls (`bxTemplates`, keyed by rpcid). Export-All
  **replays** a learned template with only the conversation id and `_reqid`
  changed (`bxReplay`): `_reqid` is a global monotonic counter continued at
  the observed `+100000` step, and the captured `at` XSRF token is reused
  verbatim (no `WIZ_global_data` reading needed). Responses use the
  `)]}'`-prefixed, newline-length-prefixed envelope; `bxDecode` splits on
  newlines and `JSON.parse`s each `[`-line (the byte-length prefix is unsafe
  to slice against a UTF-16 string with multibyte content). Two RPCs, both
  live-verified 2026-07-12:
  - **List = `MaZiqc`** (`listAllConversations`): `payload[2]` = conversation
    entries, entry`[0]` = `"c_<id>"`, entry`[1]` = title; `payload[1]` = the
    next-page cursor (empty/absent → last page), passed back as `args[1]` (a
    null cursor starts at page 1). Paged from the start, deduped by id.
  - **Content = `hNvQHb`** (`fetchConversationContent` /
    `parseContentPayload`): `payload[0]` = per-turn array; per turn, prompt =
    `turn[2][0][0]`, response Markdown source = `turn[3][0][0][1][0]`.
    `args[1]` is a turn page-size cap (we request a large size); `payload[1]`
    non-null means the conversation had **more** turns than fetched, surfaced
    as a per-conversation truncation flag rather than silently dropped. Turns
    whose shape matches neither prompt nor response are skipped and counted;
    image-generation turns keep the prompt with a placeholder response.
  - Replays are non-deterministic under bursts (empty/partial responses), so
    both list paging and the export orchestrator fetch **one at a time with a
    small delay**, retrying once on an empty decode. Results are packed into
    the dependency-free store-only ZIP (ported verbatim from
    `claude-chat-exporter`). This whole seam is the one build-coupled part.
    What self-heals: `bl` and the per-session tokens (`at`, `f.sid`, `_reqid`),
    because the whole template is re-learned from live traffic each session.
    What does **not**: the two rpcid literals (`MaZiqc`/`hNvQHb`, named
    constants `LIST_RPCID`/`CONTENT_RPCID`) and the payload paths are **pinned,
    not learned** — if Google rotates an rpcid or changes the response
    structure, Export-All fails ("not armed" for content) and needs a one-line
    manual refresh. The arming path logs the currently-learned rpcids to the
    console so the new literal is discoverable, not a dead-end.
- **The `SEL` seam:** every selector Gemini's DOM depends on is centralized in
  the `SEL` object at the top of `src/main.ts` (`turn`, `userQuery`,
  `queryText`, `attachmentChip`, `modelResponse`, `responseMarkdown`,
  `thinking`, `scroller`, `sidebar`). When Google changes markup/class names,
  fixing extraction should mean editing `SEL`, not hunting through the file.
- **HTML→Markdown converter:** dependency-free, in `src/main.ts`
  (`htmlToMarkdown` / `blockMd` / `inlineMd` / `listMd` / `tableMd`). Supports
  headings, paragraphs, ordered/unordered (including nested) lists, tables,
  fenced code blocks with a `language-*` class, links, bold/italic, and
  blockquotes. Both the Markdown and JSON renderers (`toMarkdown` / `toJSON`)
  consume the same `Conversation`/`Turn` shape produced by
  `scrapeCurrentConversation`, so the two formats stay coherent.
- **Completeness (`ensureAllTurnsLoaded`):** Gemini's `<infinite-scroller>`
  lazy-loads older turns on upward scroll but does **not** evict already-
  rendered nodes (live-verified 2026-07-12: a 4-turn chat overflowing its
  viewport 91x kept all nodes across scroll). So repeatedly scrolling the
  scroller to `scrollTop = 0` until the rendered turn count stabilizes, then
  doing a single document-order `querySelectorAll(SEL.turn)` collect,
  captures every turn without needing a Map/id-based accumulator. This
  assumes no DOM eviction — if Gemini ever starts evicting off-screen turns,
  this loop needs to become an accumulate-by-identity pass instead.
- **Trusted Types → `createElementNS`:** Gemini enforces a Trusted Types CSP
  (live-verified 2026-07-12). Assigning a string to `element.innerHTML`
  throws a `TrustedHTML` error even for static, XSS-safe markup. The sidebar
  trigger's download-arrow icon is therefore built with
  `document.createElementNS("http://www.w3.org/2000/svg", …)` +
  `setAttribute`, never `innerHTML`. Any future scraped or generated content
  going into the DOM must follow the same rule — `textContent` or
  `createElement`/`createElementNS`, never `innerHTML`, on this site.
- **CSP / grants:** `@grant GM_addStyle, GM_getValue, GM_setValue,
unsafeWindow`; `@run-at document-start`. `GM_addStyle` doubles as the
  button/modal CSS injector and, as a real `GM_*` grant, forces Tampermonkey
  into its sandboxed world — which is exempt from Gemini's page CSP (a
  `@grant none` script runs in the page's main world and would be blocked).
  `unsafeWindow` lets the interceptor patch the **page world's** XHR/fetch (see
  the Export-All note). `document-start` is required so the interceptor is live
  before Angular boots and fires the list `batchexecute` call; the UI mount is
  deferred to `<body>` readiness (`initUI`). The file download uses a `Blob` +
  temporary anchor, which works in the sandbox.
- **"Open a chat once to arm":** Export-All replays templates learned from the
  app's own traffic. The list template is learned at boot; the content
  (`hNvQHb`) template is learned the first time any conversation is opened. If
  the content template is not yet learned, the Export-All button prompts the
  user to open any chat once. (Dev tip: `pnpm dev`'s HMR loader is blocked by
  Gemini's CSP — to test a build in Tampermonkey, install the self-contained
  `dist/gemini-chat-exporter.user.js` instead of the dev loader.)
- **Settings (`gce_settings`):** the ⚙️ modal persists
  `{ format, frontmatter, includeThinking, includeAttachments }` via
  `GM_getValue`/`GM_setValue`. `frontmatter` is Markdown-only and dimmed
  (`syncMdOnly`) when `format === "json"`.
- **Collapsible-drawer mount + dual-persistence re-mount:** Gemini's sidebar
  (`mat-nav-list`) only exists in the DOM while the drawer is open, so
  `mountUI` prepends the native trigger row into it when present and falls
  back to a floating pill on `document.body` otherwise, upgrading the pill
  into the native row on the next mount once the drawer opens. Because
  Gemini's Angular sidebar tears down and re-renders across navigation,
  `mountUI` is kept idempotent and re-invoked two ways: a debounced
  `MutationObserver` on `document.documentElement` (primary, catches most
  re-renders) and a low-frequency `setInterval` reconciliation loop (belt-
  and-suspenders — catches full remounts the observer misses, by checking
  whether the trigger/modal are still connected via `getElementById`). The
  Escape-key listener that closes the modal is bound at most once (guarded by
  a module-level `escBound` flag) so repeated `mountUI` rebuilds don't
  accumulate duplicate `keydown` listeners.
- **Out of scope:** Deep Research immersive reports (different DOM structure
  from a normal conversation), and uploaded image bytes (attachments capture
  file names only, via `SEL.attachmentChip`). The Export-All content path
  (API) currently omits extended-thinking and attachment extraction that the
  single-conversation DOM path captures — a possible future enhancement
  (prompt attachment URLs sit at `turn[2][0][5]`).
- **Scope:** exports the operator's own conversations only. No detection
  evasion, no mass collection.

## Constraints

- Keep TypeScript strict mode intact (`tsconfig.json` sets `strict: true`).
- Keep `src/main.ts` import-free; `vite-plugin-monkey` supplies the metadata header.
- Do not hand-edit `dist/*.user.js`; it is regenerated by `pnpm build`.
- `test/run.mjs` runs the **built** bundle — run `pnpm build` before `pnpm test` (or use the monorepo root's `pnpm -r build && pnpm -r test`).
