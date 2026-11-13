import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/** Dimension of the `embedding` column. Changing it needs a migration and a re-embed. */
export const EMBEDDING_DIM = 768;

const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

export const scopeEnum = pgEnum("memory_scope", ["user", "project", "team"]);
export const memoryStatusEnum = pgEnum("memory_status", [
  "active",
  "possibly_stale",
  "superseded",
  "retired",
]);
export const proposalStatusEnum = pgEnum("proposal_status", [
  "pending",
  "accepted",
  "rejected",
]);

/** A repository, keyed by normalized git remote URL (or root path as a fallback). */
export const projects = pgTable("projects", {
  id: uuid().primaryKey().defaultRandom(),
  key: text().notNull().unique(),
  name: text().notNull(),
  /** Set only for `path:` projects, which have no repo to check access against. */
  createdBy: uuid().references((): AnyPgColumn => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const memories = pgTable(
  "memories",
  {
    id: uuid().primaryKey().defaultRandom(),
    scope: scopeEnum().notNull(),
    /** Null for user-scoped memories that follow the person across projects. */
    projectId: uuid().references(() => projects.id, { onDelete: "cascade" }),
    /** Who owns a user-scoped memory. Single-token v1 uses one fixed owner. */
    owner: text().notNull(),
    content: text().notNull(),
    /** Optional narrowing to a subdirectory, e.g. a monorepo package. */
    pathPrefix: text(),
    embedding: vector({ dimensions: EMBEDDING_DIM }),
    embeddingModel: text(),
    embeddingDim: integer(),
    status: memoryStatusEnum().notNull().default("active"),
    staleReason: text(),
    confidence: real(),
    /** Free-form labels. "practice" marks how the owner likes work done. */
    tags: text().array().notNull().default([]),
    /** Pinned memories are candidates for the session-start core set. */
    pinned: boolean().notNull().default(false),
    // Provenance: who or what wrote it, and from which session.
    author: text().notNull(),
    agent: text(),
    sessionId: uuid().references(() => sessions.id, { onDelete: "set null" }),
    supersededBy: uuid().references((): AnyPgColumn => memories.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    search: tsvector().generatedAlwaysAs(
      (): ReturnType<typeof sql> => sql`to_tsvector('english', content)`,
    ),
  },
  (t) => [
    index("memories_project_status_idx").on(t.projectId, t.status),
    index("memories_owner_scope_idx").on(t.owner, t.scope),
    index("memories_search_idx").using("gin", t.search),
    index("memories_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  ],
);

/** Code locations a memory depends on, checked at retrieval to detect staleness. */
export const anchors = pgTable(
  "anchors",
  {
    id: uuid().primaryKey().defaultRandom(),
    memoryId: uuid()
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    path: text().notNull(),
    symbol: text(),
    /** Commit the memory was recorded at. */
    commitSha: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("anchors_memory_idx").on(t.memoryId)],
);

export const sessions = pgTable("sessions", {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid()
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  /** Who ended the session. Sessions are visible only to their owner. */
  owner: text().notNull(),
  agent: text(),
  commitSha: text(),
  transcript: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * What extraction produced at session end. Each candidate at or above the owner's
 * floor is accepted right away; `pending` and reviewed rows are from the old review queue.
 */
export const proposals = pgTable(
  "proposals",
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sessionId: uuid().references(() => sessions.id, { onDelete: "set null" }),
    content: text().notNull(),
    /** User for practices (they follow the person), project for everything else. */
    scope: scopeEnum().notNull().default("project"),
    tags: text().array().notNull().default([]),
    confidence: real().notNull(),
    /** Used to recognise a re-proposal of something a person rejected. */
    embedding: vector({ dimensions: EMBEDDING_DIM }),
    /** Proposed anchors: [{ path, symbol?, commitSha }]. */
    anchors: jsonb().notNull().default([]),
    status: proposalStatusEnum().notNull().default("pending"),
    /** The memory created when the proposal was accepted. */
    memoryId: uuid().references(() => memories.id, { onDelete: "set null" }),
    /** When a person accepted or rejected it. Null for pending and auto-accepted ones. */
    reviewedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("proposals_project_status_idx").on(t.projectId, t.status)],
);

/** Per-person settings, keyed by principal (GitHub login or token name). */
export const userSettings = pgTable("user_settings", {
  owner: text().primaryKey(),
  /** Extraction drops candidates below this confidence. */
  extractionFloor: real().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** A person who signed in with GitHub. */
export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  githubId: bigint({ mode: "number" }).notNull().unique(),
  login: text().notNull(),
  /** GitHub user token and its refresh token, sealed with a key derived from the client secret. */
  accessTokenEnc: text(),
  refreshTokenEnc: text(),
  accessExpiresAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** API tokens. Only the SHA-256 hash is stored, so a token is shown once at creation. */
export const apiTokens = pgTable("api_tokens", {
  id: uuid().primaryKey().defaultRandom(),
  /** The person this token acts as. Becomes the owner and author of what it writes. */
  name: text().notNull(),
  tokenHash: text().notNull().unique(),
  /** The GitHub user this token belongs to. Null for tokens made by `token:create`. */
  userId: uuid().references(() => users.id, { onDelete: "set null" }),
  /** "manual" (token:create), "web" (browser sign-in) or "cli" (device flow). */
  source: text().notNull().default("manual"),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp({ withTimezone: true }),
});

/**
 * One user prompt from a pi session, with the memories injected for it. Uploaded by
 * `impression eval push`, so a person can rate whether those memories helped.
 */
export const evalTurns = pgTable(
  "eval_turns",
  {
    id: uuid().primaryKey().defaultRandom(),
    owner: text().notNull(),
    projectId: uuid().references(() => projects.id, { onDelete: "cascade" }),
    /** The agent's own session id, so a re-push updates the same rows. */
    agentSessionId: text().notNull(),
    turnIndex: integer().notNull(),
    prompt: text().notNull(),
    reply: text().notNull(),
    /** Memory texts injected for this prompt. */
    injected: jsonb().$type<string[]>().notNull().default([]),
    /** Rating per injected memory text: useful, irrelevant or wrong. */
    ratings: jsonb().$type<Record<string, string>>().notNull().default({}),
    at: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("eval_turns_turn_idx").on(
      t.owner,
      t.agentSessionId,
      t.turnIndex,
    ),
    index("eval_turns_project_idx").on(t.projectId),
  ],
);

/** A person's verdict on a stored memory: was it worth extracting? */
export const memoryRatings = pgTable(
  "memory_ratings",
  {
    memoryId: uuid()
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    owner: text().notNull(),
    rating: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.memoryId, t.owner] })],
);

/**
 * One model call: who caused it, which model ran and how many tokens it used.
 * Written for analytics now and billing later, so it is never edited after insert.
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** The signed-in GitHub user. Null for admin tokens and CLI jobs such as re-embeds. */
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    /** Token name, kept so admin-token usage is still attributable. */
    principal: text(),
    /** API area that made the call, e.g. "search" or "sessions". "job" outside a request. */
    operation: text().notNull(),
    kind: text().notNull(),
    provider: text().notNull(),
    model: text().notNull(),
    inputTokens: integer().notNull(),
    outputTokens: integer().notNull(),
    /** Estimated cost in millionths of a US dollar. Null when the model has no known price. */
    costMicros: integer(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("usage_events_user_created_idx").on(t.userId, t.createdAt),
    index("usage_events_created_idx").on(t.createdAt),
  ],
);
