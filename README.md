# impression 💭₊˚⊹♡

Memory for development work: a self-hostable, mem0-style service that keeps project context
(conventions, decisions, gotchas, commands) and improves it over time. Built for one developer
or a small team, not for consumer-facing agents.

## Quick start

1. Start the server and create a token: see [Run with Docker](#run-with-docker). Without Docker, see [Develop](#develop).
2. Install the CLI: `npm i -g @aglowinthefield/impression`, for `impression login`, `status` and the review commands. Update later with `impression update`.
3. Sign in: `impression login --github --url http://localhost:3000` (or `--token imp_...`).
4. Install the plugin for each agent (below), then open http://localhost:3000 to review memories.

## Wire it into your agent

Each agent installs Impression with its own plugin command, and updates and removes it the same way. The plugins run the CLI and MCP server bundled in the npm package with `node` from your PATH, so they don't need the global install. Run `impression login` first: the plugins read the saved sign-in, so no token goes in agent config.

`impression setup` finds Claude Code, pi and Codex, prints the install commands below, adds the pi package, and removes the hooks and MCP entries earlier versions of setup wrote, so nothing runs twice. It backs up each file it changes (`<file>.impression-backup-<timestamp>`) and is safe to rerun. `--dry-run` prints the changes without writing them; `--only claude|pi|codex` limits it to one.

Every client reads `IMPRESSION_URL` (default `https://impression.quest`) and `IMPRESSION_TOKEN`, and falls back to the file `impression login` writes.

### Claude Code

```sh
claude plugin marketplace add aglowinthefield/impression
claude plugin install impression@impression
```

The plugin adds the MCP tools (`search`, `add`) and three hooks: session start injects your core memories, each prompt adds memories that match it, and session end sends the transcript, and extraction turns it into memories. Update with `claude plugin update impression@impression`, or turn on auto-update for the marketplace in `/plugin`.

### Codex

```sh
codex plugin marketplace add aglowinthefield/impression
codex plugin add impression@impression
```

The same MCP tools and hooks as Claude Code. Codex runs a plugin's hooks only after you trust them in `/hooks`, and asks again after each update. Update with `codex plugin marketplace upgrade impression`.

### pi

```sh
pi install npm:@aglowinthefield/impression
```

pi installs and updates the package itself (`pi update --extensions`), so it doesn't need the global install. The package's extension adds the MCP tools (search and add) and runs `impression hook session-start` on session start, `hook prompt` (a search on the prompt text) before each prompt, and `hook session-end --extract` on each chunk of new conversation (after a run, once about 3000 characters have built up, and again on exit). Run `impression login` first. `impression setup` adds the same package entry to `~/.pi/agent/settings.json`, and removes the extension path and `impression` MCP entry that earlier versions of setup wrote.

## Troubleshooting

- **401 invalid token:** the token was mistyped or minted against another database. Mint a new one with `token:create`.
- **Search returns nothing or `degraded: true`:** the embedding call failed (check `OPENAI_API_KEY`). Keyword search still works. Memories saved while embeddings were down have no vector until their text is edited.
- **Extraction returns 502:** the LLM call failed (check `ANTHROPIC_API_KEY`). Nothing was stored; run extract again.
- **Hook prints nothing:** by design, hooks never fail loudly. Run the command by hand to see whether `impression status` works.

## Design decisions

- **Capture:** explicit adds, plus session-end LLM extraction. Extracted memories are deduped and stored right away. Each person sets a confidence floor in Settings (default 0.7), and extraction drops anything below it. The floor belongs to the principal, so a break-glass `token:create` token minted under another name has its own floor.
- **Scopes:** user, project, team. A project is keyed by normalized git remote URL, falling back to root path. Memories can be narrowed to paths.
- **Retrieval:** a small curated core is injected at session start. The rest is reached through a `search` tool. Per-prompt injection is optional per project.
- **Staleness:** memories carry anchors (paths, symbols, commit SHA). When an anchored file changes, a model rechecks the memory against the current code and keeps, rewrites or retires it, with no one reviewing. Contradictions supersede the old memory, which is kept as history.
- **Storage:** Postgres with pgvector.
- **Integration:** one HTTP API server owns storage, extraction and anchor checks. MCP server, CLI, hooks and a web UI are clients.
- **Models:** pluggable providers. Defaults are OpenAI `text-embedding-3-small` (at 768 dimensions) and a Haiku-class extractor. Ollama is configurable; `nomic-embed-text` answers in about 10ms locally. The embedding model and dimension are stored per memory.
- **Team (after v1):** per-person tokens, member and admin roles, explicit promotion to team scope, provenance, and a secret and PII scrubber.

## v1

Personal-first slice with a web UI. See the milestones and issues on GitHub.
Out of v1: team scope, roles and approval, per-prompt injection, extra local providers.

## Stack

TypeScript monorepo (pnpm workspaces, Node 22+). Packages: `shared`, `api`, `cli`, `mcp`, `web`.

- HTTP: Hono. Chosen for a small, typed API that is easy to test with `app.request()`.
- Postgres access: Drizzle ORM with `postgres`. Chosen for SQL-close typed queries and pgvector support.
- Tests: Vitest. Lint and format: Biome.
- Compiler: [`tsrs`](https://github.com/oxc-project/tsrs), the Rust port of the TypeScript 7 compiler. Packages call `tsrs` for `build` and `typecheck` (pre-1.0, pinned in `package.json`).
- Task runner: Turborepo. Root scripts run `turbo run <task>`, so every package defines its own `build`, `typecheck`, `test` and `lint`, and results are cached.

## Configuration

| Variable                             | Default                                      | Notes                                                                                 |
| ------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`                       | local compose Postgres                       |                                                                                       |
| `PORT`                               | `3000`                                       |                                                                                       |
| `EMBEDDING_PROVIDER`                 | `openai`                                     | or `ollama`. Needs `OPENAI_API_KEY` for openai.                                       |
| `LLM_PROVIDER`                       | `anthropic`                                  | or `ollama`. Needs `ANTHROPIC_API_KEY` for anthropic.                                 |
| `EMBEDDING_MODEL`, `LLM_MODEL`       | `text-embedding-3-small`, `claude-haiku-4-5` | Required for ollama.                                                                  |
| `EMBEDDING_DIMENSIONS`, `OLLAMA_URL` |                                              | Ollama only. The dimension must be 768 to match the column.                           |
| `EMBEDDING_MIN_SIMILARITY`           | `0.3` openai, `0.45` ollama                  | Search floor. Cosine scores differ between models, so retune with the eval.           |

## Develop

Needs Postgres with pgvector. `docker compose up -d --wait` starts one on port 54329 (see `.env.example`), then apply the schema:

```
pnpm --filter @impression/api db:migrate
```

Create an API token (shown once, stored hashed), then start the API:

```
pnpm --filter @impression/api token:create <your-name>
pnpm dev   # api on :3000; /health is open, /api/* needs `Authorization: Bearer <token>`
```

Search: `POST /api/search` with `{ query, scope?, project?, path?, status?, limit?, minSimilarity? }`.

Tests create and drop their own database on that server. After editing `packages/api/src/db/schema.ts`, run `pnpm --filter @impression/api db:generate` and commit the new file in `packages/api/drizzle`.

```
corepack enable
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm dev   # api on :3000, GET /health
```

`pnpm test` needs Docker running: the API tests start the compose `postgres` service themselves if nothing answers on port 54329. Set `DATABASE_URL` to use another Postgres.

## Retrieval eval

`pnpm --filter @impression/api eval` runs a small fixture (14 memories, 18 queries, 5 off-topic queries, 15 memory pairs) against the configured embedding model and prints hit@3, MRR and off-topic results per `minSimilarity`, plus pair similarities for dedup. It calls the real embeddings API, so it costs a little. CI runs the same fixture with a fake embedder to catch ranking regressions.

With `nomic-embed-text` (768 dimensions), hit@3 is 1.00 and MRR 0.94. Off-topic queries return nothing from a 0.45 floor, which is its default. Paraphrases scored 0.76 to 0.91 and unrelated pairs 0.37 to 0.45, so the 0.4 dedup candidate floor lets some unrelated pairs through to the LLM check. That costs extra calls, not wrong merges.

With `text-embedding-3-small` at 768 dimensions, hit@3 is 1.00 and MRR 0.92 (the same as at 1536). The 0.25 search floor gave the best MRR (0.92), hit@3 1.00 and no off-topic results. Paraphrases scored 0.68 to 0.85, one conflicting pair scored 0.49 and unrelated pairs at most 0.14, so the dedup candidate floor is 0.4.

## Memory quality evals

Rating happens in the web UI's **Evals** tab. Fill it from your pi session logs:

```
impression eval push [path-substring]
```

This uploads every prompt from `~/.pi/agent/sessions` with the memories that were injected for it (scrubbed, and visible only to your token). Run it again any time. Ratings you've given stay.

- **Sessions:** each prompt with its injected memories. Mark each one Useful, Irrelevant or Wrong. A Wrong rating offers to retire the memory.
- **Memories:** per active memory, how often it was injected and how you rated it, plus the ones never injected. Often injected and often irrelevant means reword or retire.
- **Extraction:** what the extractor wrote, with the share you judged good. Mark each Good or Junk. For junk, "Copy eval case" puts a case for `packages/api/src/eval/extraction-fixture.ts` on your clipboard, built from the source transcript.

Terminal checks, none of which run in CI because they need a real model or your logs:

- `pnpm --filter @impression/api eval` ranks search results and shows where the similarity floors should sit.
- `pnpm --filter @impression/api eval:extract` runs the extraction prompt over the fixture transcripts and fails if it keeps assistant suggestions, status updates or chatter, or misses a decision. It uses `LLM_PROVIDER`.
- `pnpm --filter @impression/api eval:sessions [project] [--turns]` prints the injection rate and the most and least injected memories without the server's ratings.

## MCP server

`packages/mcp` is a stdio MCP server with two tools, `search` and `add`. It resolves the project from the working directory and talks to the API over HTTP. Setup is under [Wire it into your agent](#wire-it-into-your-agent).

## Session-start hook

`GET /api/core` returns a small set per project: pinned first, then by confidence and recency, within a token budget (`budget`, default 800). Flagged-stale and superseded memories are left out. `impression hook session-start` (from `packages/cli`) prints it in the shape the agent named by `--agent` reads (`claude`, `codex`, `gemini`, `cursor`, `copilot`, or `pi` for plain text). A hook without `--agent` or running inside a different agent prints nothing, so a hook never runs twice. It exits 0 and prints nothing if the API is down. Setup is under [Wire it into your agent](#wire-it-into-your-agent).

After printing, the hook starts a detached staleness check, at most once an hour per project (timestamps under `~/.config/impression/recheck/`). It runs the anchor check on your anchored memories in the checkout, and for each one whose file changed or lost its symbol it posts the files as committed at HEAD, and the HEAD SHA, to `POST /api/memories/:id/recheck`, up to 20 per run. A memory with an anchored file that has uncommitted changes waits until they are committed, and symlinks are never sent. The server asks the model whether the memory still holds: kept moves its anchors to HEAD, rewritten replaces it with a new memory (the old one is superseded), retired retires it. File contents go to the model marked as data, and it only rewrites or retires when the code contradicts the memory. A failed check changes nothing, and a check that races an edit or another check returns 409. Each outcome is recorded in `memory_events`, with what undo needs. Only the anchors this checkout verified move; the rest, such as one at a commit it doesn't have, stay as they were. The model sees at most 40,000 characters of file text per memory.

## Session-end hook

`impression hook session-end --agent <agent>` reads the agent's session-end JSON from stdin, copies the transcript and returns at once, leaving a detached process to flatten it to user and assistant text and post it to `/api/sessions` with the project key and HEAD SHA. Add `--extract` to also extract memories from it. It reads Claude Code, Codex, pi, Cursor, Gemini CLI and Copilot CLI transcripts. The server keeps one copy of a chunk sent twice. It always exits 0, prints nothing on failure, and the upload gives up after two minutes. Setup is under [Wire it into your agent](#wire-it-into-your-agent).

## CLI

`npm i -g @aglowinthefield/impression` installs the `impression` binary. From a checkout, `pnpm build` produces `packages/cli/dist/bin.js` and the bundled package in `packages/impression/dist`. Create a token on the server with `pnpm --filter @impression/api token:create <name>`, then:

```sh
impression login --token imp_... --url http://localhost:3000   # saved to ~/.config/impression/config.json (0600)
impression add "Migrations run via db:migrate" [--user] [--pin]
impression search "how do migrations run"
impression list
impression status
impression edit <id> <text>
impression retire <id>               # kept as history
impression keep <id>                 # clears a possibly-stale flag
```

Ids are the 8-character prefixes that `list` and `search` print.

`IMPRESSION_URL` and `IMPRESSION_TOKEN` override the saved config. The hooks read it too.

Set `"sendInstructions": true` in the saved config (or `IMPRESSION_SEND_INSTRUCTIONS=1`) to send your AGENTS.md and CLAUDE.md files (project and global) with each extraction, so it skips rules those files already state. Off by default. The text is scrubbed, cut to a cap, and not stored.

## Web UI

`packages/web` is a React single-page app. `pnpm build` produces `packages/web/dist`, and the API serves it at `/` when that directory exists (or set `WEB_DIR`). Sign in with an API token; the project switcher lists every project on the server. For hot reload run the API on :3000 and `pnpm --filter @impression/web dev`.

## Run with Docker

```sh
export OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-...
docker compose up -d --build --wait
docker compose exec api pnpm --filter @impression/api token:create me   # prints your token
```

This starts Postgres with pgvector and the API, which applies migrations on boot and serves the web UI. Open http://localhost:3000 and sign in with the token. Without the two keys the server runs, but embeddings and extraction fail (memories are still saved and found by keyword).

## Run on Neon

Any Postgres with the `vector` extension works. On [Neon](https://neon.com), create a project (pgvector is available on all plans), copy the pooled connection string, and run only the API:

```sh
DATABASE_URL='postgres://...neon.tech/neondb?sslmode=require' pnpm --filter @impression/api db:migrate
DATABASE_URL=... OPENAI_API_KEY=... ANTHROPIC_API_KEY=... pnpm --filter @impression/api exec tsx src/index.ts
```

The migrations run `CREATE EXTENSION vector`, which Neon permits for the database owner.

## Run on Fly

Fly runs the API and web UI from the existing `Dockerfile` (it applies migrations on boot). Postgres comes from Neon (see above), and embeddings from OpenAI, since Ollama doesn't fit on a small Fly machine.

```sh
fly launch --copy-config --no-deploy --name <app>
fly secrets set DATABASE_URL='postgres://...neon.tech/neondb?sslmode=require' OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-...
fly deploy
fly ssh console -C "pnpm --filter @impression/api token:create me"   # prints your token
```

Then each teammate runs `impression login --url https://<app>.fly.dev --token imp_...` with their own token (create one per person). The token is the only protection, so don't share one.

`fly.toml` keeps one machine running, because a cold start would make the session-start hook time out and skip injection. Don't mix embedding models in one database. To move existing data from a local Ollama setup, restore a data-only `pg_dump` (skip `api_tokens` and the `drizzle` schema) into the migrated Neon database, set `embedding` to null on `memories` and `proposals`, then run `pnpm --filter @impression/api db:reembed` with `EMBEDDING_PROVIDER=openai`. `db:reembed` only fills rows with no vector. Servers that ran the old review queue should run `pnpm --filter @impression/api db:accept-backlog` once: it accepts pending proposals at or above their owner's floor and drops the rest. `--dry-run` prints the counts without writing, and `--limit N` takes only the oldest N pending proposals. A proposal whose embedding or dedup check fails goes back to pending, and the run stops after 3 failures in a row.

Pushes to `main` deploy automatically: the `deploy` job in `.github/workflows/ci.yml` runs after CI passes, using a `FLY_API_TOKEN` repo secret (`fly tokens create deploy -a <app>`).

## GitHub sign-in

Optional. Without it, sign-in is by API token only. Create a GitHub App (not an OAuth App) with read-only Metadata permission, "Request user authorization (OAuth) during installation" off, "Enable Device Flow" on, and the callback URL `https://<host>/auth/github/callback`. Then set:

| Variable                                   | Meaning                                                                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | From the app. Set both or neither.                                                                                                                        |
| `GITHUB_ALLOWED_ACCOUNTS`                  | Comma-separated GitHub users and orgs. Someone may sign in if the app is installed on one of these accounts and they can use that installation. Required. |
| `GITHUB_APP_SLUG`                          | Lets allowlisted people who haven't installed the app see an install link.                                                                                |
| `PUBLIC_URL`                               | Public origin, used for the callback. Defaults to the request's origin, which is wrong behind some proxies.                                               |

The web login page then shows "Sign in with GitHub", and `impression login --github --url https://<host>` signs in from the terminal. Both mint an `imp_` token named after the GitHub login. A browser sign-in replaces that person's previous browser token. CLI tokens stay, so a second machine doesn't sign out the first. ### Who sees what

- **Projects.** A signed-in person sees only projects for repos they can reach through their installations of the app (any installation, not just the allowlisted one). A `path:` project belongs to whoever first used it. Asking for a project you can't reach gives 404. GitHub is asked at most every 10 minutes per person, so losing repo access takes up to 10 minutes to show. If GitHub is down, the last answer is used. If their GitHub session is gone, requests get 401 and they sign in again.
- **Memories.** Every memory is private to its author. The author can share a `project` memory with the team (web: "Share with team", or `PATCH /api/memories/:id {"scope":"team"}`), and then everyone who can see that project reads it. Only the author can edit, delete, share or unshare it. Sessions stay private to whoever ran them.
- **Tokens from `token:create`.** They are admin tokens: they see every project, but memory privacy still applies to them. Keep them for the operator.
- **Existing data.** Memories written before this change were `project` scope, so they are now private to whichever token name wrote them. To hand them to a GitHub login: `pnpm --filter @impression/api owner:rename <token name> <github login>`. Sign-in is refused if the GitHub login matches an active `token:create` name, so rename or revoke that token first. A GitHub rename needs the same command.

GitHub tokens are stored encrypted with a key derived from `GITHUB_CLIENT_SECRET`. Rotating the secret signs everyone out.

## Local embeddings

```sh
brew install ollama && ollama pull nomic-embed-text
```

Put `EMBEDDING_PROVIDER=ollama` and `EMBEDDING_MODEL=nomic-embed-text` in `.env` next to `docker-compose.yml`, then `docker compose up -d --build api`. The container reaches the host's Ollama at `host.docker.internal:11434`. After changing the embedding model or the column size, run `pnpm --filter @impression/api db:reembed` to fill in the vectors that are missing. Migration 0005 clears them when it changes the column to 768 dimensions.
