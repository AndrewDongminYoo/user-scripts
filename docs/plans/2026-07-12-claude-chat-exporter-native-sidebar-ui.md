# claude-chat-exporter Native Sidebar UI Implementation Plan

> **For agentic workers:** This plan is executed INLINE (single-file UI rewrite + live-browser verification). Steps use checkbox (`- [ ]`) syntax for tracking. Strict per-line TDD does not fit a browser-rendered userscript UI (the Node harness cannot verify appearance, dark mode, or SPA re-mount — see spec Verification); the automated gate is typecheck + build + the existing harness, and the real gate is live browser.

**Goal:** Replace the bottom-right floating overlay with a native-looking Export item in Claude's sidebar that opens a full Exporter Settings modal, with a floating-pill fallback.

**Architecture:** Rewrite only the `/** ---------- UI ---------- */` section of `claude-chat-exporter/src/main.ts` (roughly lines 825-1013). All render/API/ZIP/export functions above it are untouched. Trigger (sidebar item or fallback pill) opens one body-mounted modal. Styling flows through `GM_addStyle` consuming Claude's `<html>`-scoped CSS variables so it auto-themes.

**Tech Stack:** TypeScript, `vite-plugin-monkey`, GM APIs (`GM_addStyle`/`GM_getValue`/`GM_setValue`), Node test harness.

## Global Constraints

