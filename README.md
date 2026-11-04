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
