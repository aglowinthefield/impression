---
issue: https://github.com/aglowinthefield/impression/issues/119
budget_usd: 15
---

## Approach

Teach extraction the two rules, then run the same rules once over what is stored. Extraction gains an instruction to move repo specifics out of a practice into a fact for the repo they name (picked from the session's candidates, else the session's own project, per memories/I7), and to drop to-dos. The pass reuses that instruction on stored memories in batches, from the API's existing schedule, and writes its changes through the supersede and retire paths Activity already logs and can undo.

Options it beat:
- A script someone runs by hand after the release: a step for a person (memories/I5).
- Folding the rules into the staleness check: that check compares a memory to the code at its anchor, and practices and to-dos have no anchor.
- Asking the person to fix memories in the dashboard: a review queue, which failed before.

Two tasks: t2 waits on t1's rules, which the eval has to show work before they rewrite stored memories, and t2 adds a schema change and a scheduled job that are worth reviewing alone.

## Data model and contracts

- t1: the extraction prompt and its parsing only. A practice item may come with a fact item for the same session; no contract change.
- t2: migration adds `memories.scope_checked_at` (nullable timestamptz). The pass selects active memories created before the release with it null, and sets it in the same transaction as its change, or alone when nothing changes.
- t2: `memory_events` actor gains `pass`, so Activity can show and filter the pass's changes (AC5). Superseding and retiring use the existing kinds.
- t2: model calls are recorded under a new usage operation, `scope-pass`.

## Invariants

- memories/I1: holds. Text the pass writes is scrubbed like extracted text.
- memories/I2: holds. The pass reads and writes one person's memories at a time, and a split fact lands only in a project that person can access.
- memories/I3: holds. The pass retires and supersedes; it deletes nothing.
- memories/I4: holds. Superseded memories are skipped (AC6) and never edited.
- memories/I5: holds. The pass runs on its own; the person can undo afterwards (AC5).
- memories/I6: holds. The pass doesn't touch concepts. The next dream regroups as it does after any supersede.
- memories/I7: holds. AC1.
- memories/I8: holds. AC7.
- memories/I9: holds. No search is made.

## Tasks

- [ ] t1: Extraction rules for repo specifics in practices and for to-dos, with the two eval cases. Criteria: AC1, AC2, AC3
- [ ] t2: The one-time pass over memories active at the release: check mark, batches from the schedule, Activity entries, usage records. after: t1. Criteria: AC4, AC5, AC6, AC7