- Package manager: pnpm only (`pnpm@10.26.2`). `src/main.ts` stays import-free.
- Never hand-edit `dist/*.user.js` (vite-plugin-monkey generates the header).
- Korean comments/user-facing strings are intentional; identifiers/commit messages in English.
- Must pass `pnpm --filter claude-chat-exporter typecheck` and `trunk` before commit.
- Keep the persisted `Settings` shape (`cce_settings`) identical — no new keys.
- Verified live (2026-07-12): mount anchor `.dframe-sidebar-body`; bottom tray `.df-bottom-tray.shrink-0`; theme vars on `<html>` (`--bg-*`, `--text-*`, `--border-*`, `--radius-md/lg`, `--cds-clay`=#d97757, `--cds-clay-emphasized`=#c6613f); do NOT use `--df-*` in the body-mounted modal.
- **ID preservation (regression tests depend on these):** export actions keep ids `__claude_export_btn` (this-chat) and `__claude_export_all_btn` (all); settings controls keep `__cce_fmt_md`, `__cce_fmt_json`, `__cce_frontmatter`, `__cce_timestamps`, `__cce_thinking`, `__cce_tools`, `__cce_attachments`. Radios/checkboxes are kept as real `<input>`s (styled via CSS as a segmented control / switches) so `el.checked = …; el._on.change()` still drives them.

---

### Task 1: Rewrite the UI section — styles, modal, trigger

**Files:**

- Modify: `claude-chat-exporter/src/main.ts` (replace the UI section, lines ~825-1013)

**Interfaces:**

- Consumes (unchanged, defined above the UI section): `settings`, `saveSettings`, `loadSettings`, `exportCurrentConversation()`, `exportAllConversations(onProgress)`, `BlockOpts`, `Settings`.
- Produces: `mountUI()` and the module-level MutationObserver (Task 2). Helpers `buildModal()`, `openModal()`, `closeModal()`, `buildTrigger(kind)`.

- [ ] **Step 1: Replace the `GM_addStyle` block** with native-themed CSS. Ids: modal `__claude_export_modal`, trigger `__claude_export_trigger`. Use Claude vars for color/dark-mode; literal sizes elsewhere.

```ts
const MODAL_ID = "__claude_export_modal";
const TRIGGER_ID = "__claude_export_trigger";

// Styling flows through GM_addStyle (Tampermonkey sandbox => CSP-exempt). Colors
// consume Claude's <html>-scoped custom props so light/dark track automatically.
// (--df-* are sidebar-frame-scoped and empty at body level — not used in the modal.)
GM_addStyle(`
  /* --- sidebar trigger (native nav-row look) --- */
  #${TRIGGER_ID} {
    display: flex; align-items: center; gap: 8px; width: 100%;
    height: 32px; padding: 0 8px; margin: 2px 0;
    border: none; background: transparent; cursor: pointer;
    font: 400 14px/1 inherit; color: hsl(var(--text-300));
    border-radius: 8px; text-align: left;
  }
  #${TRIGGER_ID}:hover { background: hsl(var(--bg-300)); color: hsl(var(--text-100)); }
  #${TRIGGER_ID} svg { width: 16px; height: 16px; flex: 0 0 auto; }
  /* --- fallback floating pill --- */
  #${TRIGGER_ID}.cce-floating {
    position: fixed; bottom: 20px; right: 20px; z-index: 2147483646;
    width: auto; height: auto; padding: 8px 14px; margin: 0;
    background: var(--cds-clay); color: #fff; font-weight: 600;
    border-radius: 999px; box-shadow: 0 2px 8px rgba(0,0,0,.25);
  }
  #${TRIGGER_ID}.cce-floating:hover { background: var(--cds-clay-emphasized); color: #fff; }
  /* --- modal --- */
  #${MODAL_ID} { position: fixed; inset: 0; z-index: 2147483647; display: none; }
  #${MODAL_ID}.open { display: block; }
  #${MODAL_ID} .cce-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.5); }
  #${MODAL_ID} .cce-panel {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
    width: min(420px, calc(100vw - 32px)); max-height: calc(100vh - 64px); overflow-y: auto;
    background: hsl(var(--bg-100)); color: hsl(var(--text-100));
    border: 1px solid hsl(var(--border-300, var(--border-200))); border-radius: var(--radius-lg, 12px);
    box-shadow: 0 12px 48px rgba(0,0,0,.3); padding: 20px; font: 400 14px/1.4 inherit;
  }
  #${MODAL_ID} .cce-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  #${MODAL_ID} .cce-title { font-size: 16px; font-weight: 600; }
  #${MODAL_ID} .cce-x { border: none; background: transparent; cursor: pointer; font-size: 20px; line-height: 1; color: hsl(var(--text-300)); padding: 4px; border-radius: 6px; }
  #${MODAL_ID} .cce-x:hover { background: hsl(var(--bg-300)); }
  #${MODAL_ID} .cce-section { margin-bottom: 16px; }
  /* segmented format control (real radios hidden) */
  #${MODAL_ID} .cce-seg { display: flex; gap: 4px; padding: 3px; background: hsl(var(--bg-300)); border-radius: 8px; }
  #${MODAL_ID} .cce-seg input { position: absolute; opacity: 0; pointer-events: none; }
  #${MODAL_ID} .cce-seg label { flex: 1; text-align: center; padding: 6px 0; border-radius: 6px; cursor: pointer; color: hsl(var(--text-300)); }
  #${MODAL_ID} .cce-seg input:checked + label { background: hsl(var(--bg-000)); color: hsl(var(--text-100)); box-shadow: 0 1px 2px rgba(0,0,0,.1); }
  /* switch rows (real checkboxes styled as track+knob) */
  #${MODAL_ID} .cce-row { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; }
  #${MODAL_ID} .cce-row.cce-disabled { opacity: .4; pointer-events: none; }
  #${MODAL_ID} .cce-sw { position: relative; width: 36px; height: 20px; flex: 0 0 auto; }
  #${MODAL_ID} .cce-sw input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
  #${MODAL_ID} .cce-sw .cce-track { position: absolute; inset: 0; background: hsl(var(--bg-400)); border-radius: 999px; transition: background .15s; }
  #${MODAL_ID} .cce-sw .cce-track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; background: #fff; border-radius: 50%; transition: transform .15s; }
  #${MODAL_ID} .cce-sw input:checked + .cce-track { background: var(--cds-clay); }
  #${MODAL_ID} .cce-sw input:checked + .cce-track::after { transform: translateX(16px); }
  /* actions + progress */
  #${MODAL_ID} .cce-actions { display: flex; gap: 8px; margin-top: 8px; }
  #${MODAL_ID} .cce-btn { flex: 1; padding: 10px; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 14px; }
  #${MODAL_ID} .cce-btn:disabled { opacity: .6; cursor: default; }
  #${MODAL_ID} .cce-primary { background: var(--cds-clay); color: #fff; }
  #${MODAL_ID} .cce-primary:hover:not(:disabled) { background: var(--cds-clay-emphasized); }
  #${MODAL_ID} .cce-secondary { background: hsl(var(--bg-300)); color: hsl(var(--text-100)); }
  #${MODAL_ID} .cce-secondary:hover:not(:disabled) { background: hsl(var(--bg-400)); }
  #${MODAL_ID} .cce-progress { margin-top: 10px; min-height: 18px; font-size: 13px; color: hsl(var(--text-300)); text-align: center; }
