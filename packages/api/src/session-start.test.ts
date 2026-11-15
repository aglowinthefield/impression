import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { conceptMemories, concepts, memories, projects } from "./db/schema.js";
import {
  countLabels,
  parseVerdict,
  renderConcepts,
  renderTopN,
  type SessionResult,
  summarize,
} from "./eval/session-start.js";
import { conceptStart } from "./session-start.js";
import { createTestDb } from "./test-db.js";

describe("conceptStart", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let projectId = "";
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestDb();
    const [p] = await t.db
      .insert(projects)
      .values({ key: "github.com/a/b", name: "b" })
      .returning();
    projectId = p?.id ?? "";
    const mem = async (key: string, content: string, extra = {}) => {
      const [m] = await t.db
        .insert(memories)
        .values({
          projectId,
          owner: "tom",
          author: "tom",
          content,
          scope: "user",
          ...extra,
        })
        .returning();
      ids[key] = m?.id ?? "";
    };
    await mem("a1", "Deploys go through CI", { confidence: 0.9 });
    await mem("a2", "Fly app name is x", { confidence: 0.4 });
    await mem("b1", "Tests need Docker");
    await mem("old", "Retired fact", { status: "retired" });
    const [area] = await t.db
      .insert(concepts)
      .values({ projectId, owner: "tom", name: "Deploy", summary: "how" })
      .returning();
    const [sub] = await t.db
      .insert(concepts)
      .values({
        projectId,
        owner: "tom",
        parentId: area?.id,
        name: "Fly",
        summary: "the app",
      })
      .returning();
    const [other] = await t.db
      .insert(concepts)
      .values({ projectId, owner: "tom", name: "Testing", summary: "tests" })
      .returning();
    await t.db.insert(conceptMemories).values([
      { conceptId: area?.id ?? "", memoryId: ids.a1 ?? "" },
      { conceptId: sub?.id ?? "", memoryId: ids.a2 ?? "" },
      { conceptId: area?.id ?? "", memoryId: ids.old ?? "" },
      { conceptId: other?.id ?? "", memoryId: ids.b1 ?? "" },
    ]);
    // Someone else's concept in the same project stays out.
    await t.db
      .insert(concepts)
      .values({ projectId, owner: "sam", name: "Secret", summary: "no" });
  });
  afterAll(() => t.drop());

  test("maps areas then subtopics, and adds each concept's best live memory", async () => {
    const s = await conceptStart(t.db, projectId, "tom", [], 800);
    expect(s.map.map((c) => [c.name, c.sub])).toEqual([
      ["Deploy", false],
      ["Fly", true],
      ["Testing", false],
    ]);
    expect(s.top.map((m) => m.content).sort()).toEqual([
      "Deploys go through CI",
      "Fly app name is x",
      "Tests need Docker",
    ]);
  });

  test("keeps pinned memories and practices from the core set without repeating them", async () => {
    const core = [
      {
        id: ids.a1 ?? "",
        content: "Deploys go through CI",
        pinned: true,
        tags: [],
      },
      { id: "p", content: "Be terse", pinned: false, tags: ["practice"] },
      { id: "x", content: "Unpinned", pinned: false, tags: [] },
    ];
    const s = await conceptStart(t.db, projectId, "tom", core, 800);
    expect(s.base.map((i) => i.id)).toEqual([ids.a1, "p"]);
    expect(s.top.map((m) => m.id)).not.toContain(ids.a1);
  });

  test("stops at the budget", async () => {
    const s = await conceptStart(t.db, projectId, "tom", [], 12);
    expect(s.tokens).toBeLessThanOrEqual(12);
    expect(s.map.length + s.top.length).toBeLessThan(6);
  });
});

describe("session-start eval", () => {
  const items = [
    { id: "1", content: "Be terse", pinned: false, tags: ["practice"] },
    { id: "2", content: "Tests need Docker", pinned: false, tags: [] },
  ];

  test("renders top-N as the hook does", () => {
    expect(renderTopN("b", items).text).toBe(
      "How this user likes to work (from Impression; follow these when they apply):\n- Be terse\nSaved memories for b (from Impression; use the impression search tool for more):\n- Tests need Docker",
    );
  });

  test("renders the concept version with topic lines", () => {
    const p = renderConcepts("b", {
      base: [items[0] as (typeof items)[0]],
      map: [
        { id: "c", name: "Deploy", summary: "how", sub: false },
        { id: "d", name: "Fly", summary: "the app", sub: true },
      ],
      top: [items[1] as (typeof items)[0]],
      tokens: 0,
    });
    expect(p.lines.map((l) => l.kind)).toEqual([
      "memory",
      "concept",
      "concept",
      "memory",
    ]);
    expect(p.text).toContain("-   Fly: the app");
  });

  test("parses verdicts and counts skipped lines as irrelevant", () => {
    const v = parseVerdict(
      'ok {"a":[{"n":1,"label":"helped"}],"b":[],"better":"A","why":"w"}',
    );
    expect(v?.better).toBe("A");
    expect(parseVerdict('{"a":[],"b":[],"better":"C"}')).toBeNull();
    const counts = countLabels(renderTopN("b", items), v?.a ?? []);
    expect(counts.memory).toEqual({ helped: 1, irrelevant: 1, misleading: 0 });
  });

  test("passes when concepts win or tie half and help no less", () => {
    const c = (helped: number, irrelevant: number) => ({
      memory: { helped, irrelevant, misleading: 0 },
      concept: { helped: 0, irrelevant: 0, misleading: 0 },
    });
    const r = (better: "A" | "B" | "tie", helped: number): SessionResult => ({
      conceptsWere: "A",
      verdict: { a: [], b: [], better, why: "" },
      topN: c(1, 1),
      concepts: c(helped, 2 - helped),
    });
    expect(summarize([r("A", 1), r("B", 1)]).pass).toBe(true);
    expect(summarize([r("A", 0), r("tie", 1)]).pass).toBe(false);
    expect(summarize([r("B", 2), r("B", 2), r("tie", 2)]).pass).toBe(false);
  });
});
