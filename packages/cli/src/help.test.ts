import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  commandHelp,
  overview,
  suggest,
  unknownCommand,
  usageLine,
} from "./cli-help.js";
import { HIDDEN, help } from "./help.js";

const cli = help("1.2.3");
const plain = { FORCE_COLOR: "0" };

describe("help", () => {
  it("lists exactly the commands bin.ts routes, besides the hidden ones", () => {
    const bin = readFileSync(new URL("./bin.ts", import.meta.url), "utf8");
    const routed = new Set([
      ...[...bin.matchAll(/cmd === "([a-z][a-z-]*)"/g)].map((m) => m[1]),
      ...[
        ...(
          /\[([^\]]*"search"[^\]]*)\]\.includes\(cmd\)/.exec(bin)?.[1] ?? ""
        ).matchAll(/"([a-z-]+)"/g),
      ].map((m) => m[1]),
    ]);
    routed.delete("version"); // an alias of --version
    const listed = [...cli.commands.map((c) => c.name), ...HIDDEN];
    expect([...routed].sort()).toEqual([...new Set(listed)].sort());
  });

  it("prints every command in the overview and has a page for each", () => {
    Object.assign(process.env, plain);
    const text = overview(cli);
    for (const cmd of cli.commands) {
      expect(text).toContain(`  ${cmd.name}`);
      expect(commandHelp(cli, cmd.name)).toContain(`impression ${cmd.name}`);
    }
    for (const name of HIDDEN)
      expect(text).not.toMatch(new RegExp(`^  ${name}\\b`, "m"));
    expect(text).not.toContain("\u001b[");
  });

  it("colours headings cyan and arguments blue, leaving commands plain", () => {
    process.env.FORCE_COLOR = "1";
    try {
      const text = overview(cli);
      expect(text).toContain("\u001b[1;36mMemories\u001b[0m");
      expect(text).toContain("  search\u001b[34m QUERY...");
    } finally {
      process.env.FORCE_COLOR = "0";
    }
  });

  it("suggests the nearest command for a typo", () => {
    expect(suggest(cli, "serach")).toBe("search");
    expect(suggest(cli, "stauts")).toBe("status");
    expect(suggest(cli, "zzzzzzzz")).toBeUndefined();
    expect(unknownCommand(cli, "lsit")).toBe(
      "impression: Unknown command: lsit. Did you mean list? Run impression help to see them all.",
    );
  });

  it("gives a usage line for argument errors", () => {
    expect(usageLine(cli, "edit")).toBe("Usage: impression edit ID TEXT...");
    expect(usageLine(cli, "add")).toBe(
      "Usage: impression add TEXT... [--user]",
    );
  });
});
