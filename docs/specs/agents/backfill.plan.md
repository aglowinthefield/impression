---
issue: https://github.com/aglowinthefield/impression/issues/106
budget_usd: 30
---

## Approach

Backfill becomes a published CLI command built from the seed script's discovery and chunking, and the seed script goes: a local dev server is seeded with `impression backfill`, with the server's backfill model set to whatever the developer wants. The server decides everything that costs money (model, price, budget), so a client can't pick Sonnet or skip the budget, and the estimate uses the same price table that records the spend.

Dedupe moves to the server: each backfill piece is stored with a hash of its scrubbed text, unique per owner and project, so "no piece twice" holds across reruns, crashes and two runs at once without client state. The client asks the server for a plan (which pieces are new, already done, or already uploaded live, plus the estimate and budget left), then sends only the new ones.

Old memories are anchored at the commit that was current when their session started, so the existing staleness check catches the ones the code has since moved past. No extra model calls at backfill time.

Setup starts the backfill as a detached process, the same hand-off the pi extension uses at shutdown, because a default run takes 10 to 25 minutes. Progress goes to a small file that `impression status` reads.

Options it beat:
- A server-side queue and worker: a new moving part for a one-off job per person; synchronous requests at three at a time are enough.
- Client-side dedupe state: lost with the config folder, and can't stop two machines backfilling the same repo twice.
- Running backfill extraction on the live model and offering Sonnet as an option: the Self chose Sonnet, and a per-run choice is a knob nobody needs.
- Rechecking every backfilled memory against HEAD at once: a model call per memory up front; anchoring at the old commit gets the same effect through the staleness check as files are touched.

The server half also stands on the memories Persona. Its rules hold: pieces are scrubbed before storage and extraction (memories/I1, AC16), undo retires and leaves superseded memories alone (memories/I3, memories/I4), backfilled memories go live without review (memories/I5), and every backfill call records its operation, tokens and cost (memories/I8, AC17).

Why two tasks: t1 (server) can merge and deploy alone, since no client sends backfill pieces until t2 ships, and its migration and budget check are worth reviewing on their own. t2 needs t1's endpoints.

## Data model and contracts

`sessions` (migration):
- `source text not null default 'hook'`, one of `hook`, `backfill`.
- `piece_hash text`: `pieceHash` from `packages/shared` (sha256 of the trimmed piece text as the server receives it), computed by the server at upload and set for backfill pieces. Unique index on `(owner, project_id, piece_hash)` where `source = 'backfill'`. t2's CLI hashes each piece with the same helper for the plan request. Changed in t1 from "sha256 of the scrubbed transcript": the scrubber lives only in the API, so the CLI couldn't compute that hash, and a scrubber change would make old hashes miss and bill pieces again. Only the hash of the raw text is stored, never the raw text.
- `started_at timestamptz`: when the backfilled session started.
- `extracting_at timestamptz`: a claim on the piece's extraction, so two requests can't both run the model on it. A claim older than 15 minutes (longer than an extract request can take) is abandoned and can be taken over. A request finishing or failing sets `extracted_at` or clears `extracting_at` only while `extracting_at` still equals the claim it took, so a request whose claim expired can't mark the piece extracted or drop its replacement's claim. Added in t1: holding a row lock across the model call instead would tie up a pooled connection per piece in flight.
- `extracted_at timestamptz`: set when extraction finishes, so a piece stored but not extracted (a failed or interrupted run) is sent to extraction again.

Server settings: `BACKFILL_MODEL` (default `claude-sonnet-5-5`), `BACKFILL_BUDGET_USD` (default 10). The server refuses to start when `BACKFILL_MODEL` has no price in `usage.ts` (Ollama models count as free), since its spend would read as $0. Added in t1. Spend is the sum of the person's `usage_events` with operation `backfill`.

`POST /backfill/plan` body `{ project, pieces: [{ sessionKey, hash, chars }] }` (`project` is the key, or `{ key }`; `sessionKey` is optional) returns `{ pieces: [{ hash, status: "new" | "done" | "live" }], estimateUsd, budgetUsd, spentUsd, model }`. `live` means the hooks already uploaded a session with that `sessionKey` for this owner. The estimate prices the new pieces' characters at about 4 per token plus the extraction prompt, at the backfill model's prices, plus 2,000 output tokens each.

