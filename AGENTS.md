# Impression

pnpm monorepo: `packages/api` (Hono, Drizzle, Postgres), `packages/web` (React), `packages/cli`, `packages/mcp`, `packages/pi`, `packages/shared`. Run `pnpm install` before `pnpm build`; Before reporting work done, run `pnpm lint && pnpm typecheck && pnpm test` and get all of it passing, API tests included. They start the compose Postgres themselves, so Docker must be running. Don't skip or dismiss API failures as environment noise.

## Philosophy

Design decisions here follow [Tom's philosophy](https://github.com/aglowinthefield/skills/blob/main/philosophy/PHILOSOPHY.md), also at `~/code/PHILOSOPHY.md` on mochi. Read it before adding a module, a seam with another project, a loop, a schema change or a test strategy. A `## Departures` section in this file lists where this repo breaks it on purpose.

## Specs and decisions

Work is spec-driven, following Unconscious Development: each domain has a Persona in `docs/personas/<domain>.md`, and a change that needs a design choice gets a spec and plan in `docs/specs/<domain>/`, merged before any code. Use the `spec` skill (or `issue` to start from an issue id).

- Specs written before 2026-11-16 and the running decision log live in the Obsidian dev vault (`$DEV_VAULT/Impression/`, default `~/Documents/somewhere.garden/Impression/`). Leave them there; new specs go in the repo.
- Record decisions that outlive one spec in the vault's `Decisions.md`.

## Releasing

Before bumping `packages/impression/package.json` and tagging `v<version>`, add a `## <version>` section to the top of `CHANGELOG.md`. Write it for people who use Impression, not its developers: one bullet per change they would notice, from the PRs merged since the last tag, and leave out internal work (CI, specs, tests, dev scripts). pi shows these bullets once after an update, and the release workflow fails without the section.
