import { and, eq, inArray, or, sql } from "drizzle-orm";
import { createDb, DEFAULT_DATABASE_URL } from "./db/client.js";
import {
  conceptLinks,
  conceptMemories,
  concepts,
  memories,
  projects,
} from "./db/schema.js";
import { dream } from "./dream.js";
import { createProviders } from "./providers/index.js";
import { UsageRecorder, withUsageContext } from "./usage.js";

// Usage: db:dream <project key or name> <owner> [--quiet]
const [project, owner] = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--"));
const quiet = process.argv.includes("--quiet");
if (!project || !owner) {
  console.error("usage: db:dream <project key or name> <owner> [--quiet]");
  process.exit(2);
}

const { db, close } = createDb(
  process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
);
const usage = new UsageRecorder(db);
const providers = createProviders(process.env, undefined, usage.record);
try {
  const found = await db
    .select()
    .from(projects)
    .where(sql`${projects.key} = ${project} OR ${projects.name} = ${project}`);
  const p = found[0];
  if (!p || found.length > 1) {
    console.error(
      found.length
        ? `"${project}" names several projects; use its key`
        : `no project "${project}"`,
    );
    process.exitCode = 1;
  } else {
    const started = Date.now();
    const r = await withUsageContext(
      { userId: null, principal: owner, operation: "dream" },
      () => dream(db, providers.llm, p.id, owner),
    );
    console.log(
      `${p.key}: ${r.memories} memories into ${r.concepts} concepts (${r.created} new, ${r.kept} kept, ${r.removed} removed), ${r.uncategorized} uncategorized, ${((Date.now() - started) / 1000).toFixed(0)}s`,
    );
    if (!quiet) await print(p.id);
  }
} finally {
  await usage.flush();
  await close();
}

async function print(projectId: string) {
  const cs = await db
    .select()
    .from(concepts)
    .where(
      and(
        eq(concepts.projectId, projectId),
        eq(concepts.owner, owner as string),
      ),
    )
    .orderBy(concepts.name);
  if (!cs.length) return;
  const ids = cs.map((c) => c.id);
  const members = await db
    .select({ conceptId: conceptMemories.conceptId, content: memories.content })
    .from(conceptMemories)
    .innerJoin(memories, eq(memories.id, conceptMemories.memoryId))
    .where(inArray(conceptMemories.conceptId, ids));
  const links = await db
    .select()
    .from(conceptLinks)
    .where(or(inArray(conceptLinks.aId, ids), inArray(conceptLinks.bId, ids)));
  const name = new Map(cs.map((c) => [c.id, c.name]));
  const show = (c: (typeof cs)[number], indent: string) => {
    const ms = members.filter((m) => m.conceptId === c.id);
    console.log(`\n${indent}${c.name} (${ms.length})  [${c.id.slice(0, 8)}]`);
    console.log(`${indent}  ${c.summary}`);
    const related = links
      .filter((l) => l.aId === c.id || l.bId === c.id)
      .map((l) => name.get(l.aId === c.id ? l.bId : l.aId));
    if (related.length)
      console.log(`${indent}  related: ${related.join(", ")}`);
    for (const m of ms) {
      console.log(
        `${indent}  - ${m.content.replace(/\s+/g, " ").slice(0, 110)}`,
      );
    }
  };
  for (const c of cs.filter((c) => !c.parentId)) {
    show(c, "");
    for (const k of cs.filter((k) => k.parentId === c.id)) show(k, "    ");
  }
}