`POST /sessions` accepts `source: "backfill"`, `startedAt` and `commitSha`. A backfill piece whose hash exists returns the existing row with `duplicate: true` and `extracted` (whether `extracted_at` is set). No one-day window for backfill.

`POST /sessions/:id/extract` on a backfill session: refuses with 402 `{ error: "backfill budget used up", spentUsd, budgetUsd }` when spend has reached the budget; otherwise extracts with `BACKFILL_MODEL`, records usage as `backfill`, sets `extracted_at`, and returns `{ saved, updated, costUsd }`: `saved` new memories, `updated` existing ones it superseded or merged into, read from the session's memory events. A piece already extracted returns its earlier counts without a model call, as `{ saved, updated, costUsd: 0, alreadyExtracted: true }`. While another request is extracting the piece it returns 409 `{ error: "piece is being extracted" }` without a model call; the client counts the piece as not sent, and the next run's plan shows it done. A request whose claim expired and was taken over before its model call returned gets the same 409 and leaves the piece to the new claim (added in t1). Up to three pieces in flight can pass the check together, so spend can exceed the budget by at most three pieces (about $0.15).

`POST /backfill/undo?project=<key>` retires the caller's live memories whose session has `source = 'backfill'` in that project, with a `memory_events` row each, and returns `{ retired }`. Superseded memories are left as they are. A project the caller can't see, or that doesn't exist, gets 404 `{ error: "project not found" }`, as the other project routes answer (changed in t1 from `{ retired: 0 }` for an unknown project, so someone who lost repo access can't retire memories others there see).

CLI:
- `impression backfill [--repo <path>] [--since <date>] [--limit <n>] [--agents pi,claude,codex] [--yes] [--dry-run] [--undo]`. Discovery and chunking come from the seed script, which is deleted along with its `seed` package script and its README section (replaced by one for backfill).
- Sessions whose file changed in the last hour are skipped.
- Each piece's `commitSha` is `git rev-list -1 --before=<session start> HEAD`, or the repo's first commit when the session predates it.
- Lock: `~/.config/impression/backfill/<project hash>.lock` holding the pid; a lock whose pid is gone is taken over.
- Progress: `~/.config/impression/backfill/<project hash>.json` with `{ total, done, saved, updated, failed, notSent, costUsd, startedAt, finishedAt }`, written after each piece; `impression status` prints it for the current repo while unfinished and once after it finishes.
- Retry: one retry on a 5xx or timeout; a 402 stops the run.
- Setup: after the existing steps, if signed in, interactive, and the cwd is in a git repo with new pieces, it shows the plan and asks; on yes it hands off `impression backfill --yes` detached and exits.

## Invariants

- agents/I1: holds. A failed discovery, plan or upload in setup prints one line and setup finishes; backfill is never run from a hook, so no agent session sees it.
- agents/I2: holds. Nothing is added to the prompt path.
- agents/I3: holds. Setup's backfill runs detached and outlives setup. Running sessions are skipped (changed in the last hour), so no transcript is read while an agent appends to it.
- agents/I4: holds. Backfill is a CLI command, not a hook, and acts in no agent.
- agents/I5: holds. Setup starts the backfill with the bundled CLI and node, as the other hand-offs do.
- agents/I6: holds. The project key comes from the repo the same way the hooks resolve it, so worktree and subdirectory sessions land in one project.
- agents/I7: holds. Not signed in, `impression backfill` says so and exits; setup offers backfill only after sign-in.
- agents/I8: holds. The offer changes no agent config.

## Tasks

- [ ] t1: Server side of backfill. Migration on `sessions`; `POST /backfill/plan` with the estimate and budget; backfill upload with permanent dedupe; backfill extraction on `BACKFILL_MODEL` with the budget check, usage operation and `extracted_at`; `POST /backfill/undo`; API tests for each, including two extractions of one piece at once and a budget reached mid-run. Criteria: AC5, AC6, AC7, AC8, AC14, AC16, AC17
- [ ] t2: `impression backfill`, setup's offer, and backfill progress in `impression status`. Moves discovery and chunking out of the seed script and deletes it; commit at session start; lock; progress file; retry; undo; CLI tests with fixture transcript folders and a stubbed API. after: t1. Criteria: AC1, AC2, AC3, AC4, AC6, AC9, AC10, AC11, AC12, AC13, AC14, AC15
