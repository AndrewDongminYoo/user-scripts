# claude-chat-exporter Export Options Design

**Date**: 2026-07-11
**Status**: Completed

## Goal

Add a second export phase to `claude-chat-exporter`: user-configurable output
options — Markdown vs JSON, optional YAML frontmatter, and optional per-message
timestamps — surfaced through a lightweight settings panel and persisted across
sessions. The options apply to both single-conversation export and Export All.

## Scope

In scope:

- **Markdown** output (existing renderer, extended with frontmatter + timestamps).
- **JSON** output (new), using a normalized, stable schema.
- **Settings panel** (⚙️) with three controls, persisted via `GM_getValue`/`GM_setValue`.
- Options honored by both `Export MD` (single) and `Export All` (zip).

Out of scope (deferred / dropped):

- **HTML** output — needs a Markdown→HTML renderer + styling; next phase candidate.
- **Screenshot / PNG** — heavy dependency (html2canvas ~200 KB), unreliable on
  long conversations, low utility (not searchable/editable). Excluded.
- **`{model_name}`** frontmatter field — the API exposes only `model` (the raw
  id); there is no clean source for a friendly name, so this field is dropped.
- Per-field frontmatter toggles, filename templates, attachment / extended-thinking
  / branch export.

## Data availability (verified live 2026-07-11)

All requested fields come from data already fetched — no new endpoints:

- Conversation list item: `name`, `model`, `created_at`, `updated_at`, `is_starred`.
- Conversation detail: `chat_messages[].created_at`, `sender`, `content[].text`.

To fill `model` / `created_at` / `updated_at` for frontmatter, prefer these
fields from the conversation **detail** response when present (the conversation
object typically carries them); otherwise fall back to the matching **list**
entry by `uuid`. Export All already has the list entry per conversation. This
"detail-first, list-fallback" resolution avoids assuming a specific response
shape — the actual field presence is confirmed with a one-time `Object.keys` log
during implementation.

## Settings model

Persisted under one key via `GM_setValue("cce_settings", {...})`, read at startup
with defaults:

| Key                 | Type             | Default | Meaning                                  |
| ------------------- | ---------------- | ------- | ---------------------------------------- |
| `format`            | `"md" \| "json"` | `"md"`  | Output format for both export flows      |
| `frontmatter`       | `boolean`        | `true`  | Emit YAML frontmatter (Markdown)         |
| `messageTimestamps` | `boolean`        | `false` | Append each message's time to its header |

Changes persist immediately on toggle.

## Frontmatter (Markdown, when `frontmatter` is on)

```yaml
---
title: <name>
source: https://claude.ai/chat/<uuid>
model: <model> # raw API id, e.g. claude-opus-4-...
create_time: <created_at>
update_time: <updated_at>
date: <export date, YYYY-MM-DD>
timestamp: <export time, ISO 8601>
---
```

Values are YAML-escaped (quote strings containing `:` or leading special chars).
When `frontmatter` is off, the existing `# <title>` + blockquote header is used.

## Per-message timestamps (when `messageTimestamps` is on)

Role headers gain the message time from `created_at`:

```markdown
## 👤 User · 2026-07-11 17:40
```

Format: `YYYY-MM-DD HH:mm` from the ISO `created_at`. Off by default. Messages
without `created_at` render the plain header.

## JSON output (normalized schema)

Chosen over a raw API dump (unstable, large). One object per conversation:

```json
{
  "title": "<name>",
  "source": "https://claude.ai/chat/<uuid>",
  "model": "<model>",
  "create_time": "<created_at>",
  "update_time": "<updated_at>",
  "exported_at": "<ISO now>",
  "messages": [
    { "role": "user", "text": "...", "created_at": "<created_at>" },
    { "role": "assistant", "text": "...", "created_at": "<created_at>" }
  ]
}
```

`role` maps `sender === "human"` → `"user"`, else `"assistant"`. `text` uses the
same block-join + legacy-`text` fallback as the Markdown renderer; empty messages
are skipped. Export All + JSON → a zip of `.json` files (same naming/dedup as
Markdown, `.json` extension).

## UI — settings panel

- A small `⚙️` button joins the existing button column (`Export All`, `Export MD`).
- Clicking it toggles a small panel anchored above the buttons containing the
  three settings (a `md`/`json` segmented control or radio, two checkboxes).
- Panel markup is created with `document.createElement` and styled via the
  existing `GM_addStyle` block — no dependency.
- Toggling a control writes settings immediately and updates in-memory state.

## Grants

Add `GM_getValue` and `GM_setValue` (established repo precedent —
`wanted-applied-marker`). Keep `GM_addStyle`. Declare the new globals in
`src/env.d.ts` alongside `GmAddStyleType`.

## Integration points (`src/main.ts`)

- New `Settings` interface + `loadSettings()` / `saveSettings()` (GM storage).
- `toMarkdown(conv, chatId, opts)` gains `{ frontmatter, messageTimestamps, meta }`
  where `meta` carries `model` / `created_at` / `updated_at` for frontmatter.
- New `toJSON(conv, chatId, meta)` returning the normalized object (stringified).
- New `renderConversation(...)` picks Markdown vs JSON and returns
  `{ text, extension }` so both export flows share one code path.
- `exportCurrentConversation` and `exportAllConversations` read settings, resolve
  per-conversation `meta` (detail-first, list-fallback), and use
  `renderConversation`.
- New settings-panel mount alongside the existing button-mount, re-mounted by the
  same `MutationObserver`.

## Testing / verification

- Extend the Node harness (drives the built userscript with stubbed DOM/fetch):
  - Markdown with frontmatter on/off and timestamps on/off — assert YAML block,
    header timestamps, escaping.
  - JSON output — assert normalized shape, role mapping, empty-message skipping.
  - Settings persistence — stub `GM_getValue`/`GM_setValue`, assert round-trip.
  - Export All in JSON mode — assert zip contains `.json` files (validate with
    `ditto`, as for the Markdown zip).
- `pnpm typecheck` + `trunk check` clean; build under the working v7 toolchain.

## Notes

- Independent of the deferred `vite-plugin-monkey` 8 bump (branch
  `chore/deps-bump-vpm8`); implement on the working v7 toolchain on `main`.
