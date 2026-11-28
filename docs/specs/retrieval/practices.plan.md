---
issue: https://github.com/aglowinthefield/impression/issues/116
budget_usd: 15
---

## Approach

Split session start's budget: practices get a capped share and only the ones learned in a session in this project, and project facts fill the rest. The serve log already records what session start gave each session, so a prompt search with a session id can skip those memories (AC5) without any agent keeping state.

Practices learned elsewhere don't reach a session through prompt search yet. Adding user-scoped memories to strict prompt search raised off-topic hits per prompt from 0.33 to 0.83 on the realistic-prompt eval, so that waits for a follow-up.

Options it beat:
- Keep practices first and raise the budget: every session pays for every practice, and the problem returns as practices grow.
- Drop practices from session start entirely: practices without a clear trigger in a prompt, like "confirm before queueing a merge", would never reach the agent.
- Rank practices by embedding closeness to the project's facts: needs a threshold to tune and is hard to explain when a practice is missing.

One task: the budget split, the fit rule and the skip are one change to what reaches a session.

## Data model and contracts

- `GET /core`: same request and response. The items change per AC1 and AC2.
- `POST /search`: with a `session`, memories served to that session with source `core` are left out. Otherwise unchanged: with a `project`, it returns that project's memories only.
- The fit rule in AC2 uses data already stored: the session a memory was extracted from. No schema change.
- retrieval/I6 is reworded to: "The session-start set fits its token budget: 800 by default, 50 to 20,000. It sits in every session's context. Practices take at most a quarter of it, and only those learned in this project; the rest goes by confidence, then newest."

## Invariants

- retrieval/I1: holds. Session start and search still filter through `memoryVisible`.
- retrieval/I2: holds. Status filters are unchanged.
- retrieval/I3: holds. The strict floor is unchanged; AC5 only removes results.
- retrieval/I4: holds. What search and session start return is logged as before; AC5 reads that log and doesn't change it.
- retrieval/I5: holds. The full-text fallback applies the same skip.
- retrieval/I6: exception: "practices go first" becomes at most a quarter of the budget for practices learned in this project. The budget rule stands. Approved by the Self on 2026-11-26; the fit rule narrowed on 2026-11-27.
- retrieval/I7: holds. Path narrowing is unchanged.

## Tasks

- [ ] t1: Session start's practice share and fit rule, skipping what session start gave in a prompt search, and I6's new wording in the Persona. Criteria: AC1, AC2, AC5
