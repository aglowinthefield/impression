# Impression

pnpm monorepo: `packages/api` (Hono, Drizzle, Postgres), `packages/web` (React), `packages/cli`, `packages/mcp`, `packages/pi`, `packages/shared`. Run `pnpm install` before `pnpm build`; Before reporting work done, run `pnpm lint && pnpm typecheck && pnpm test` and get all of it passing, API tests included. They start the compose Postgres themselves, so Docker must be running. Don't skip or dismiss API failures as environment noise.

## Philosophy

Design decisions here follow [Tom's philosophy](https://github.com/aglowinthefield/skills/blob/main/philosophy/PHILOSOPHY.md), also at `~/code/PHILOSOPHY.md` on mochi. Read it before adding a module, a seam with another project, a loop, a schema change or a test strategy. A `## Departures` section in this file lists where this repo breaks it on purpose.

## Specs and decisions

Work is spec-driven, following Unconscious Development: each domain has a Persona in `docs/personas/<domain>.md`, and a change that needs a design choice gets a spec and plan in `docs/specs/<domain>/`, merged before any code. Use the `spec` skill (or `issue` to start from an issue id).

- Specs written before 2026-11-16 and the running decision log live in the Obsidian dev vault (`$DEV_VAULT/Impression/`, default `~/Documents/somewhere.garden/Impression/`). Leave them there; new specs go in the repo.
- Record decisions that outlive one spec in the vault's `Decisions.md`.

## Releasing

A PR with a change people who use Impression would notice adds a changeset: a file `.changeset/<short-name>.md` with `"@aglowinthefield/impression": minor` (a feature) or `patch` (a fix) in its frontmatter, and one line per change below it. Write each line for people who use Impression, not its developers. Internal work (CI, specs, tests, dev scripts) gets no changeset. Don't bump the version or edit `packages/impression/CHANGELOG.md` by hand.

The release workflow keeps a Release PR open while changesets wait on main. It bumps the version and moves their lines into the changelog, where pi shows them once after an update. Merging it publishes to npm and tags `v<version>`.
