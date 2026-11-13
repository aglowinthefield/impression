import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import type { Db, Queryer } from "./db/client.js";
import { projects } from "./db/schema.js";

/**
 * What a request may see. Tokens from `token:create` are admin: every project.
 * GitHub-signed-in people see projects for repos they can reach, plus their own
 * `path:` projects. Memory privacy (private to the author, or shared as team)
 * applies to everyone, admin or not.
 */
export class Access {
  private ids: Promise<string[] | null> | undefined;

  constructor(
    readonly admin: boolean,
    readonly userId: string | null,
    /** Lowercased `github.com/owner/repo` keys. */
    readonly repos: ReadonlySet<string>,
  ) {}

  /** Ids of the projects this request may see. Null means all of them. */
  projectIds(db: Queryer): Promise<string[] | null> {
    this.ids ??= this.admin
      ? Promise.resolve(null)
      : db
          .select({ id: projects.id })
          .from(projects)
          .where(this.projectCond())
          .then((rows) => rows.map((r) => r.id));
    return this.ids;
  }

  /** SQL for "this projects row is visible". Only for non-admin access. */
  private projectCond(): SQL {
    const byRepo = inArray(sql`lower(${projects.key})`, [...this.repos]);
    return this.userId
      ? (or(
          byRepo,
          and(
            sql`${projects.key} LIKE 'path:%'`,
            eq(projects.createdBy, this.userId),
          ),
        ) as SQL)
      : byRepo;
  }

  canSeeKey(key: string, createdBy: string | null): boolean {
    if (this.admin) return true;
    if (key.startsWith("path:"))
      return createdBy !== null && createdBy === this.userId;
    return this.repos.has(key.toLowerCase());
  }
}

export const ADMIN_ACCESS = () => new Access(true, null, new Set());

/** A condition limiting a project id column to visible projects. Undefined means no limit. */
export async function projectIdCond(
  db: Db,
  a: Access,
  col: Parameters<typeof inArray>[0],
): Promise<SQL | undefined> {
  const ids = await a.projectIds(db);
  return ids === null ? undefined : inArray(col, ids);
}

/** Finds a project by key if this request may see it. */
export async function findProject(db: Queryer, a: Access, key: string) {
  const [p] = await db.select().from(projects).where(eq(projects.key, key));
  return p && a.canSeeKey(p.key, p.createdBy) ? p : null;
}

/** Creates the project if needed. Returns null if this request may not use that project. */
export async function upsertProject(
  db: Queryer,
  a: Access,
  ref: { key: string; name?: string },
) {
  const name = ref.name ?? ref.key.split("/").pop() ?? ref.key;
  if (
    !a.admin &&
    !ref.key.startsWith("path:") &&
    !a.repos.has(ref.key.toLowerCase())
  ) {
    return null;
  }
  await db
    .insert(projects)
    .values({
      key: ref.key,
      name,
      createdBy: ref.key.startsWith("path:") ? a.userId : null,
    })
    .onConflictDoNothing({ target: projects.key });
  return findProject(db, a, ref.key);
}

/**
 * SQL for "this memory is visible": your own user and project memories, plus team
 * memories in projects you can see. `alias` is the memories table's name in the query.
 */
export async function memoryVisible(
  db: Db,
  a: Access,
  me: string,
  alias = "memories",
): Promise<SQL> {
  const col = (n: string) => sql.raw(`${alias}.${n}`);
  const ids = await a.projectIds(db);
  const inProject =
    ids === null
      ? sql`true`
      : ids.length === 0
        ? sql`false`
        : sql`${col("project_id")} IN (${sql.join(
            ids.map((i) => sql`${i}::uuid`),
            sql`, `,
          )})`;
  return sql`((${col("scope")} <> 'team' AND ${col("owner")} = ${me} AND (${col("project_id")} IS NULL OR ${inProject})) OR (${col("scope")} = 'team' AND ${col("project_id")} IS NOT NULL AND ${inProject}))`;
}
