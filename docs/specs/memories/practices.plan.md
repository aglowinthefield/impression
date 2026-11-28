---
issue: https://github.com/aglowinthefield/impression/issues/119
budget_usd: 15
---

## Approach

Teach extraction the two rules, then run the same rules once over what is stored. Extraction gains an instruction to move repo specifics out of a practice into a fact for the repo they name (picked from the session's candidates, else the session's own project, per memories/I7), and to drop to-dos. A script, `pnpm db:scope-pass`, reuses that instruction on stored memories in batches, and writes its changes through the supersede and retire paths Activity already logs and can undo. An agent runs it once against prod, dry run first.

A scheduled pass was built first: a job on the API's dream schedule with a check-mark column and an attempts column. It was dropped as too much permanent code (about 1,500 lines and two migrations) for something that runs once.

Options it beat:
- A scheduled pass on the API: built, then dropped as too much permanent code for one run. An agent runs the script, so it adds no step for the person (memories/I5).
- Folding the rules into the staleness check: that check compares a memory to the code at its anchor, and practices and to-dos have no anchor.
- Asking the person to fix memories in the dashboard: a review queue, which failed before.

Two tasks: t2 waits on t1's rules, which the eval has to show work before they rewrite stored memories, and t2's script is worth reviewing alone.

## Data model and contracts

- t1: the extraction prompt and its parsing only. A practice item may come with a fact item for the same session; no contract change.
- t2: no schema change and no migration.
- t2: the script is `pnpm db:scope-pass [--dry-run] [--before <iso timestamp>]` in `packages/api`, next to the other `db:*` scripts. It reads live memories created before `--before` (default: when it starts), one owner at a time, in batches of one visibility: the owner's private memories, or their team memories in one project. It keeps no mark: what it changed is no longer live and what it created is newer than the cutoff, so a second run with the same cutoff reads neither (AC6). A write checks the memory's `updated_at` against what the batch read. Three unreadable replies give up the batch and the script names its memories.
- t2: the pass actor. Its events are stored with an existing actor value and `detail.by = "scope-pass"`, and Activity reads that back as actor `pass`, with its own source filter (AC5). Superseding and retiring use the existing kinds.
- t2: model calls, the dry run's included, are recorded under a new usage operation, `scope-pass`.

## Invariants

- memories/I1: holds. Text the script writes is scrubbed like extracted text, Activity reasons included.
- memories/I2: holds. The script reads and writes one person's memories at a time, one visibility per model call, and only in projects that person can access now. A split fact lands only in a project they can access now; when that can't be established it is dropped.
- memories/I3: holds. The script retires and supersedes; it deletes nothing.
- memories/I4: holds. Superseded memories aren't read, and undoing an older edit never rewrites one the script superseded.
- memories/I5: holds. An agent runs the script; the person takes no step and can undo afterwards (AC5).
- memories/I6: holds. The script doesn't touch concepts. The next dream regroups as it does after any supersede.
- memories/I7: holds. AC1.
- memories/I8: holds. AC7.
- memories/I9: holds. No search is made.

## Tasks

- [ ] t1: Extraction rules for repo specifics in practices and for to-dos, with the two eval cases. Criteria: AC1, AC2, AC3
- [ ] t2: The one-time script over memories active at the release: `db:scope-pass` with a dry run and a cutoff, batches of one owner and visibility, Activity entries, usage records. after: t1. Criteria: AC4, AC5, AC6, AC7
