# AGENTS.md (gemini-chat-exporter)

Subdirectory guide for `gemini-chat-exporter/`.

## Purpose

- TypeScript + Vite userscript that exports the current gemini.google.com conversation to Markdown/JSON.
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
    ├── main.ts      # DOM scrape + HTML->Markdown converter + UI + download
    └── env.d.ts      # GM_* globals (see Grants note below)
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

- **DOM-scraping rationale:** Gemini exposes no clean, stable API for reading a
  conversation. Its internal RPC (`batchexecute`) is per-build obfuscated and
  fragile to depend on, so the rendered DOM's semantic Angular custom elements
  (`user-query`, `model-response`, `conversation-container`, …) are the stable
  extraction seam instead. This is also why Export-All — which would need to
  _enumerate_ conversations, not just read the currently open one — is
  deferred to v1.1 rather than shipped in v1 on top of a fragile RPC; see the
  blueprint at
  `../docs/plans/2026-07-12-gemini-export-all-batchexecute-blueprint.md`.
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
- **CSP / grants:** `@grant GM_addStyle, GM_getValue, GM_setValue`.
  `GM_addStyle` doubles as the button/modal CSS injector and, as a real
  `GM_*` grant, forces Tampermonkey into its sandboxed world — which is
  exempt from Gemini's page CSP (a `@grant none` script runs in the page's
  main world and would be blocked). The file download uses a `Blob` +
  temporary anchor, which works in the sandbox.
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
- **Out of scope (v1):** Export-All (deferred to v1.1, see the blueprint doc
  above), Deep Research immersive reports (different DOM structure from a
  normal conversation), and uploaded image bytes (attachments capture file
  names only, via `SEL.attachmentChip`).
- **Scope:** exports the operator's own conversations only. No detection
  evasion, no mass collection.

## Constraints

- Keep TypeScript strict mode intact (`tsconfig.json` sets `strict: true`).
- Keep `src/main.ts` import-free; `vite-plugin-monkey` supplies the metadata header.
- Do not hand-edit `dist/*.user.js`; it is regenerated by `pnpm build`.
- `test/run.mjs` runs the **built** bundle — run `pnpm build` before `pnpm test` (or use the monorepo root's `pnpm -r build && pnpm -r test`).
