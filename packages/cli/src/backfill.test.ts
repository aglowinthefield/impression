import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ApiClient, pieceHash } from "@impression/shared";
import { describe, expect, test } from "vitest";
import {
  acquireLock,
  type BackfillArgs,
  type BackfillDeps,
  backfill,
  backfillStatus,
  commitBefore,
  findRepo,
  NOT_SIGNED_IN,
  offerBackfill,
  parseBackfillArgs,
  progressPath,
  retryable,
} from "./backfill.js";
import { claudeDirName, piDirName } from "./transcripts.js";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const line = (o: unknown) => JSON.stringify(o);
const PID = 4242;

// ---------------------------------------------------------------- fixtures

function git(cwd: string, args: string[], date?: string) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  }).trim();
}

function commit(repo: string, date: string): string {
  git(repo, ["commit", "-q", "--allow-empty", "-m", date], date);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** A temp world: a git repo, transcript folders and a config dir. */
function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "imp-backfill-")));
  const repo = join(base, "app");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  const first = commit(repo, "2026-09-01T00:00:00Z");
  const env = {
    XDG_CONFIG_HOME: join(base, "config"),
    IMPRESSION_BACKFILL_PI_DIR: join(base, "pi"),
    IMPRESSION_BACKFILL_CLAUDE_DIR: join(base, "claude"),
    IMPRESSION_BACKFILL_CODEX_DIR: join(base, "codex"),
  };
  return { base, repo, env, first, key: `path:${repo}` };
}

type World = ReturnType<typeof world>;

const text = (tag: string, n = 700) => `${tag} `.repeat(Math.ceil(n / 5));

function writeFile(path: string, lines: string[], mtime: number) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join("\n"));
  utimesSync(path, mtime / 1000, mtime / 1000);
}

/** A pi session started at `start`, last written ten minutes later unless `mtime` says. */
function piSession(
  w: World,
  cwd: string,
  id: string,
  start: number,
  opts: { mtime?: number; chars?: number } = {},
) {
  writeFile(
    join(w.env.IMPRESSION_BACKFILL_PI_DIR, piDirName(cwd), `${id}.jsonl`),
    [
      line({
        type: "session",
        id,
        timestamp: new Date(start).toISOString(),
        cwd,
      }),
      line({
        type: "message",
        message: { role: "user", content: text(`ask-${id}`, opts.chars) },
      }),
      line({
        type: "message",
        message: { role: "assistant", content: text(`answer-${id}`) },
      }),
    ],
    opts.mtime ?? start + 10 * 60_000,
  );
}

function claudeSession(w: World, cwd: string, id: string, start: number) {
  writeFile(
    join(
      w.env.IMPRESSION_BACKFILL_CLAUDE_DIR,
      claudeDirName(cwd),
      `${id}.jsonl`,
    ),
    [
      line({
        type: "user",
        cwd,
        sessionId: id,
        timestamp: new Date(start).toISOString(),
        message: { content: text(`ask-${id}`) },
      }),
    ],
    start + 10 * 60_000,
  );
}

function codexSession(w: World, cwd: string, id: string, start: number) {
  writeFile(
    join(w.env.IMPRESSION_BACKFILL_CODEX_DIR, "2026", `rollout-${id}.jsonl`),
    [
      line({
        timestamp: new Date(start).toISOString(),
        type: "session_meta",
        payload: { id, cwd },
      }),
      line({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: text(`ask-${id}`) }],
        },
      }),
    ],
    start + 10 * 60_000,
  );
}

// ---------------------------------------------------------------- stub API

const apiError = (status: number, msg: string) =>
  new Error(`Impression API ${status}: ${msg}`);

interface Stored {
  id: string;
  hash: string;
  body: Record<string, unknown>;
  extracted: boolean;
}

type ExtractReply = {
  saved: number;
  updated: number;
  costUsd: number;
  alreadyExtracted?: boolean;
};

