---
issue: https://github.com/aglowinthefield/impression/issues/89
budget_usd: 15
---

## Approach

Grow `memory_events`, which the staleness check already writes, into the log of every change to a memory. Each place that changes a memory's text or status writes its event in the same transaction as the change, so a change can't exist without its entry. Dream runs aren't memory changes and already have `dream_runs`, so the activity endpoint merges both into one list instead of copying runs into the event table.

Undo is a normal write: it applies the reverse change through the same code paths and records an `undone` event that points at the event it reverses. An event can be undone only if it is the memory's latest change that isn't undone (AC8), which keeps undo from fighting later edits.

Options it beat:
- Deriving the log from `memories` columns (`created_at`, `superseded_by`, `updated_at`): cheap, but it loses merges (text rewritten in place), why a change happened, and the text before it, so undo of a merge would be impossible.
- A generic audit table with row snapshots: complete, but every reader has to interpret raw diffs, and it logs changes this page doesn't need (embeddings, checked_at).

## Data model and contracts

`memory_events` (migration):
- `kind` enum gains `extracted`, `merged`, `superseded`, `edited`, `reactivated`. `retired` now also covers a person's retire.
- New columns: `actor` (`extraction` | `check` | `person`), `principal` (who acted, for `person`), `session_id` (nullable, the session an extraction came from), `undoes` (nullable, the event this one reverses), `undone_by` (nullable, the event that reversed this one).
- `detail` carries `before` and `after` text for `merged`, `edited` and `rewritten`, and `ids` of memories superseded for `extracted` and `superseded`.
- The existing indexes on `(memory_id, created_at)` and `created_at` cover the list query, which filters by project through `memories`.

Endpoints, all behind the existing auth and access check:
- `GET /activity?project=<key>&source=extraction|check|dream|person&before=<cursor>`: 50 entries newest first, each `{ id, at, kind, actor, memory: { id, content, scope } | null, before?, after?, reason, session?: { id, agent }, run?: { created, kept, removed, uncategorized, concepts }, undone, canUndo }`, plus `next` cursor. Rows for memories the caller can't see now are filtered out in the query.
- `GET /activity/summary?project=<key>`: four weekly buckets `{ week, added, rewritten, retired, retireRate }`.
- `POST /activity/:eventId/undo`: 200 with the undo entry; 409 when a later change exists; 403 when the caller may not undo.

Web: an Activity tab replaces Review and Evals; `/review` and `/evals` paths resolve to Activity. The Evals component moves under Debug unchanged.

## Invariants

- memories/I1: holds. Events store text already scrubbed when the memory was written; undo restores stored text and never takes new input.
- memories/I2: holds. The list joins through the same visibility filter as `/memories`, so an event of a memory the caller can't see never returns (AC12).
- memories/I3: holds. Undo retires or reactivates; it never deletes a row.
- memories/I4: holds. Undoing a supersede reactivates the older memory as it was; superseded text is never edited.
- memories/I5: holds. Activity is optional reading; nothing waits on it.
- memories/I6: holds. Dream entries are read from `dream_runs` and offer no undo.
- memories/I7: holds. Undo never moves a memory between projects.
- memories/I8: holds. No model calls.
- memories/I9: holds. Activity doesn't search or serve memories.

## Tasks

- [ ] t1: Event log and the Activity list. Migration; every change site (extraction create, merge and supersede, staleness check, person edit and retire) writes its event in the same transaction; `GET /activity` with source filter, cursor paging and dream runs merged in; the Activity tab listing entries with their reasons and before/after text; Review and Evals tabs removed with their old paths opening Activity; Evals moved under Debug. Criteria: AC1, AC2, AC3, AC4, AC5, AC10, AC12, AC13
- [ ] t2: Undo. `POST /activity/:eventId/undo` with the reverse change per kind, the later-change check and the permission rule; the undo button, the undone mark and the refusal message. Criteria: AC6, AC7, AC8, AC9. after: t1
- [ ] t3: Four-week summary. `GET /activity/summary` and the weekly row above the list. Criteria: AC11. after: t1
- [ ] t4: Flagged memories after Review goes, as AC14 decides. Criteria: AC14. after: t1
