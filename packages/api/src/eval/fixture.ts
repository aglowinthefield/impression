/** Memories, queries and pairs used to compare ranking and threshold changes. */

export const memories = [
  {
    id: "pnpm",
    content:
      "Use pnpm, not npm or yarn. The repo is a pnpm workspace and CI installs with pnpm install --frozen-lockfile.",
  },
  {
    id: "migrate",
    content:
      "Apply database schema changes with pnpm --filter @impression/api db:migrate. Generate new migrations with drizzle-kit.",
  },
  {
    id: "deploy",
    content:
      "Production deploys go to Fly.io with flyctl deploy from the main branch. Never deploy from a feature branch.",
  },
  {
    id: "pg-port",
    content:
      "The local dev Postgres listens on port 54329, not 5432, to avoid clashing with other installs.",
  },
  {
    id: "tsrs",
    content:
      "TypeScript is compiled with tsrs, the Rust port of tsc. Do not add the typescript package.",
  },
  {
    id: "biome",
    content:
      "Lint and formatting use Biome. Run pnpm format before committing; CI fails on unformatted code.",
  },
  {
    id: "auth",
    content:
      "API requests need a bearer token starting with imp_. Tokens are stored hashed and created with the token:create script.",
  },
  {
    id: "embed",
    content:
      "Embeddings come from OpenAI text-embedding-3-small at 1536 dimensions. Changing the model means re-embedding every memory.",
  },
  {
    id: "scrub",
    content:
      "Secrets and personal data are redacted before storage. Memories that contain only a secret are rejected with a 422.",
  },
  {
    id: "tests",
    content:
      "Tests run against a real Postgres with pgvector. Each test file creates a throwaway database and drops it afterwards.",
  },
  {
    id: "stale",
    content:
      "Memories with anchors are checked against the working tree. A missing file or symbol marks the memory possibly stale.",
  },
  {
    id: "hooks",
    content:
      "The session end hook posts the transcript to the API and must always exit 0 so it never blocks closing the editor.",
  },
  {
    id: "branch",
    content:
      "Work happens on a git worktree per branch under .worktrees, never directly in the main checkout.",
  },
  {
    id: "ui",
    content:
      "The web UI is a React single page app built with Vite and served by the API at the root path.",
  },
] as const;

/** Each query is worded differently from its memory. `expect` is the memory that should rank in the top results. */
export const queries = [
  { q: "how do I install dependencies", expect: "pnpm" },
  { q: "which package manager should I use", expect: "pnpm" },
  { q: "how do I apply schema changes", expect: "migrate" },
  { q: "creating a new database migration", expect: "migrate" },
  { q: "how do we ship to production", expect: "deploy" },
  { q: "where is the app hosted", expect: "deploy" },
  { q: "which port does local postgres use", expect: "pg-port" },
  { q: "how is the code compiled", expect: "tsrs" },
  { q: "why does CI complain about formatting", expect: "biome" },
  { q: "how do I authenticate to the api", expect: "auth" },
  { q: "how do I get an api key", expect: "auth" },
  { q: "what model makes the vectors", expect: "embed" },
  { q: "what happens when I save a password", expect: "scrub" },
  { q: "how are tests isolated from each other", expect: "tests" },
  { q: "when is a memory marked outdated", expect: "stale" },
  { q: "what should a hook do on failure", expect: "hooks" },
  { q: "where should I make my changes in git", expect: "branch" },
  { q: "what framework is the frontend built on", expect: "ui" },
] as const;

/** Questions the memories can't answer. Search should return little or nothing. */
export const offTopic = [
  "what is the capital of France",
  "how do I bake sourdough bread",
  "who won the world cup in 2018",
  "best hiking trails near Denver",
  "explain the plot of Hamlet",
] as const;

/**
 * Pairs for the dedup candidate threshold. Candidates should include
 * paraphrases and conflicts (both need the LLM's judgment) and exclude unrelated pairs.
 */
export const pairs = {
  paraphrase: [
    [
      "Use pnpm, not npm or yarn.",
      "Always use pnpm for installs; npm and yarn are not supported.",
    ],
    [
      "Deploys go to Fly.io with flyctl deploy.",
      "We ship production to Fly.io using the flyctl deploy command.",
    ],
    [
      "Dev Postgres runs on port 54329.",
      "The local Postgres for development listens on 54329 instead of 5432.",
    ],
    [
      "Run pnpm format before committing.",
      "Before you commit, run pnpm format or CI will fail.",
    ],
    [
      "Hooks must always exit 0.",
      "A hook should never exit non-zero, so it can't block the editor closing.",
    ],
  ],
  conflict: [
    ["We deploy to Fly.io.", "We deploy to Railway now, not Fly.io."],
    [
      "Embeddings use text-embedding-3-small.",
      "Embeddings use text-embedding-3-large.",
    ],
    ["The dev Postgres is on port 54329.", "The dev Postgres is on port 5433."],
    ["Use pnpm for installs.", "Use bun for installs."],
    [
      "Tests use a throwaway database per file.",
      "Tests share one database and truncate tables between files.",
    ],
  ],
  unrelated: [
    [
      "Use pnpm, not npm or yarn.",
      "The web UI is served by the API at the root path.",
    ],
    [
      "Deploys go to Fly.io with flyctl deploy.",
      "Secrets are redacted before storage.",
    ],
    [
      "Dev Postgres runs on port 54329.",
      "Work happens on a git worktree per branch.",
    ],
    [
      "Run pnpm format before committing.",
      "Embeddings use text-embedding-3-small.",
    ],
    [
      "Hooks must always exit 0.",
      "Tokens are stored hashed and start with imp_.",
    ],
  ],
} as const;