`);
```

- [ ] **Step 2: Add small DOM helpers** (`elc` for classed element, `swRow` for a switch row, `segOpt` for a format option). These keep control ids stable.

```ts
function elc<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

// A labeled switch backed by a real checkbox with a stable id (tests drive it).
function swRow(
  id: string,
  label: string,
  key: keyof BlockOpts | "frontmatter" | "messageTimestamps",
): HTMLDivElement {
  const row = elc("div", "cce-row");
  const text = elc("span");
  text.textContent = label;
  const sw = elc("label", "cce-sw");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = id;
  input.checked = settings[key] as boolean;
  input.addEventListener("change", () => {
    settings = { ...settings, [key]: input.checked };
    saveSettings(settings);
  });
  const track = elc("span", "cce-track");
  sw.appendChild(input);
  sw.appendChild(track);
  row.appendChild(text);
  row.appendChild(sw);
  return row;
}
```

- [ ] **Step 3: Write `buildModal()`** — format segmented control (radios `__cce_fmt_md`/`__cce_fmt_json`), the five switch rows (ids preserved), md-only rows dimmed when JSON, action buttons (`__claude_export_btn`, `__claude_export_all_btn`) with inline progress. Wire `runExport` (kept) to the action buttons and the progress element. On format change, toggle `.cce-disabled` on the two md-only rows. Append modal to `document.body`.

```ts
let progressEl: HTMLDivElement | null = null;
let mdOnlyRows: HTMLDivElement[] = [];

function syncMdOnly(): void {
  const dim = settings.format === "json";
  for (const r of mdOnlyRows) r.classList.toggle("cce-disabled", dim);
}

function buildModal(): HTMLDivElement {
  const modal = elc("div");
  modal.id = MODAL_ID;
  const backdrop = elc("div", "cce-backdrop");
  backdrop.addEventListener("click", closeModal);
  const panel = elc("div", "cce-panel");

  const head = elc("div", "cce-head");
  const title = elc("div", "cce-title");
  title.textContent = "Exporter Settings";
  const x = elc("button", "cce-x");
  x.type = "button";
  x.textContent = "✕";
  x.addEventListener("click", closeModal);
  head.appendChild(title);
  head.appendChild(x);

  // format
  const seg = elc("div", "cce-seg cce-section");
  const mk = (id: string, val: Format, label: string): void => {
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "cce_fmt";
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
  mk("__cce_fmt_md", "md", "Markdown");
  mk("__cce_fmt_json", "json", "JSON");

  // options
  const opts = elc("div", "cce-section");
  const fmRow = swRow("__cce_frontmatter", "Frontmatter (md)", "frontmatter");
  const tsRow = swRow(
    "__cce_timestamps",
    "Message timestamps (md)",
    "messageTimestamps",
  );
  mdOnlyRows = [fmRow, tsRow];
  opts.appendChild(fmRow);
  opts.appendChild(tsRow);
  opts.appendChild(
    swRow("__cce_thinking", "Extended thinking", "includeThinking"),
  );
  opts.appendChild(swRow("__cce_tools", "Tool calls", "includeToolCalls"));
  opts.appendChild(
    swRow("__cce_attachments", "Attachments", "includeAttachments"),
  );

  // actions + progress
  const actions = elc("div", "cce-actions");
  const oneBtn = elc("button", "cce-btn cce-primary") as HTMLButtonElement;
  oneBtn.id = ONE_ID;
  oneBtn.type = "button";
  oneBtn.textContent = ONE_LABEL;
  const allBtn = elc("button", "cce-btn cce-secondary") as HTMLButtonElement;
  allBtn.id = ALL_ID;
  allBtn.type = "button";
  allBtn.textContent = ALL_LABEL;
  progressEl = elc("div", "cce-progress");

  oneBtn.addEventListener("click", () => {
    runExport(oneBtn, ONE_LABEL, async () => {
      await exportCurrentConversation();
      return "Done";
    });
  });
  allBtn.addEventListener("click", () => {
    runExport(allBtn, ALL_LABEL, async () => {
      const { exported, failed } = await exportAllConversations(
        (done, total) => {
          if (progressEl)
            progressEl.textContent = `Exporting ${done}/${total}…`;
        },
      );
      return failed > 0
        ? `Done (${exported}, ${failed} failed)`
        : `Done (${exported})`;
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
```

