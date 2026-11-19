---
issue: https://github.com/aglowinthefield/impression/issues/95
budget_usd: 10
---

## Approach

Sessions store the project key they were uploaded for instead of a reference to a project row. Nothing about a session needs the row: sessions are visible only to their owner, and access to a GitHub key is a repo-access check on the key itself. A project row is then created only where a memory is written, which is the lazy create extraction already does for candidate repos. The session's own target joins that path instead of arriving with a row made at upload.

Practices are user-scoped and record the session's project only as their origin. They keep recording it when the project exists, and record none when it doesn't, so a practice from a home-folder session doesn't create a project (AC4).

The list filter (AC1) is already on the `nitpick/ui` branch (commit "List only projects that hold memories"). If that branch merges first, t1 keeps it; otherwise t1 carries it.

Options it beat:
- Keep creating rows and delete empty ones on a schedule: the clutter comes back between runs, and a delete job can race a first memory.
- Keep `sessions.project_id` but make it nullable and fill it when the project appears: two sources of truth for the same fact, and a backfill on every first memory.
- Stop uploading sessions from folders outside a repo: loses the practices those sessions produce.

## Data model and contracts

`sessions` (migration):
- Add `project_key text not null`, backfilled from the project each session points at.
- Drop `project_id`, its foreign key and the indexes on it; add an index on `(owner, project_key, created_at)` for dedup and listing.
- Delete projects no row in any table references after the backfill (the three session-only projects in prod, AC7).

Access: a check-only counterpart of the project upsert, used by session upload: admin, a `path:` key, or a GitHub key in the caller's repos passes; anything else is a 404 as today (AC5). Nothing is inserted.

`POST /sessions`: same request and response. Dedup matches on `(project_key, owner, transcript)` within a day.

`GET /sessions?project=<key>`: filters on `project_key` (AC6), and access on the key.

Extraction: the session's own target starts with no project id, so its first non-practice memory goes through the existing lazy create (AC3). Practices take the session's project id only if it already exists.

`GET /projects`: the last-active time reads sessions by key; projects are listed only when a memory references them (AC1).

Eval turns: per the answer to AC8.

## Invariants

- memories/I1: holds. Transcripts are scrubbed before storing, as now; only the column that points at the project changes.
- memories/I2: holds. Sessions stay owner-only, and access to a key is checked on upload and on listing. A project created by a first memory has the same visibility it would have had from an upload.
- memories/I3: holds. No memory row is deleted; the migration deletes only projects nothing references.
- memories/I4: holds. Superseded memories aren't touched.
- memories/I5: holds. Nothing waits on a person.
- memories/I6: holds. Dreaming reads projects that hold memories, which this keeps.
- memories/I7: holds. Extraction's choice of project and the drop for inaccessible repos are unchanged; only the moment the session's project row is created moves.
- memories/I8: holds. No model calls.
- memories/I9: holds. Serving and search are untouched.

## Tasks

- [ ] t1: Sessions store their project key. Migration with backfill and the delete of session-only projects; the check-only access step on upload; dedup and the sessions list on the key; extraction creating the session's project on its first project memory and practices recording an existing project only; the project list filter and last-active time; eval turns per AC8; API tests for each criterion. Criteria: AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8
