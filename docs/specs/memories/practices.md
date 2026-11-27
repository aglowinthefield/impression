---
domain: memories
status: draft
issues:
  - https://github.com/aglowinthefield/impression/issues/116
  - https://github.com/aglowinthefield/impression/issues/119
surfaces:
  - api
---

## Goal

A practice holds only what applies in any of the person's repos, and nothing stored is a to-do. Today extraction can append one repo's details to a cross-repo practice, so every repo gets them, and can keep a chore about the person's machine as a project fact. Memories already stored with these faults get fixed by the same rules, with no step for the person.

## Non-goals

- No change to which practices reach a session. That is [retrieval/practices](../retrieval/practices.md).
- No change to the practice-or-fact test itself, the confidence floor, or the limits of 3 facts and 2 practices per session.
- No review step. Changes go live, and the person can undo them from Activity.
- No second pass later. New memories follow the rules from extraction on.

## Acceptance criteria

- AC1: When a session yields a practice that names one repo's specifics (ports, hosts, service or repo names, paths), extraction stores the practice without them and stores the specifics as a fact in that repo. When the person can't access that repo, the fact is dropped (memories/I7) and the practice is still stored.
- AC2: Extraction stores no to-do: nothing the person or the agent still has to do, fix or update, in this repo, another repo or the person's own machine.
- AC3: On the extraction eval, a case with the `/nitpick` practice and Silk's ports yields a practice without the ports and a fact with them. A case with the `$DEV_VAULT` chore yields nothing. Every existing case still passes.
- AC4: After the release, one pass applies AC1 and AC2 to every memory that was active at the release, with no step for the person. It splits a practice by superseding it with the practice without the specifics plus the new fact, and it retires a to-do.
- AC5: Each change the pass makes shows in Activity with the pass as its source and can be undone there. A memory the pass leaves unchanged gets no Activity entry.
- AC6: The pass checks each memory at most once. A second start changes nothing already checked. After a crash midway, the next start picks up only the memories not yet checked. A memory created after the release is never checked. A memory retired, superseded or edited by the person before the pass reaches it is skipped.
- AC7: Every model call the pass makes records its operation, tokens and cost (memories/I8).
- AC8 (after deploy): within a day of the release, the pass has checked every memory that was active at the release. In prod, `6bdb8a99` (`/nitpick` with Silk's ports) is superseded by a practice without the ports, and `26efcab4` (the `$DEV_VAULT` chore) is retired.

## Setup note

AC1, AC2 and AC4 to AC7 run against the test database in API tests with a fake model. AC3 runs `pnpm eval:extract` from `packages/api` with the extraction model's key set. AC8 is two queries against prod a day after the deploy: memories active at the release with no check mark, and the status of the two named memories.

## Surfaces touched

- API

## Cost and scale

AC1 and AC2 change the extraction prompt and add no call per session. The pass makes one Haiku call per batch of memories, once. Prod held a few hundred active memories in November 2026, so the pass should cost well under $1.
