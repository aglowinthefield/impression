---
issue: https://github.com/aglowinthefield/impression/issues/116
budget_usd: 15
---

## Approach

Split session start's budget: practices get a capped share and only the ones that fit the project, and project facts fill the rest. Practices that don't fit reach a session through prompt search instead, which starts including the person's user-scoped memories when it knows the project. The serve log already records what session start gave each session, so a prompt search with a session id can skip those memories (AC5) without any agent keeping state.

Options it beat:
- Keep practices first and raise the budget: every session pays for every practice, and the problem returns as practices grow.
- Drop practices from session start entirely: practices without a clear trigger in a prompt, like "confirm before queueing a merge", would never reach the agent.
- Rank practices by embedding closeness to the project's facts: needs a threshold to tune and is hard to explain when a practice is missing.

One task: the budget split, the fit rule and search are one change to what reaches a session, and none of them is worth shipping alone.

## Data model and contracts

- `GET /core`: same request and response. The items change per AC1 and AC2.
- `POST /search`: with `project` and no `scope`, user-scoped memories the person owns are included. With a `session`, memories served to that session with source `core` are left out.
- The fit rule in AC2 uses data already stored: the session a memory was extracted from, and the serve log. No schema change.
- `impression search` and the MCP search tool already pass the project, so they pick up AC3 and AC4 without a contract change.
- retrieval/I6 is reworded to: "The session-start set fits its token budget: 800 by default, 50 to 20,000. It sits in every session's context. Practices take a capped share, only those that fit the project; the rest goes by confidence, then newest."

## Invariants

- retrieval/I1: holds. User-scoped memories join search through the same `memoryVisible` filter, which already limits them to their owner.
- retrieval/I2: holds. Status filters are unchanged.
- retrieval/I3: holds. User-scoped memories pass the same strict floor; AC7 checks precision.
- retrieval/I4: holds. AC6.
- retrieval/I5: holds. The full-text fallback sees the same widened candidate set.
- retrieval/I6: exception: "practices go first" becomes a capped share for practices that fit the project. The budget rule stands. Approved by the Self on 2026-11-26.
- retrieval/I7: holds. Path narrowing applies to user-scoped memories as before; they carry no path.

## Tasks

- [ ] t1: Session start's practice share and fit rule, user-scoped memories in project searches, skipping what session start gave, the eval fixture, and I6's new wording in the Persona. Criteria: AC1, AC2, AC3, AC4, AC5, AC6, AC7