/**
 * A stand-in for the server: dedupes pieces by hash for good, marks the hooks'
 * session keys live, prices each new piece at `perPiece`, and extracts with
 * `extract`, which a test can hold on a promise.
 */
function stubApi(
  opts: {
    budget?: number;
    spent?: number;
    perPiece?: number;
    live?: string[];
    extract?: (s: Stored, n: number) => Promise<ExtractReply>;
    undo?: () => Promise<unknown>;
  } = {},
) {
  const perPiece = opts.perPiece ?? 0.04;
  const byHash = new Map<string, Stored>();
  const byId = new Map<string, Stored>();
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let extracts = 0;
  const extract =
    opts.extract ??
    (async () => ({ saved: 1, updated: 0, costUsd: perPiece }) as ExtractReply);
  const client: ApiClient = {
    get: async () => ({}),
    post: async (path, raw) => {
      const body = raw as Record<string, unknown>;
      calls.push({ path, body });
      if (path === "/backfill/plan") {
        const pieces = body.pieces as { hash: string; sessionKey?: string }[];
        const out = pieces.map((p) => ({
          hash: p.hash,
          status: byHash.get(p.hash)?.extracted
            ? "done"
            : p.sessionKey && opts.live?.includes(p.sessionKey)
              ? "live"
              : "new",
        }));
        return {
          pieces: out,
          estimateUsd: out.filter((p) => p.status === "new").length * perPiece,
          budgetUsd: opts.budget ?? 10,
          spentUsd: opts.spent ?? 0,
          model: "claude-sonnet-5-5",
        };
      }
      if (path === "/sessions") {
        const hash = pieceHash(body.transcript as string);
        const had = byHash.get(hash);
        if (had)
          return { id: had.id, duplicate: true, extracted: had.extracted };
        const s = { id: `id-${byId.size + 1}`, hash, body, extracted: false };
        byHash.set(hash, s);
        byId.set(s.id, s);
        return { id: s.id };
      }
      const m = /^\/sessions\/(.+)\/extract$/.exec(path);
      if (m) {
        const s = byId.get(m[1] as string) as Stored;
        if (s.extracted)
          return { saved: 0, updated: 0, costUsd: 0, alreadyExtracted: true };
        const r = await extract(s, extracts++);
        s.extracted = true;
        return r;
      }
      if (path.startsWith("/backfill/undo"))
        return (opts.undo ?? (async () => ({ retired: 0 })))();
      throw apiError(404, "not found");
    },
  };
  const sent = () =>
    calls
      .filter((c) => c.path === "/sessions")
      .map((c) => c.body.sessionKey as string);
  const extractCalls = () =>
    calls.filter((c) => c.path.endsWith("/extract")).length;
  return { client, calls, sent, extractCalls, byHash, byId };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function run(
  w: World,
  client: ApiClient | null,
  args: Partial<BackfillArgs> = {},
  deps: Partial<BackfillDeps> = {},
) {
  const lines: string[] = [];
  const done = backfill(
    { yes: true, dryRun: false, undo: false, ...args },
    {
      client,
      cwd: w.repo,
      env: w.env,
      now: () => NOW,
      log: (l) => lines.push(l),
      pid: PID,
      alive: (pid) => pid === PID,
      concurrency: 1,
      ...deps,
    },
  );
  return { lines, done, out: () => lines.join("\n") };
}

// ---------------------------------------------------------------- tests

describe("plan (AC1, AC2, AC3)", () => {
  test("lists sessions per agent, from subdirectories and worktrees, with counts and an estimate, and a dry run sends nothing", async () => {
    const w = world();
    const tree = join(w.base, "app-fix");
    git(w.repo, ["worktree", "add", "-q", "-b", "fix", tree]);
    piSession(w, w.repo, "p1", NOW - 5 * DAY);
    piSession(w, join(w.repo, "packages", "api"), "p2", NOW - 4 * DAY);
    claudeSession(w, tree, "c1", NOW - 3 * DAY);
    codexSession(w, join(w.repo, "web"), "x1", NOW - 2 * DAY);
    // Another repo's session.
    piSession(w, join(w.base, "other"), "o1", NOW - 2 * DAY);
    const api = stubApi();
    const r = run(w, api.client, { dryRun: true, yes: false });
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain(`Backfill for ${w.key}`);
    expect(out).toContain("pi: 2 sessions");
    expect(out).toContain("packages/api");
    expect(out).toContain("Claude Code: 1 session");
    expect(out).toContain("Codex: 1 session");
    expect(out).toContain(
      "4 sessions, 4 pieces. Estimated cost $0.16 on claude-sonnet-5-5.",
    );
    expect(out).toContain("Backfill budget left: $10.00 of $10.00.");
    expect(out).toContain("Dry run: nothing sent.");
    expect(api.sent()).toEqual([]);
    expect(api.extractCalls()).toBe(0);
  });

  test("takes the last 30 days by default, at most 50 sessions, newest kept; --since and --limit change it", async () => {
    const w = world();
    piSession(w, w.repo, "old", NOW - 40 * DAY);
    for (let i = 0; i < 52; i++)
      piSession(
        w,
        w.repo,
        `s${String(i).padStart(2, "0")}`,
        NOW - 20 * DAY + i * HOUR,
      );
    const keys = async (args: Partial<BackfillArgs>) => {
      const api = stubApi({ perPiece: 0 });
      expect(await run(w, api.client, args).done).toBe(0);
      return api.sent();
    };
    const def = await keys({});
    expect(def).toHaveLength(50);
    expect(def[0]).toBe("s02");
    expect(def.at(-1)).toBe("s51");
    const wide = await keys({ since: NOW - 45 * DAY, limit: 100 });
    expect(wide).toHaveLength(53);
    expect(wide[0]).toBe("old");
    expect(await keys({ limit: 3 })).toEqual(["s49", "s50", "s51"]);
  });

  test("sends nothing until the person confirms, and without a terminal only with --yes", async () => {
    const w = world();
    piSession(w, w.repo, "p1", NOW - DAY);
    const api = stubApi();
    const noTty = run(w, api.client, { yes: false });
    expect(await noTty.done).toBe(1);
    expect(noTty.out()).toContain("run it with --yes");
    const asked: string[] = [];
    const no = run(
      w,
      api.client,
      { yes: false },
      {
        confirm: async (m) => {
          asked.push(m);
          return false;
        },
      },
    );
    expect(await no.done).toBe(0);
    expect(asked).toEqual(["Send 1 piece?"]);
    expect(api.sent()).toEqual([]);
    const yes = run(
      w,
      api.client,
      { yes: false },
      { confirm: async () => true },
    );
    expect(await yes.done).toBe(0);
    expect(api.sent()).toEqual(["p1"]);
  });

  test("parses the options and refuses bad ones", () => {
    expect(
      parseBackfillArgs([
        "--since",
        "2026-10-01",
        "--limit",
        "5",
        "--agents",
        "pi,codex",
        "--yes",
        "--dry-run",
      ]),
    ).toEqual({
      since: Date.parse("2026-10-01"),
      limit: 5,
      agents: ["pi", "codex"],
      yes: true,
      dryRun: true,
      undo: false,
    });
    expect(() => parseBackfillArgs(["--limit", "0"])).toThrow(/--limit/);
    expect(() => parseBackfillArgs(["--since", "soon"])).toThrow(/--since/);
    expect(() => parseBackfillArgs(["--agents", "cursor"])).toThrow(/--agents/);
  });
});

describe("run", () => {
  test("AC4, AC9: sends oldest first, one line per piece, ending with sessions, memories and the recorded cost", async () => {
    const w = world();
    piSession(w, w.repo, "b", NOW - 2 * DAY);
    claudeSession(w, w.repo, "a", NOW - 3 * DAY);
    // Two pieces in one session.
    piSession(w, w.repo, "c", NOW - DAY, { chars: 60_000 });
    const costs = [0.031, 0.012, 0.02, 0.007];
    const api = stubApi({
      extract: async (_s, n) => ({
        saved: 2,
        updated: n % 2,
        costUsd: costs[n] ?? 0,
      }),
    });
    const r = run(w, api.client);
    expect(await r.done).toBe(0);
    expect(api.sent()).toEqual(["a", "b", "c", "c"]);
    const pieceLines = r.lines.filter((l) => /^\[\d\/4\]/.test(l));
    expect(pieceLines).toEqual([
      "[1/4] Claude Code 2026-11-17 a.jsonl#1 saved 2, updated 0, $0.03",
      "[2/4] pi 2026-11-18 b.jsonl#1 saved 2, updated 1, $0.01",
      "[3/4] pi 2026-11-19 c.jsonl#1 saved 2, updated 0, $0.02",
      "[4/4] pi 2026-11-19 c.jsonl#2 saved 2, updated 1, $0.01",
    ]);
    expect(r.lines.at(-1)).toBe(
      "Done. Sessions read: 3. Memories saved: 8, updated: 2. Cost: $0.07.",
    );
  });

  test("AC6: skips sessions the hooks sent and ones changed in the last hour; a rerun has nothing new", async () => {
    const w = world();
    piSession(w, w.repo, "done", NOW - 3 * DAY);
    piSession(w, w.repo, "live", NOW - 2 * DAY);
    piSession(w, w.repo, "running", NOW - 2 * HOUR, {
      mtime: NOW - 30 * 60_000,
    });
    const api = stubApi({ live: ["live"] });
    const first = run(w, api.client);
    expect(await first.done).toBe(0);
    expect(api.sent()).toEqual(["done"]);
    expect(first.out()).toContain(
      "Skipped: 1 session the hooks already sent, 1 session changed in the last hour (may still be running).",
    );
    const again = run(w, api.client);
    expect(await again.done).toBe(0);
    expect(again.out()).toContain("1 piece already extracted");
    expect(again.lines.at(-1)).toBe("Nothing new to backfill.");
    expect(api.sent()).toEqual(["done"]);
  });

  test("AC7: shows the budget left and sends only the oldest pieces that fit, saying how many it left out", async () => {
    const w = world();
    for (let i = 0; i < 5; i++)
      piSession(w, w.repo, `s${i}`, NOW - (5 - i) * DAY);
    const api = stubApi({ budget: 10, spent: 9.9, perPiece: 0.04 });
    const r = run(w, api.client);
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain("Backfill budget left: $0.10 of $10.00.");
    expect(out).toContain("2 sessions, 2 pieces. Estimated cost $0.08");
    expect(out).toContain(
      "All 5 new pieces would cost about $0.20, more than is left: the 3 newest pieces are left out.",
    );
    expect(api.sent()).toEqual(["s0", "s1"]);
  });

  test("AC7: with nothing left of the budget it sends nothing", async () => {
    const w = world();
    piSession(w, w.repo, "s0", NOW - DAY);
    const api = stubApi({ budget: 10, spent: 10 });
    const r = run(w, api.client);
    expect(await r.done).toBe(0);
    expect(r.out()).toContain(
      "Nothing fits in what is left of the backfill budget.",
    );
    expect(api.sent()).toEqual([]);
  });

  test("AC8: a budget refusal stops the run after the pieces in flight and says how many weren't sent", async () => {
    const w = world();
    for (let i = 0; i < 6; i++)
      piSession(w, w.repo, `s${i}`, NOW - (6 - i) * DAY);
    const held = [deferred<ExtractReply>(), deferred<ExtractReply>()];
    const third = deferred<void>();
    const api = stubApi({
      extract: async (s) => {
        const key = s.body.sessionKey;
        if (key === "s1") {
          third.resolve();
          throw apiError(402, "backfill budget used up");
        }
        return (key === "s0" ? held[0] : held[1])
          ?.promise as Promise<ExtractReply>;
      },
    });
    const r = run(w, api.client, {}, { concurrency: 3 });
    await third.promise;
    held[0]?.resolve({ saved: 1, updated: 0, costUsd: 0.04 });
    held[1]?.resolve({ saved: 1, updated: 0, costUsd: 0.04 });
    expect(await r.done).toBe(0);
    expect(api.sent()).toEqual(["s0", "s1", "s2"]);
    expect(r.out()).toContain("[2/6] pi");
    expect(r.out()).toContain("not sent: backfill budget used up");
    expect(r.out()).toContain("Memories saved: 2");
    expect(r.out()).toContain(
      "The backfill budget ran out: 4 pieces not sent.",
    );
  });

  test("a piece another request is extracting (409) counts as not sent", async () => {
    const w = world();
    piSession(w, w.repo, "s0", NOW - DAY);
    const api = stubApi({
      extract: async () => {
        throw apiError(409, "piece is being extracted");
      },
    });
    const r = run(w, api.client);
    expect(await r.done).toBe(0);
    expect(api.extractCalls()).toBe(1);
    expect(r.out()).toContain(
      "1 piece not sent: another run was extracting it.",
    );
  });

  test("AC10, AC15: progress is written per piece; a run stopped midway leaves finished pieces and the next run sends the rest", async () => {
    const w = world();
    for (let i = 0; i < 3; i++)
      piSession(w, w.repo, `s${i}`, NOW - (3 - i) * DAY);
    const reached = deferred<void>();
    // The second piece never comes back: the process dies with it in flight.
    const api = stubApi({
      extract: async (s) => {
        if (s.body.sessionKey !== "s1")
          return { saved: 2, updated: 0, costUsd: 0.04 };
        reached.resolve();
        return new Promise<ExtractReply>(() => {});
      },
    });
    let dead = false;
    const alive = (pid: number) => pid === PID && !dead;
    void run(w, api.client, {}, { alive }).done;
    await reached.promise;
    expect(backfillStatus(w.repo, w.env, alive)).toBe(
      "Backfill:  running, 1 of 3 pieces done, 2 memories saved",
    );
    dead = true;
    expect(backfillStatus(w.repo, w.env, alive)).toBe(
      "Backfill:  stopped at 1 of 3 pieces, 2 memories saved. Run impression backfill to send the rest.",
    );
    expect(backfillStatus(w.repo, w.env, alive)).toBeUndefined();

    const api2 = stubApi();
    // The server kept what the first run finished.
    for (const [hash, s] of api.byHash) api2.byHash.set(hash, s);
    for (const [id, s] of api.byId) api2.byId.set(id, s);
    const next = run(
      w,
      api2.client,
      {},
      { pid: PID + 1, alive: (p) => p === PID + 1 },
    );
    expect(await next.done).toBe(0);
    expect(next.out()).toContain("1 piece already extracted");
    expect(api2.sent()).toEqual(["s1", "s2"]);
    expect(backfillStatus(w.repo, w.env, () => false)).toBe(
      "Backfill:  finished, 2 of 2 pieces, 2 memories saved, $0.08",
    );
    expect(backfillStatus(w.repo, w.env, () => false)).toBeUndefined();
  });

  test("AC11: a second backfill for the repo refuses while one runs", async () => {
    const w = world();
    piSession(w, w.repo, "s0", NOW - DAY);
    expect(acquireLock(w.env, w.key, 99, (p) => p === 99)).toBe(true);
    const api = stubApi();
    const r = run(w, api.client, {}, { alive: (p) => p === 99 || p === PID });
    expect(await r.done).toBe(1);
    expect(r.out()).toBe(
      `A backfill is already running for ${w.key}. impression status shows its progress.`,
    );
    expect(api.calls).toEqual([]);
  });

  test("AC12: a failing piece is retried once, then reported failed while the run carries on; the next run sends it again", async () => {
    const w = world();
    for (let i = 0; i < 3; i++)
      piSession(w, w.repo, `s${i}`, NOW - (3 - i) * DAY);
    const tries = new Map<string, number>();
    const api = stubApi({
      extract: async (s) => {
        const key = s.body.sessionKey as string;
        tries.set(key, (tries.get(key) ?? 0) + 1);
        if (key === "s0" && tries.get(key) === 1)
          throw apiError(502, "extraction failed, try again");
        // Fails twice in this run; the next run's try works.
        if (key === "s1" && (tries.get(key) ?? 0) <= 2)
          throw apiError(502, "extraction failed, try again");
        return { saved: 1, updated: 0, costUsd: 0.04 };
      },
    });
    const r = run(w, api.client);
    expect(await r.done).toBe(1);
    expect(Object.fromEntries(tries)).toEqual({ s0: 2, s1: 2, s2: 1 });
    expect(r.out()).toContain("#1 failed: Impression API 502");
    expect(r.out()).toContain(
      "1 piece failed. The next impression backfill sends it again.",
    );
    const sentBefore = api.sent().length;
    const again = run(w, api.client);
    expect(await again.done).toBe(0);
    expect(api.sent().slice(sentBefore)).toEqual(["s1"]);
    expect(again.out()).toContain("2 pieces already extracted");
  });

  test("retries network errors and 5xx, not other 4xx", () => {
    expect(retryable(new Error("fetch failed"))).toBe(true);
    expect(
      retryable(new Error("The operation was aborted due to timeout")),
    ).toBe(true);
    expect(retryable(apiError(502, "x"))).toBe(true);
    expect(retryable(apiError(400, "x"))).toBe(false);
  });

  test("AC13: each piece is anchored at the last commit before its session started", async () => {
    const w = world();
    const mid = commit(w.repo, "2026-11-10T00:00:00Z");
    commit(w.repo, "2026-11-19T00:00:00Z");
    expect(commitBefore(w.repo, Date.parse("2026-08-01T00:00:00Z"))).toBe(
      w.first,
    );
    piSession(w, w.repo, "early", Date.parse("2026-08-15T00:00:00Z"), {
      mtime: NOW - 2 * DAY,
    });
    piSession(w, w.repo, "middle", Date.parse("2026-11-12T00:00:00Z"));
    const api = stubApi();
    expect(await run(w, api.client, { since: 0 }).done).toBe(0);
    const shaOf = (key: string) =>
      api.calls.find((c) => c.path === "/sessions" && c.body.sessionKey === key)
        ?.body;
    expect(shaOf("early")?.commitSha).toBe(w.first);
    expect(shaOf("middle")?.commitSha).toBe(mid);
    expect(shaOf("middle")?.source).toBe("backfill");
    expect(shaOf("middle")?.startedAt).toBe("2026-11-12T00:00:00.000Z");
    expect(shaOf("middle")?.project).toEqual({ key: w.key, name: "app" });
  });

  test("AC14: --undo retires what backfills made and prints how many", async () => {
    const w = world();
    const api = stubApi({ undo: async () => ({ retired: 7 }) });
    const r = run(w, api.client, { undo: true });
    expect(await r.done).toBe(0);
    expect(r.out()).toBe(`Retired 7 memories that backfills made in ${w.key}.`);
    expect(api.calls.map((c) => c.path)).toEqual([
      `/backfill/undo?project=${encodeURIComponent(w.key)}`,
    ]);
    const gone = stubApi({
      undo: async () => {
        throw apiError(404, "project not found");
      },
    });
    const g = run(w, gone.client, { undo: true });
    expect(await g.done).toBe(1);
    expect(g.out()).toContain("no project");
  });

  test("agents/I7: not signed in, it says so and does nothing", async () => {
    const w = world();
    const r = run(w, null);
    expect(await r.done).toBe(1);
    expect(r.out()).toBe(NOT_SIGNED_IN);
    expect(existsSync(progressPath(w.env, w.key))).toBe(false);
  });

  test("outside a git repo it says so", async () => {
    const w = world();
    const r = run(w, stubApi().client, {}, { cwd: w.base });
    expect(await r.done).toBe(1);
    expect(r.out()).toContain("runs in a git repo");
  });

  test("project key is the hooks' key, from a worktree too (agents/I6)", () => {
    const w = world();
    const tree = join(w.base, "app-wt");
    git(w.repo, ["worktree", "add", "-q", "-b", "wt", tree]);
    const repo = findRepo(tree);
    expect(repo?.key).toBe(w.key);
    expect(repo?.checkout).toBe(tree);
    expect(repo?.dirs.sort()).toEqual([w.repo, tree].sort());
  });
});

describe("setup's offer (AC15)", () => {
  const offer = (
    w: World,
    client: ApiClient,
    over: Record<string, unknown> = {},
  ) => {
    const info: string[] = [];
    const asked: string[] = [];
    const started: string[] = [];
    const done = offerBackfill({
      client,
      cwd: w.repo,
      env: w.env,
      now: () => NOW,
      interactive: true,
      info: (t) => info.push(t),
      ask: async (plan) => {
        asked.push(plan);
        return true;
      },
      start: (c) => started.push(c),
      alive: () => false,
      ...over,
    });
    return { info, asked, started, done };
  };

  test("in a repo with past sessions it shows the plan and, on yes, starts the backfill in the background", async () => {
    const w = world();
    piSession(w, w.repo, "s0", NOW - DAY);
    const api = stubApi();
    const o = offer(w, api.client);
    await o.done;
    expect(o.asked[0]).toContain("1 session, 1 piece. Estimated cost $0.04");
    expect(o.asked[0]).toContain("Backfill budget left: $10.00 of $10.00.");
    expect(o.started).toEqual([w.repo]);
    expect(o.info.at(-1)).toContain("impression status shows its progress");
    expect(api.sent()).toEqual([]);
  });

  test("on no it starts nothing", async () => {
    const w = world();
    piSession(w, w.repo, "s0", NOW - DAY);
    const o = offer(w, stubApi().client, { ask: async () => false });
    await o.done;
    expect(o.started).toEqual([]);
    expect(o.info).toEqual(["Skipped. Run impression backfill any time."]);
  });

  test("without a terminal or outside a repo it prints the command instead", async () => {
    const w = world();
    piSession(w, w.repo, "s0", NOW - DAY);
    const api = stubApi();
    const noTty = offer(w, api.client, { interactive: false });
    await noTty.done;
    expect(noTty.info).toEqual([
      "To learn from this repo's past sessions, run: impression backfill",
    ]);
    const outside = offer(w, api.client, { cwd: w.base });
    await outside.done;
    expect(outside.info[0]).toContain("run impression backfill in it");
    expect(api.calls).toEqual([]);
  });

  test("agents/I1: a failing plan prints one line and setup goes on", async () => {
    const w = world();
    piSession(w, w.repo, "s0", NOW - DAY);
    const broken: ApiClient = {
      get: async () => ({}),
      post: async () => {
        throw new Error("fetch failed");
      },
    };
    const o = offer(w, broken);
    await expect(o.done).resolves.toBeUndefined();
    expect(o.info).toEqual([
      "Couldn't plan a backfill (fetch failed). Run impression backfill to try again.",
    ]);
    expect(o.started).toEqual([]);
  });

  test("with nothing new it says nothing, and with a backfill running it says so", async () => {
    const w = world();
    const quiet = offer(w, stubApi().client);
    await quiet.done;
    expect(quiet.info).toEqual([]);
    expect(quiet.asked).toEqual([]);
    piSession(w, w.repo, "s0", NOW - DAY);
    expect(acquireLock(w.env, w.key, 77, () => true)).toBe(true);
    const busy = offer(w, stubApi().client, { alive: () => true });
    await busy.done;
    expect(busy.info[0]).toContain("already running");
  });
});
