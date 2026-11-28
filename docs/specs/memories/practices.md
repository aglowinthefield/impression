---
domain: memories
status: approved
issues:
  - https://github.com/aglowinthefield/impression/issues/116
  - https://github.com/aglowinthefield/impression/issues/119
surfaces:
  - api
---

## Goal

A practice holds only what applies in any of the person's repos, and nothing stored is a to-do. Today extraction can append one repo's details to a cross-repo practice, so every repo gets them, and can keep a chore about the person's machine as a project fact. Memories already stored with these faults get fixed once by the same rules, with no step for the person.

## Non-goals

- No change to which practices reach a session. That is [retrieval/practices](../retrieval/practices.md).
- No change to the practice-or-fact test itself, the confidence floor, or the limits of 3 facts and 2 practices per session.
- No review step. Changes go live, and the person can undo them from Activity.
- No scheduled job and no second pass later. The stored memories are fixed by one run of a script; new memories follow the rules from extraction on.

## Acceptance criteria

- AC1: When a session yields a practice that names one repo's specifics (ports, hosts, service or repo names, paths), extraction stores the practice without them and stores the specifics as a fact in that repo. When the person can't access that repo, the fact is dropped (memories/I7) and the practice is still stored.
- AC2: Extraction stores no to-do: nothing the person or the agent still has to do, fix or update, in this repo, another repo or the person's own machine.
- AC3: On the extraction eval, a case with the `/nitpick` practice and Silk's ports yields a practice without the ports and a fact with them. A case with the `$DEV_VAULT` chore yields nothing. Every existing case still passes.
- AC4: After the release, one run of a script applies AC1 and AC2 to every memory that was active at the release. An agent runs it, dry run first, and the person takes no step. It splits a practice by superseding it with the practice without the specifics plus the new fact, and it retires a to-do.
- AC5: Each change the script makes shows in Activity with the pass as its source and can be undone there. A memory it leaves unchanged gets no Activity entry.
- AC6: Each model call the script makes holds the memories of one owner and one visibility. A second run with the same cutoff changes nothing the first run changed or created. A memory edited while the script runs is left alone. Memories created after the cutoff are never read.
- AC7: Every model call the script makes records its operation, tokens and cost (memories/I8).
- AC8 (after deploy): within a day of the script's run, in prod, `6bdb8a99` (`/nitpick` with Silk's ports) is superseded by a practice without the ports, and `26efcab4` (the `$DEV_VAULT` chore) is retired.

## Setup note

AC1, AC2 and AC4 to AC7 run against the test database in API tests with a fake model. AC3 runs `pnpm eval:extract` from `packages/api` with the extraction model's key set. AC4 in prod is `pnpm db:scope-pass --dry-run` from `packages/api` against prod, read by the agent, then `pnpm db:scope-pass --before <the dry run's cutoff>`. AC8 is a query against prod for the status of the two named memories after that run.

## Surfaces touched

- API

## Cost and scale

AC1 and AC2 change the extraction prompt and add no call per session. The script makes one Haiku call per batch of 20 memories, plus one embedding call per split, in each run: the dry run and the real run, so about twice the calls of one run. Prod held a few hundred active memories in November 2026, so both runs should cost well under $1.
