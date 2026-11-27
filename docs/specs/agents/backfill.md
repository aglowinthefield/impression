---
domain: agents
status: draft
issues:
  - https://github.com/aglowinthefield/impression/issues/106
surfaces:
  - cli
  - api
---

## Goal

A new user's first sessions get no memories, because Impression only learns from sessions that end after it is installed. Backfill extracts memories from the repo's past pi, Claude Code and Codex sessions, so the agent knows the repo on day one. It shows what it will send and what it will cost before it sends anything, and stays inside a per-person budget, because extracting history runs on a stronger model than live extraction does.

## Non-goals

- Backfilling every repo on the machine in one run. A run covers one repo: the one it is run in, or the one named.
- Agents other than pi, Claude Code and Codex. oh-my-pi sessions are left out until their transcript format is read anywhere else.
- Checking old memories against today's code beyond what the staleness check already does.
- Choosing the model per person. The backfill model is one server setting.
- A queue on the server. The client sends pieces and waits for each, as the hooks do.

## Acceptance criteria

- AC1: `impression backfill`, run in a git repo, lists that repo's past sessions per agent (pi, Claude Code, Codex), including sessions run in its subdirectories and worktrees, and prints the session count, the piece count and an estimated cost in dollars before it sends anything.
- AC2: By default a run takes the sessions that started in the last 30 days, at most 50, newest kept when there are more. `--since <date>` and `--limit <n>` change the window.
- AC3: Nothing is sent until the person confirms. Without a terminal, a run sends only with `--yes`; `--dry-run` prints the plan and sends nothing.
- AC4: Pieces are sent oldest first, so a later session's memory supersedes an earlier contradicting one.
- AC5: Backfill extraction uses the server's backfill model, Sonnet unless the server sets another. Live extraction from the hooks keeps its own model.
- AC6: A session the hooks already uploaded is skipped, so is a session changed in the last hour (it may still be running), and so is a piece a backfill already extracted, however long ago. A rerun after a finished run sends nothing and prints that there is nothing new.
- AC7: Each person has a backfill budget of [NEEDS CLARIFICATION: dollars per person] dollars on a server, set by the server. The plan shows what is left of it. A run whose estimate exceeds what is left sends only the oldest pieces that fit, and says how many it left out.
  > **Open:** what should a person's backfill budget be on impression.quest, which you pay for? Lifetime, per person, across repos. Self-hosted servers set their own.
- AC8: When the budget runs out mid-run, the server refuses further backfill extraction for that person, the run stops after the pieces already in flight, and it prints how many pieces were not sent. No piece is extracted twice.
- AC9: The run prints one line per piece and ends with the sessions read, memories saved and updated, and the actual cost, taken from what the server recorded.
- AC10: A run stopped midway (Ctrl-C, a crash, a closed terminal) leaves every finished piece extracted, and the next run sends only the rest.
- AC11: A second backfill for the same repo, started while one is running, refuses and says one is already running.
- AC12: A piece the server fails on is retried once; if it fails again the run carries on, reports it as failed at the end, and the next run sends it again.
- AC13: A memory from a backfilled session is anchored at the last commit on the repo's current branch before that session started, not at today's HEAD, so the staleness check rechecks it when its files have changed since.
- AC14: Memories from a backfill are marked as such and link to the session they came from. `impression backfill --undo` retires every memory a backfill made in the repo that is still live, and prints how many. Retired memories stay as history.
- AC15: `impression setup`, run in a git repo with past sessions, ends by offering the backfill with the same plan and estimate. Accepting it starts the backfill in the background and setup exits; `impression status` then shows its progress (pieces done of total, memories saved) until it finishes. Outside a repo, or without a terminal, setup skips the offer and prints the `impression backfill` command.
- AC16: Transcripts are scrubbed of secrets before they are stored or extracted, as live sessions are.
- AC17: Every backfill extraction call records its operation as backfill, with its tokens and cost, so a person's backfill spend can be summed.

## Setup note

A machine with past sessions for one repo under `~/.pi/agent/sessions`, `~/.claude/projects` and `~/.codex/sessions` (the transcript folders can be pointed elsewhere for tests), a local API with an Anthropic key, and a budget small enough to hit in a test run (AC7, AC8). AC13 needs a repo with commits on both sides of a session's start time.

## Surfaces touched

- CLI: `impression backfill`, `impression setup`, `impression status`
- API: session upload and extraction, usage records, memory retire

## Cost and scale

Each piece is up to about 60,000 characters of conversation, about 15,000 to 16,000 input tokens plus up to 2,000 output. On Sonnet 5.5 ($2 and $10 per million tokens) that is about $0.03 to $0.05 a piece, against about $0.003 on Haiku 5.5, before the dedupe and supersede calls that follow. The default window of 50 sessions is about 50 to 150 pieces: roughly $2 to $7 a person. Extraction runs synchronously per request; at three pieces at a time a full default run takes about 10 to 25 minutes, which is why setup runs it in the background. Storage is one session row per backfilled session, as a live session has.
