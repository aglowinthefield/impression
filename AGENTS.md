# Impression

pnpm monorepo: `packages/api` (Hono, Drizzle, Postgres), `packages/web` (React), `packages/cli`, `packages/mcp`, `packages/pi`, `packages/shared`. Run `pnpm install` before `pnpm build`; API tests need Postgres (`docker compose up -d`).

## Specs and decisions

Work is spec-driven. Specs and the running decision log live in the Obsidian dev vault, not in this repo (`$DEV_VAULT/Impression/`, default `~/Documents/Dev/Impression/`).

- Before building a feature that changes behaviour, write a spec from `Spec template.md` into `Specs/`, and get it reviewed before code.
- Keep the spec's `status` and `pr` frontmatter current. Move resolved open questions into Decisions.
- Record decisions that outlive one spec in `Decisions.md`.
- The repo keeps only what contributors need: this file and the README.