- [ ] **Step 4: Adapt `runExport`** to write its result into the progress line instead of relabeling a floating button when in the modal. Keep the existing signature; on done/fail, also set `progressEl.textContent` to the returned label. (Button relabel + re-enable stays for the disabled state.)

- [ ] **Step 5: Add `openModal`/`closeModal`** with Esc handling (single document keydown listener, added once).

```ts
function openModal(): void {
  const m = document.getElementById(MODAL_ID);
  if (m) m.classList.add("open");
}
function closeModal(): void {
  const m = document.getElementById(MODAL_ID);
  if (m) m.classList.remove("open");
}
// Esc closes (registered once at mount).
```

---

### Task 2: Mount strategy — sidebar item, fallback, re-mount

**Files:**

- Modify: `claude-chat-exporter/src/main.ts` (`mountUI` + observer)

**Interfaces:**

- Consumes: `buildModal`, `openModal`, `TRIGGER_ID`, `MODAL_ID` (Task 1).
- Produces: `mountUI()` called at module end; MutationObserver re-mount.

- [ ] **Step 1: `buildTrigger(floating: boolean)`** returns the Export button (download SVG + label), id `TRIGGER_ID`, click → `openModal`. Floating variant adds class `cce-floating`.

```ts
const DL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>`;
function buildTrigger(floating: boolean): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.id = TRIGGER_ID;
  btn.type = "button";
  if (floating) {
    btn.className = "cce-floating";
    btn.textContent = "⬇ Export";
  } else {
    const icon = document.createElement("span");
    icon.innerHTML = DL_SVG;
    const label = document.createElement("span");
    label.textContent = "Export";
    btn.appendChild(icon);
    btn.appendChild(label);
  }
  btn.addEventListener("click", openModal);
  return btn;
}
```

- [ ] **Step 2: `mountUI()`** — mount modal once (by `MODAL_ID` guard); mount trigger once (by `TRIGGER_ID` guard) into `.df-bottom-tray` (first child) → else `.dframe-sidebar-body` (append) → else floating pill on `document.body`. Register the Esc listener once.

```ts
function mountUI(): void {
  if (!document.getElementById(MODAL_ID)) {
    document.body.appendChild(buildModal());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
    });
  }
  if (document.getElementById(TRIGGER_ID)) return;
  const sidebar = document.querySelector(".dframe-sidebar-body");
  if (sidebar) {
    const tray = sidebar.querySelector(".df-bottom-tray");
    const item = buildTrigger(false);
    if (tray) tray.insertBefore(item, tray.firstChild);
    else sidebar.appendChild(item);
  } else {
    document.body.appendChild(buildTrigger(true));
  }
}
```

- [ ] **Step 3: Re-mount observer** — debounced, guarded so our own insertion doesn't thrash. Re-mount when our trigger is gone.

```ts
let remountQueued = false;
const observer = new MutationObserver(() => {
  if (document.getElementById(TRIGGER_ID) && document.getElementById(MODAL_ID))
    return;
  if (remountQueued) return;
  remountQueued = true;
  setTimeout(() => {
    remountQueued = false;
    mountUI();
  }, 200);
});
observer.observe(document.documentElement, { childList: true, subtree: true });
```

Note: `setTimeout` is stubbed as a no-op in the harness (re-mount is not exercised there — it is a live-browser check).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter claude-chat-exporter typecheck`
Expected: no errors.

