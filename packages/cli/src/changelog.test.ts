import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changesSince, upgradeNotice } from "./changelog.js";

const changelog = `# Changelog

Intro text.

## 0.4.0

- Fourth, with a [link](https://example.com).

## [0.3.1] - 2026-11-18

- Third.

## 0.3.0

- Second.
- Another second.

## 0.2.0

- First.
`;

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "imp-log-"));
  env = { XDG_CONFIG_HOME: dir };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("changelog notice", () => {
  it("lists the bullets of versions after the old one, up to the new one", () => {
    expect(changesSince(changelog, "0.2.0", "0.3.1")).toEqual([
      "- Third.",
      "- Second.",
      "- Another second.",
    ]);
    expect(changesSince(changelog, "0.3.1", "0.4.0")).toEqual([
      "- Fourth, with a link.",
    ]);
  });

  it("stays quiet on a fresh install, then shows an upgrade once", () => {
    expect(upgradeNotice("0.3.0", { env, changelog })).toBeUndefined();
    const note = upgradeNotice("0.3.1", { env, changelog });
    expect(note).toContain("Impression updated from 0.3.0 to 0.3.1");
    expect(note).toContain("- Third.");
    expect(note).not.toContain("Second");
    expect(upgradeNotice("0.3.1", { env, changelog })).toBeUndefined();
    expect(
      JSON.parse(
        readFileSync(join(dir, "impression", "last-seen-version.json"), "utf8"),
      ),
    ).toEqual({ version: "0.3.1" });
  });

  it("stays quiet on a downgrade, and without a version", () => {
    upgradeNotice("0.4.0", { env, changelog });
    expect(upgradeNotice("0.3.0", { env, changelog })).toBeUndefined();
    expect(upgradeNotice(undefined, { env, changelog })).toBeUndefined();
  });
});
