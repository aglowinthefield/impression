---
domain: retrieval
owner: aglowinthefield
status: confirmed
---

## Scope

Which memories reach an agent, and in what form: the session-start set (`GET /core`), search (`POST /search`) for the per-prompt hook and the MCP `search` tool, ranking, similarity floors, budgets and path narrowing, the serve log, and the text the CLI and the pi extension inject. The concept version of session start in `session-start.ts` runs only in its eval so far.

How the hooks and the extension run inside each agent belongs to agents. How memories are made and kept right belongs to memories.

## Invariants

What this domain refuses. Each id is written in full as `retrieval/I1` elsewhere. Ids are permanent; a retired invariant keeps its id out of use.

| Id | Rule | Sources |
|---|---|---|
| I1 | Retrieval returns only memories the person can see. Session start and search both filter through `memoryVisible`; see memories/I2. | [core.ts:81](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/core.ts#L81)<br>[search.ts:67](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/search.ts#L67) |
| I2 | Superseded and retired memories reach an agent only when it asks for that status. Session start serves active memories only. Search serves active and possibly stale ones, and marks a stale one with a warning. | [core.ts:80](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/core.ts#L80)<br>[search.ts:70](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/search.ts#L70)<br>[search.ts:164](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/search.ts#L164) |
| I3 | Injection into a prompt is strict, because a wrong memory costs more than a missed one. Prompt searches raise the similarity floor by 0.1, and a full-text hit must reach 80% of the floor. | [search.ts:19](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/search.ts#L19)<br>[search.ts:117](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/search.ts#L117)<br>[hook.ts:138](https://github.com/aglowinthefield/impression/blob/main/packages/cli/src/hook.ts#L138) |
| I4 | Every memory handed to an agent is logged in `memory_serves` with its source, session and agent, and a failed log write never fails the request. Dashboard searches aren't logged; see memories/I9. | [serves.ts:9](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/serves.ts#L9)<br>[core.ts:106](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/core.ts#L106)<br>[search.ts:170](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/search.ts#L170) |
| I5 | Search still answers when the embedding call fails: it falls back to full text and reports `degraded`. | [search.ts:92](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/search.ts#L92) |
| I6 | The session-start set fits its token budget: 800 by default, 50 to 20,000. It sits in every session's context. Practices take at most a quarter of it while other memories want the room, and only those learned in this project; the rest goes by confidence, then newest. | [core.ts:16](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/core.ts#L16)<br>[core.ts:70](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/core.ts#L70)<br>[core.ts:83](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/core.ts#L83) |
| I7 | A memory narrowed to a path reaches only sessions working in that path or below it. At the repo root, session start leaves path-narrowed memories out. | [core.ts:97](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/core.ts#L97)<br>[search.ts:80](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/search.ts#L80) |

## Proposed invariants

- A memory enters a pi session's context at most once. The extension's `seen` set holds only per-prompt lines ([impression.ts:288](https://github.com/aglowinthefield/impression/blob/main/packages/pi/impression.ts#L288)), not the session-start set ([impression.ts:271](https://github.com/aglowinthefield/impression/blob/main/packages/pi/impression.ts#L271)).
  - Breaks when: a prompt matches a memory that session start already gave. The Claude Code and Codex hooks keep no `seen` set at all, so they repeat a memory on every matching prompt.
  - To confirm: count repeated memories across turns of a few pi session logs with `parseSession` in `packages/shared/src/pi-session.ts`.

## Standing questions

- How much latency does it add before the agent's reply, at a few thousand memories? Every prompt waits on search for up to 2 s (agents/I2).
- Does it raise the memories injected per prompt without raising precision?
- Does it change what the serve log counts?

## Cost model

Search makes one embedding call (OpenAI, 768 dimensions) and no other model call, so each prompt of 15 characters or more costs one embedding. Session start makes no model call.

## Key files

- `packages/api/src/core.ts`: `GET /core`, the session-start set.
- `packages/api/src/search.ts`: `POST /search`, hybrid vector and full-text ranking fused by rank.
- `packages/api/src/serves.ts`: the serve log.
- `packages/api/src/session-start.ts`: the concept map version of session start, used by its eval.
- `packages/cli/src/hook.ts`: builds the session-start and per-prompt text, and the notice the person sees.
- `packages/pi/impression.ts`: per-session dedupe and the in-session count in pi's footer.
- `packages/api/src/eval/`: the retrieval, latency and session-start evals.

## Recent decisions

The decision log lives in the vault: `Impression/Decisions.md`.

- 2026-11-15: the session-start eval compares helpful share over the lines that differ between versions.
- 2026-11-14: concepts reach agents in the session-start payload, each with its top memories, in one response. Not built yet.

## How to run things here

`pnpm lint && pnpm typecheck && pnpm test` from the root; API tests start the compose Postgres, so Docker must be running. From `packages/api`, with `OPENAI_API_KEY` set: `pnpm eval` sweeps the similarity floor for hit@3, MRR and off-topic hits, `pnpm eval:latency [sizes...]` splits per-prompt latency into the embedding call and the database, and `pnpm eval:session-start` compares the concept map against the top-N set.
