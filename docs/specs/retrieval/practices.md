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

A practice reaches a session at start when it was learned in that project, and a project's facts keep their place at session start. Today session start puts every practice first, so practices learned in other repos fill the budget before the project's own facts. One person's user-scoped memories already total about 1,060 tokens against an 800-token budget. A prompt search also repeats memories session start already gave the same session.

## Non-goals

- No change to what extraction makes a practice. That is [memories/practices](../memories/practices.md).
- No change to the default budget or its 50 to 20,000 range.
- No model call at session start or in search.
- No per-person setting for how many practices to show.
- No change to the concept version of session start, which runs only in its eval.
- No practices in prompt search. That is a follow-up: adding user-scoped memories to strict prompt search raised off-topic hits per prompt from 0.33 to 0.83 on the realistic-prompt eval.

## Acceptance criteria

- AC1: Practices take at most 25% of the session-start budget. Memories that aren't practices fill the rest first. Practices may use room the rest leaves unused.
- AC2: Session start serves only the practices that were learned in a session in this project.
- AC5: A prompt search that carries a session id leaves out memories that session start already gave to that session.

## Setup note

AC1, AC2 and AC5 run against the test database in API tests.

## Surfaces touched

- API
- CLI hooks and the pi extension, which show what `GET /core` and `POST /search` return, with no change of their own

## Cost and scale

No model calls. AC2 adds one indexed lookup of each practice's session at session start. AC5 adds one indexed lookup of the session's serves per prompt search.
