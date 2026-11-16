---
domain: memories
owner: aglowinthefield
status: confirmed
---

## Scope

What happens to a memory after an agent's session ends: extraction, dedupe and supersede, the staleness check, dreaming into concepts, retiring, and how a person sees and corrects all of that in the dashboard. Retrieval (session start, per-prompt search) reads memories but belongs to its own domain once it has one.

## Invariants

What this domain refuses. Each id is written in full as `memories/I1` elsewhere. Ids are permanent; a retired invariant keeps its id out of use.

| Id | Rule | Sources |
|---|---|---|
| I1 | Text is scrubbed for secrets before it is stored, as a memory or as a session transcript. A leaked token in a memory reaches every later session. | [scrub.ts](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/scrub.ts)<br>[sessions.ts](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/sessions.ts)<br>[extract.ts](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/extract.ts) |
| I2 | A person sees only their own memories and the project and team memories of repos they can access. Nothing in this domain shows a memory, or text derived from one, to anyone else. | [access.ts](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/access.ts)<br>[repo-access.ts](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/repo-access.ts) |
| I3 | Automation never deletes a memory row. It retires or supersedes, so the old text stays as history and the change can be undone. Only the author's explicit hard delete removes a row. | [memories.ts](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/memories.ts)<br>[reconcile.ts](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/reconcile.ts) |
| I4 | Superseded memories are history and are never edited. | [memories.ts](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/memories.ts) |
| I5 | Nothing waits on a person. Extraction, the staleness check and dreaming act on their own; a person can correct afterwards but is never a required step. The review queue failed because nobody worked through it. | [No review queue spec](https://github.com/aglowinthefield/impression/pull/74) |
| I6 | Memories are the source of truth. Concepts are derived from them, and a dream run never changes a memory's text or status. | [dream.ts](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/dream.ts) |
| I7 | A session's memories only land in projects the person can access; when the right project is unclear they go to the session's own project, and when it's inaccessible they are dropped. | [extract.ts](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/extract.ts) |
| I8 | Every model call records its operation, tokens and cost. | [usage.ts](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/usage.ts) |
| I9 | Searches a person makes in the dashboard are not logged as serves, so serve counts reflect what agents were given. | [search.ts](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/search.ts) |

## Standing questions

- Can a person see what the automation did to this memory, and undo it?
- Does this change add a step a person has to take for memories to stay right?
- Does it add a model call per memory, per session or per run, and what does that cost at a few thousand memories?

## Cost model

Haiku 5.5 for extraction and staleness checks, Sonnet 5.5 for dreaming (about $0.02 to $0.06 a run). In prod, session extraction is the bulk of the spend; dreaming was $0.32 in its first week. Embeddings are OpenAI at 768 dimensions.

## Key files

- `packages/api/src/extract.ts`: turns a session's transcript into memories.
- `packages/api/src/reconcile.ts`: dedupe and supersede against existing memories.
- `packages/api/src/recheck.ts`: the staleness check's server side, and `memory_events`.
- `packages/cli/src/recheck.ts`: the staleness check's client side, run detached from session start.
- `packages/api/src/dream.ts`, `dream-schedule.ts`: concepts and dream runs.
- `packages/api/src/memories.ts`: the memory routes, retire and edit.
- `packages/web/src/`: the dashboard tabs.

## Recent decisions

The decision log lives in the vault: `Impression/Decisions.md`.

- 2026-11-13: extracted memories go live without review, above a per-user confidence floor.
- 2026-11-14: concepts are per person per project; practices stay out of dreaming.

## How to run things here

`pnpm lint && pnpm typecheck && pnpm test` from the root; API tests start the compose Postgres, so Docker must be running. `pnpm db:dream <project> <owner>` from `packages/api` runs one dream. Dream runs and costs are on https://impression.grafana.net/d/impression-dreams.
