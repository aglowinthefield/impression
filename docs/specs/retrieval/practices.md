---
domain: retrieval
status: approved
issues:
  - https://github.com/aglowinthefield/impression/issues/116
surfaces:
  - api
  - cli
  - pi
---

## Goal

A practice reaches a session when it applies there, and a project's facts keep their place at session start. Today session start puts every practice first, so practices learned in other repos fill the budget before the project's own facts. One person's user-scoped memories already total about 1,060 tokens against an 800-token budget. Prompt search, which could bring a practice in when its trigger comes up, never returns a user-scoped memory once it knows the project.

## Non-goals

- No change to what extraction makes a practice. That is [memories/practices](../memories/practices.md).
- No change to the default budget or its 50 to 20,000 range.
- No model call at session start or in search.
- No per-person setting for how many practices to show.
- No change to the concept version of session start, which runs only in its eval.

## Acceptance criteria

- AC1: Practices take at most 25% of the session-start budget. Memories that aren't practices fill the rest first. Practices may use room the rest leaves unused.
- AC2: Session start serves only the practices that were learned in a session in this project, or that a prompt search in this project returned before.
- AC3: A strict prompt search that names a project also returns the person's user-scoped memories. They pass the same similarity floor as project memories (retrieval/I3) and are ranked together with them. A search with `scope: "project"` still returns project memories only.
- AC4: The MCP search tool, given a project, returns the person's user-scoped memories the same way.
- AC5: A prompt search that carries a session id leaves out memories that session start already gave to that session.
- AC6: A practice that a prompt search returns is logged in the serve log with source `prompt`, its session and its agent, like a project memory.
- AC7: On the realistic-prompt eval, with user-scoped memories added to its fixture, off-topic hits per prompt rise by at most 0.1 and hit@3 doesn't fall.
- AC8 (after deploy): within seven days of the release, the prod serve log holds at least one practice served with source `prompt`.

## Setup note

AC1 to AC6 run against the test database in API and CLI tests. AC7 runs `pnpm eval` from `packages/api` with `OPENAI_API_KEY` set. AC8 is one query against prod seven days after the deploy: serves with source `prompt` joined to memories tagged `practice`.

## Surfaces touched

- API
- CLI hooks
- pi extension

## Cost and scale

No model calls. Prompt search already embeds the prompt; including user-scoped memories widens the candidate set by the person's practices (11 today). AC5 adds one indexed lookup of the session's serves per prompt search.