---

### Task 3: Harness update, build, verify

**Files:**

- Modify: `claude-chat-exporter/test/run.mjs` (stub `document.querySelector`/`addEventListener`; fix the one gear-button assertion)

- [ ] **Step 1: Extend the sandbox `document` stub** so `mountUI` runs the fallback path. Add to the `document` object in `makeSandbox`:

```js
querySelector: () => null,
addEventListener: () => {},
```

(With `querySelector` returning null, `mountUI` takes the floating-pill branch; the modal + both action buttons + all settings controls are created and pushed to `allEls`, so every id-based test keeps working.)

- [ ] **Step 2: Fix `testSettingsPanel`** — it asserts the old gear id `__claude_export_cfg_btn`, which no longer exists. Replace that one assertion with the new trigger:

```js
const trigger = s.allEls.find((e) => e.id === "__claude_export_trigger");
check("export trigger mounted", !!trigger);
```

(Leave the rest of that test — `__cce_fmt_json` select + `__cce_timestamps` toggle — unchanged.)

- [ ] **Step 3: Build**

Run: `pnpm --filter claude-chat-exporter build`
Expected: writes `dist/claude-chat-exporter.user.js`, no type errors.

- [ ] **Step 4: Run the harness**

Run: `pnpm --filter claude-chat-exporter test`
Expected: `all checks passed`.

- [ ] **Step 5: Commit** (source + harness + built dist together, per repo convention where dist is tracked).

```bash
git add claude-chat-exporter/src/main.ts claude-chat-exporter/test/run.mjs claude-chat-exporter/dist/claude-chat-exporter.user.js
git commit -m "feat(claude-chat-exporter): native sidebar Export item + settings modal"
```

- [ ] **Step 6: Live-browser verification** (the real gate — Node harness cannot cover this). On claude.ai with the dev/built script loaded:
  1. Export item appears in the sidebar bottom tray, styled like a native row.
  2. Click opens the modal; it themes correctly in light AND dark (toggle Claude's theme).
  3. Change format → md-only rows dim; toggles persist across reload (`GM_getValue`).
  4. `Export this chat` downloads the current conversation; `Export all` shows inline progress then downloads the ZIP.
  5. Navigate between chats/routes → the item re-mounts without duplicates.
  6. Collapse the sidebar (⌘B) → confirm the floating-pill fallback appears and opens the same modal.

## Self-review

- **Spec coverage:** sidebar item (T2), modal with format+5 toggles+actions+progress (T1), native theming via vars (T1 styles), fallback (T2 S2), re-mount (T2 S3), unchanged render/export (only UI section touched), identical settings shape (ids + keys preserved). All covered.
- **Placeholder scan:** none — every step has concrete code or an exact command.
- **Type consistency:** `ONE_ID`/`ALL_ID`/`ONE_LABEL`/`ALL_LABEL` reused from existing constants; `runExport`, `exportCurrentConversation`, `exportAllConversations`, `BlockOpts`, `Settings`, `Format` all pre-existing. New helpers `elc`/`swRow`/`buildModal`/`buildTrigger`/`openModal`/`closeModal`/`syncMdOnly` are self-consistent across tasks.
