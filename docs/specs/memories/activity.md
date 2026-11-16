---
domain: memories
status: draft
issues:
  - https://github.com/aglowinthefield/impression/issues/89
surfaces:
  - web
  - api
---

## Goal

Memories change without anyone reviewing them. Extraction adds, merges and supersedes them, the staleness check keeps, rewrites or retires them, and dreaming regroups them. A person who finds a wrong or missing memory has nowhere to see what happened to it, and only a retire to put it right. The Activity tab is one log of what happened to a person's memories and why, newest first, with undo on every change that can be undone. It replaces the Review and Evals tabs, both of which depended on a person keeping up.

## Non-goals

- No history before launch. Changes made before the page ships aren't listed; extraction runs daily, so the log fills within days.
- No undo for dream runs. Concepts are derived from memories and the next run regroups; a run is listed so it can be seen, not reversed.
- No used or contradicted signals per memory. They need extraction to judge what each session did with the memories it was served, which is its own spec.
- No editing from Activity. Editing a memory stays on the Memories tab.
- No notifications or digests.

## Acceptance criteria

- AC1: The dashboard has an Activity tab and no Review or Evals tabs. An old `/review` or `/evals` link opens Activity for the same project.
- AC2: Activity lists one entry per change to a memory the viewer can see, newest first, 50 at a time with a control to load the next 50. It shows the selected project's memories and the viewer's own user-scoped memories.
- AC3: Each of these changes adds an entry: a memory extracted from a session; an extracted memory merged into an existing one (the existing text changed); an extracted memory superseding older ones; the staleness check keeping, rewriting or retiring a memory; a person retiring or editing a memory; an undo. No change to a memory's text or status leaves it without an entry.
- AC4: Each dream run of the viewer's in the selected project adds one entry, with the number of concepts created, kept and removed and the memories left uncategorized.
- AC5: Every entry shows when it happened, what happened, the memory's text, and why: the session it came from (with its agent), the staleness check's reason, or the person who acted. A merge or rewrite shows the text before and after.
- AC6: Undo puts the memory back as it was before the change:
  - an extraction: the new memory is retired, and any memories it superseded are active again;
  - a merge: the existing memory's text is back to its text before the merge;
  - a rewrite by the staleness check, or a supersede: the older memory is active again and the newer one is retired;
  - a retire, by the check or a person: the memory is active again.
  A keep, a dream run and an undo have no undo.
- AC7: After an undo the entry is marked undone and offers no second undo. The undo appears as its own entry.
- AC8: Undo is refused, with a message saying the memory changed since, when the memory has a later entry that isn't undone.
- AC9: Undo is offered to [NEEDS CLARIFICATION: who can undo?] and to no one else. Others see the entry without it.
  > **Open:** today only a memory's author can retire it. Should undo on a project or team memory also be author-only, or open to anyone with access to the repo?
- AC10: A filter narrows the list to one source: extraction, staleness check, dreaming, or people.
- AC11: Above the list, the last four weeks each show the memories added, rewritten or superseded, and retired in the selected project, and the retire rate (retired over added) as a percentage.
- AC12: An entry never reveals a memory, or its text before a change, to a viewer who can't see that memory now. Dream run entries appear only for the viewer's own runs.
- AC13: The hand-rating eval tool from the Evals tab is reachable from Debug and works as before.
- AC14: A memory flagged as possibly stale [NEEDS CLARIFICATION: where it shows].
  > **Open:** the Review tab listed flagged memories with Still true, Update and Retire. With Review gone, should flagged memories show as a filter on the Memories tab, as a pinned group at the top of Activity, or nowhere special now that the staleness check decides on its own?
- AC15 (after deploy): within 7 days of the release, Activity in prod lists at least one extraction entry and one dream run entry, and the four-week summary shows a retire rate. Check by opening Activity for `aglowinthefield/impression`.

## Setup note

AC1 to AC14 run against the test database in API and web tests, plus a local dev server for a look by eye; the local `impression_dream` database (seeded from old transcripts) has enough memories and dream runs to fill the page. AC15 needs prod and the dashboard signed in as `aglowinthefield`, a week after deploy. The staleness check entries only appear in prod once #90 (pi never runs the check) is fixed.

## Surfaces touched

- Web dashboard
- API

## Cost and scale

No model calls. One stored entry per change: in prod about 30 to 300 extracted memories a week plus a few dream runs a day, so a few hundred entries a week per active person. Undo touches at most a handful of memories per call.
