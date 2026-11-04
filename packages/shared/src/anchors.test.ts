import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { summarizeChecks, verifyAnchors } from "./anchors.js";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "impression-anchors-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const git = (...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
let sha: string;

beforeAll(() => {
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/auth.ts"), "export function requireAuth() {}\n");
  writeFileSync(join(dir, "src/db.ts"), "export const pool = 1;\n");
  writeFileSync(join(dir, "src/old.ts"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  sha = git("rev-parse", "HEAD");
});

const check = (a: { path: string; symbol?: string; commitSha?: string }) =>
  verifyAnchors(dir, [{ commitSha: sha, ...a }])[0];

test("an untouched file is ok", () => {
  expect(check({ path: "src/db.ts" })).toEqual({ state: "ok" });
});

test("a deleted file is stale", () => {
  expect(check({ path: "src/nope.ts" })).toMatchObject({
    state: "stale",
    reason: "src/nope.ts no longer exists",
  });
});

test("a changed file without a symbol is stale", () => {
  writeFileSync(join(dir, "src/db.ts"), "export const pool = 2;\n");
  expect(check({ path: "src/db.ts" })).toMatchObject({
    state: "stale",
    reason: expect.stringContaining("changed since"),
  });
});

test("a changed file whose symbol is still there is ok", () => {
  writeFileSync(
    join(dir, "src/auth.ts"),
    "// edited\nexport function requireAuth() {}\n",
  );
  expect(check({ path: "src/auth.ts", symbol: "requireAuth" })).toEqual({
    state: "ok",
  });
});

test("a symbol that was renamed is stale, and partial matches don't count", () => {
  writeFileSync(
    join(dir, "src/auth.ts"),
    "export function requireAuthV2() {}\n",
  );
  expect(check({ path: "src/auth.ts", symbol: "requireAuth" })).toMatchObject({
    state: "stale",
    reason: "requireAuth is no longer in src/auth.ts",
  });
});

test("an unknown commit is unknown, not stale", () => {
  expect(check({ path: "src/db.ts", commitSha: "deadbeefdead" })).toMatchObject(
    { state: "unknown" },
  );
});

test("a missing path is stale even when the commit is unknown", () => {
  expect(check({ path: "gone.ts", commitSha: "deadbeefdead" })?.state).toBe(
    "stale",
  );
});

test("summarizeChecks joins stale reasons and ignores unknowns", () => {
  expect(
    summarizeChecks([
      { state: "ok" },
      { state: "stale", reason: "a" },
      { state: "stale", reason: "b" },
    ]),
  ).toEqual({
    state: "stale",
    reason: "a; b",
  });
  expect(
    summarizeChecks([{ state: "ok" }, { state: "unknown", reason: "u" }]),
  ).toEqual({ state: "ok" });
  expect(summarizeChecks([{ state: "unknown", reason: "u" }])?.state).toBe(
    "unknown",
  );
  expect(summarizeChecks([])).toEqual({ state: "ok" });
});

test("benchmark: 200 anchors verify in well under 100ms", () => {
  git("checkout", "-q", "--", ".");
  const anchors = Array.from({ length: 200 }, (_, i) => ({
    path: i % 3 === 0 ? "src/auth.ts" : "src/db.ts",
    symbol: i % 2 ? "requireAuth" : undefined,
    commitSha: sha,
  }));
  verifyAnchors(dir, anchors); // warm up
  const t0 = performance.now();
  verifyAnchors(dir, anchors);
  const ms = performance.now() - t0;
  console.log(`verifyAnchors(200 anchors): ${ms.toFixed(1)}ms`);
  expect(ms).toBeLessThan(100);
});
