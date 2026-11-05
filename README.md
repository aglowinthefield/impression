# impression

Memory for development work: a self-hostable, mem0-style service that keeps project context
(conventions, decisions, gotchas, commands) and improves it over time. Built for one developer
or a small team, not for consumer-facing agents.

## Design decisions

- **Capture:** explicit adds, plus session-end LLM extraction into a proposal queue (deduped, auto-accepted above a confidence threshold).
- **Scopes:** user, project, team. A project is keyed by normalized git remote URL, falling back to root path. Memories can be narrowed to paths.
- **Retrieval:** a small curated core is injected at session start. The rest is reached through a `search` tool. Per-prompt injection is optional per project.
- **Staleness:** memories carry anchors (paths, symbols, commit SHA). Anchors are checked at retrieval and changed or missing ones are flagged. Contradictions supersede the old memory, which is kept as history.
- **Storage:** Postgres with pgvector.
- **Integration:** one HTTP API server owns storage, extraction and anchor checks. MCP server, CLI, hooks and a web UI are clients.
- **Models:** pluggable providers. Defaults are OpenAI `text-embedding-3-small` and a Haiku-class extractor. Ollama is configurable. The embedding model and dimension are stored per memory.
- **Team (after v1):** per-person tokens, member and admin roles, explicit promotion to team scope, provenance, and a secret and PII scrubber.

## v1

Personal-first slice with a web UI. See the milestones and issues on GitHub.
Out of v1: team scope, roles and approval, per-prompt injection, extra local providers.

## Stack

TypeScript monorepo (pnpm workspaces, Node 22+). Packages: `shared`, `api`, `cli`, `mcp`. `web` arrives in M6.

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
| `EMBEDDING_DIMENSIONS`, `OLLAMA_URL` |                                              | Ollama only. The dimension must be 1536 to match the column.                          |

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

## MCP server

`packages/mcp` is a stdio MCP server with two tools, `search` and `add`. It resolves the project from the working directory and talks to the API over HTTP. Build it with `pnpm build`, then register `node packages/mcp/dist/bin.js` in your agent with `IMPRESSION_URL` (default `http://localhost:3000`) and `IMPRESSION_TOKEN` set. For Claude Code:

```sh
claude mcp add impression -e IMPRESSION_TOKEN=imp_... -- node /path/to/impression/packages/mcp/dist/bin.js
```

## Session-start hook

`GET /api/core` returns a small set per project: pinned first, then by confidence and recency, within a token budget (`budget`, default 800). Flagged-stale and superseded memories are left out. `impression hook session-start` (from `packages/cli`) prints it as Claude Code `SessionStart` output, or as plain text with `--plain`. It exits 0 and prints nothing if the API is down. In `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "IMPRESSION_TOKEN=imp_... node /path/to/impression/packages/cli/dist/bin.js hook session-start"
          }
        ]
      }
    ]
  }
}
```

## Session-end hook

`impression hook session-end` reads Claude Code's `SessionEnd` JSON from stdin, flattens the transcript to user and assistant text, and posts it to `/api/sessions` with the project key and HEAD SHA. Add `--extract` to also queue proposals. It always exits 0, prints nothing on failure and gives up after 30 seconds. Add it under `hooks.SessionEnd` in `~/.claude/settings.json`, like the session-start hook.

## CLI

`packages/cli` builds the `impression` binary (`node packages/cli/dist/bin.js`). Create a token on the server with `pnpm --filter @impression/api token:create <name>`, then:

```sh
impression login --token imp_... --url http://localhost:3000   # saved to ~/.config/impression/config.json (0600)
impression add "Migrations run via db:migrate" [--user] [--pin]
impression search "how do migrations run"
impression list
impression status
```

`IMPRESSION_URL` and `IMPRESSION_TOKEN` override the saved config. The hooks read it too.
