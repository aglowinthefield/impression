# impression

Memory for development work: a self-hostable, mem0-style service that keeps project context
(conventions, decisions, gotchas, commands) and improves it over time. Built for one developer
or a small team, not for consumer-facing agents.

## Quick start

1. Start the server and create a token: see [Run with Docker](#run-with-docker). Without Docker, see [Develop](#develop).
2. Build the clients once with `pnpm install && pnpm build`. Below, `$IMP` stands for the checkout path.
3. Sign in from the CLI: `node $IMP/packages/cli/dist/bin.js login --token imp_... --url http://localhost:3000`.
4. Wire up your agent (below), then open http://localhost:3000 to review memories.

## Wire it into your agent

Every client reads `IMPRESSION_URL` (default `http://localhost:3000`) and `IMPRESSION_TOKEN`. The CLI and both hooks also fall back to the file `impression login` writes.

### Claude Code

MCP tools (`search`, `add`):

```sh
claude mcp add impression -e IMPRESSION_URL=http://localhost:3000 -e IMPRESSION_TOKEN=imp_... -- node $IMP/packages/mcp/dist/bin.js
```

Hooks, in `~/.claude/settings.json` (after `impression login`, no token is needed in the command):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node $IMP/packages/cli/dist/bin.js hook session-start"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node $IMP/packages/cli/dist/bin.js hook session-end --extract"
          }
        ]
      }
    ]
  }
}
```

Use the absolute path for `$IMP`. Session-start injects your core memories. Session-end sends the transcript and queues proposals, which you review in the web UI.

### pi

MCP tools:

```sh
pi mcp add impression --env IMPRESSION_URL=http://localhost:3000 --env IMPRESSION_TOKEN=imp_... -- node $IMP/packages/mcp/dist/bin.js
```

Run `/reload` or restart pi. That gives pi search and add. For automatic injection and capture, load the extension at `packages/pi/impression.ts` by adding its absolute path to `"extensions"` in `~/.pi/agent/settings.json`. It runs `impression hook session-start --plain` on session start, `hook prompt` (a search on the prompt text) before each prompt, and `hook session-end --extract` on each chunk of new conversation (after a run, once about 3000 characters have built up, and again on exit), so build the CLI first and run `impression login`.

## Troubleshooting

- **401 invalid token:** the token was mistyped or minted against another database. Mint a new one with `token:create`.
- **Search returns nothing or `degraded: true`:** the embedding call failed (check `OPENAI_API_KEY`). Keyword search still works. Memories saved while embeddings were down have no vector until their text is edited.
- **Extraction returns 502:** the LLM call failed (check `ANTHROPIC_API_KEY`). Nothing was stored; run extract again.
- **Hook prints nothing:** by design, hooks never fail loudly. Run the command by hand to see whether `impression status` works.

## Design decisions

- **Capture:** explicit adds, plus session-end LLM extraction into a proposal queue (deduped, auto-accepted above a confidence threshold).
- **Scopes:** user, project, team. A project is keyed by normalized git remote URL, falling back to root path. Memories can be narrowed to paths.
- **Retrieval:** a small curated core is injected at session start. The rest is reached through a `search` tool. Per-prompt injection is optional per project.
- **Staleness:** memories carry anchors (paths, symbols, commit SHA). Anchors are checked at retrieval and changed or missing ones are flagged. Contradictions supersede the old memory, which is kept as history.
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
| `AUTO_ACCEPT_CONFIDENCE`             | `0.9`                                        | Extracted memories at or above this become memories without review. `off` queues all. |
| `EMBEDDING_DIMENSIONS`, `OLLAMA_URL` |                                              | Ollama only. The dimension must be 768 to match the column.                           |
| `EMBEDDING_MIN_SIMILARITY`           | `0.25` openai, `0.45` ollama                 | Search floor. Cosine scores differ between models, so retune with the eval.           |

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

## Retrieval eval

`pnpm --filter @impression/api eval` runs a small fixture (14 memories, 18 queries, 5 off-topic queries, 15 memory pairs) against the configured embedding model and prints hit@3, MRR and off-topic results per `minSimilarity`, plus pair similarities for dedup. It calls the real embeddings API, so it costs a little. CI runs the same fixture with a fake embedder to catch ranking regressions.

With `nomic-embed-text` (768 dimensions), hit@3 is 1.00 and MRR 0.94. Off-topic queries return nothing from a 0.45 floor, which is its default. Paraphrases scored 0.76 to 0.91 and unrelated pairs at most 0.45, so the 0.55 dedup threshold still separates them.

With `text-embedding-3-small` (measured at 1536 dimensions, before the column went to 768; rerun the eval to confirm), the 0.25 search floor gave the best MRR (0.92), hit@3 1.00 and no off-topic results. Paraphrases scored 0.68 to 0.85, one conflicting pair scored 0.49 and unrelated pairs at most 0.14, so the dedup candidate floor is 0.4.

## MCP server

`packages/mcp` is a stdio MCP server with two tools, `search` and `add`. It resolves the project from the working directory and talks to the API over HTTP. Setup is under [Wire it into your agent](#wire-it-into-your-agent).

## Session-start hook

`GET /api/core` returns a small set per project: pinned first, then by confidence and recency, within a token budget (`budget`, default 800). Flagged-stale and superseded memories are left out. `impression hook session-start` (from `packages/cli`) prints it as Claude Code `SessionStart` output, or as plain text with `--plain`. It exits 0 and prints nothing if the API is down. Setup is under [Wire it into your agent](#wire-it-into-your-agent).

## Session-end hook

`impression hook session-end` reads Claude Code's `SessionEnd` JSON from stdin, flattens the transcript to user and assistant text, and posts it to `/api/sessions` with the project key and HEAD SHA. Add `--extract` to also queue proposals. It always exits 0, prints nothing on failure and gives up after 30 seconds. Setup is under [Wire it into your agent](#wire-it-into-your-agent).

## CLI

`packages/cli` builds the `impression` binary (`node packages/cli/dist/bin.js`). Create a token on the server with `pnpm --filter @impression/api token:create <name>`, then:

```sh
impression login --token imp_... --url http://localhost:3000   # saved to ~/.config/impression/config.json (0600)
impression add "Migrations run via db:migrate" [--user] [--pin]
impression search "how do migrations run"
impression list
impression status
impression proposals                 # pending, with 8-character ids
impression accept <id> [edited text]
impression reject <id>
impression edit <id> <text>
impression retire <id>               # kept as history
impression keep <id>                 # clears a possibly-stale flag
```

Ids are the 8-character prefixes that `list`, `search` and `proposals` print.

`IMPRESSION_URL` and `IMPRESSION_TOKEN` override the saved config. The hooks read it too.

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

## Local embeddings

```sh
brew install ollama && ollama pull nomic-embed-text
```

Put `EMBEDDING_PROVIDER=ollama` and `EMBEDDING_MODEL=nomic-embed-text` in `.env` next to `docker-compose.yml`, then `docker compose up -d --build api`. The container reaches the host's Ollama at `host.docker.internal:11434`. After changing the embedding model or the column size, run `pnpm --filter @impression/api db:reembed` to fill in the vectors that are missing. Migration 0005 clears them when it changes the column to 768 dimensions.
