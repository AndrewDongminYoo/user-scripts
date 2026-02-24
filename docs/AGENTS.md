# AGENTS.md (docs)

Documentation operating guide for `docs/`.

## Purpose

- Hold planning/design docs that guide implementation work.
- Make implementation state explicit so documentation does not overstate progress.

## Structure

```text
docs/
└── plans/
    ├── YYYY-MM-DD-<topic>-design.md
    └── YYYY-MM-DD-<topic>.md
```

## Authoring Rules

- Keep a clear status line near the top:
  - `Draft`, `Approved (Not implemented yet)`, `In progress`, or `Completed`.
- Distinguish clearly between:
  - Proposed architecture/design
  - Implementation plan
  - Actually implemented code
- If implementation diverges from plan, update the doc on the same day.

## Alignment Checklist

- When code is changed:
  - update related plan status
  - update affected assumptions/expected files
  - link back to current source-of-truth location
- Avoid copying full project overview here; keep that in root `AGENTS.md` and `CLAUDE.md`.
