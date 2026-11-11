import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkForUpdate, isNewer } from "./update-check.js";

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "imp-upd-"));
  env = { XDG_CONFIG_HOME: dir };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("update check", () => {
  it("compares versions", () => {
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "0.10.0")).toBe(false);
    expect(isNewer("junk", "0.1.0")).toBe(false);
  });

  it("notices a newer version, then stays quiet from cache for a day", async () => {
    let calls = 0;
    const fetchLatest = async () => {
      calls++;
      return "0.2.0";
    };
    const now = 1_000_000_000;
    expect(await checkForUpdate("0.1.0", { env, now, fetchLatest })).toContain(
      "impression update",
    );
    expect(
      await checkForUpdate("0.1.0", { env, now: now + 1000, fetchLatest }),
    ).toContain("0.2.0");
    expect(calls).toBe(1);
    expect(
      await checkForUpdate("0.1.0", {
        env,
        now: now + 86_400_001,
        fetchLatest,
      }),
    ).toBeDefined();
    expect(calls).toBe(2);
  });

  it("swallows failures, records the attempt, and gives up on a hung lookup", async () => {
    const now = 200_000_000;
    const boom = async () => {
      throw new Error("offline");
    };
    expect(
      await checkForUpdate("0.1.0", { env, now, fetchLatest: boom }),
    ).toBeUndefined();
    expect(
      JSON.parse(
        readFileSync(join(dir, "impression", "update-check.json"), "utf8"),
      ).checkedAt,
    ).toBe(now);
    const hang = (signal: AbortSignal) =>
      new Promise<string | undefined>((_, rej) =>
        signal.addEventListener("abort", () => rej(new Error("abort"))),
      );
    const t = Date.now();
    expect(
      await checkForUpdate("0.1.0", {
        env,
        now: 99_999_999_999,
        timeoutMs: 50,
        fetchLatest: hang,
      }),
    ).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("does nothing without a version or when disabled", async () => {
    const fetchLatest = async () => "9.9.9";
    expect(
      await checkForUpdate(undefined, { env, fetchLatest }),
    ).toBeUndefined();
    expect(
      await checkForUpdate("0.1.0", {
        env: { ...env, IMPRESSION_NO_UPDATE_CHECK: "1" },
        fetchLatest,
      }),
    ).toBeUndefined();
  });
});
