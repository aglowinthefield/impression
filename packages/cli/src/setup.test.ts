import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_INSTALL,
  CODEX_INSTALL,
  formatSetup,
  oldHookFiles,
  PI_PACKAGE,
  setup,
} from "./setup.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "imp-setup-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const json = (...p: string[]) =>
  JSON.parse(readFileSync(join(home, ...p), "utf8"));
const put = (rel: string, text: string) => {
  const f = join(home, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, text);
};

describe("setup", () => {
  it("reports when no harness is installed", () => {
    const r = setup({ home });
    expect(r.changes).toEqual([]);
    expect(r.missing).toEqual(["claude", "pi", "codex"]);
    expect(formatSetup(r)).toContain("No supported harness found.");
  });

  it("removes Claude Code hooks and MCP an earlier setup wrote, keeping the rest", () => {
    const other = { type: "command", command: "echo hi" };
    const hook = (command: string) => ({
      hooks: [{ type: "command", command }],
    });
    put(
      ".claude/settings.json",
      JSON.stringify({
        theme: "dark",
        hooks: {
          SessionStart: [
            { hooks: [other] },
            hook("impression hook session-start"),
            hook(
              "node /x/impression/packages/cli/dist/bin.js hook session-start",
            ),
          ],
          SessionEnd: [
            hook("impression hook session-end --extract --agent claude"),
          ],
          Stop: [],
        },
      }),
    );
    put(
      ".claude.json",
      JSON.stringify({
        projects: { a: 1 },
        mcpServers: {
          x: { command: "x" },
          impression: { type: "stdio", command: "impression-mcp", args: [] },
        },
      }),
    );
    const r = setup({ home, stamp: "t" });
    const s = json(".claude", "settings.json");
    expect(s.theme).toBe("dark");
    expect(s.hooks).toEqual({ SessionStart: [{ hooks: [other] }], Stop: [] });
    const c = json(".claude.json");
    expect(c.projects).toEqual({ a: 1 });
    expect(c.mcpServers).toEqual({ x: { command: "x" } });
    expect(
      existsSync(join(home, ".claude", "settings.json.impression-backup-t")),
    ).toBe(true);
    expect(r.notes.join()).toContain(CLAUDE_INSTALL[1]);
  });

  it("is idempotent: a second run changes and backs up nothing", () => {
    put(".claude/settings.json", "{}");
    put(".pi/agent/settings.json", "{}");
    put(".codex/config.toml", "[features]\nhooks = true\n");
    setup({ home, stamp: "1" });
    const files = () => readdirSync(home, { recursive: true }).sort().join();
    const before = files();
    const second = setup({ home, stamp: "2" });
    expect(second.changes.every((c) => c.status === "unchanged")).toBe(true);
    expect(second.backups).toEqual([]);
    expect(files()).toBe(before);
  });

  it("keeps an impression MCP entry someone pointed elsewhere", () => {
    const mine = { command: "node", args: ["/x/bin.js"] };
    put(".claude/settings.json", "{}");
    put(".claude.json", JSON.stringify({ mcpServers: { impression: mine } }));
    setup({ home });
    expect(json(".claude.json").mcpServers.impression).toEqual(mine);
  });

  it("adds the pi package and removes the extension path and MCP entry an earlier setup wrote", () => {
    put(
      ".pi/agent/settings.json",
      JSON.stringify({
        extensions: [
          "/other/ext.ts",
          "/old/impression/packages/pi/impression.ts",
        ],
        packages: ["npm:other"],
        theme: "x",
      }),
    );
    put(
      ".pi/agent/mcp.json",
      JSON.stringify({
        mcpServers: {
          Neon: { url: "u" },
          impression: { command: "impression-mcp" },
        },
      }),
    );
    const r = setup({ home });
    expect(json(".pi", "agent", "settings.json")).toEqual({
      extensions: ["/other/ext.ts"],
      packages: ["npm:other", PI_PACKAGE],
      theme: "x",
    });
    expect(json(".pi", "agent", "mcp.json").mcpServers).toEqual({
      Neon: { url: "u" },
    });
    expect(r.changes.map((c) => `${c.what} ${c.status}`)).toEqual([
      "package added",
      "old extension path removed",
      "old MCP server removed",
    ]);
  });

  it("keeps a pinned or object pi package entry and a custom MCP entry", () => {
    put(
      ".pi/agent/settings.json",
      JSON.stringify({ packages: [{ source: `${PI_PACKAGE}@0.1.3` }] }),
    );
    put(
      ".pi/agent/mcp.json",
      JSON.stringify({ mcpServers: { impression: { url: "https://x/mcp" } } }),
    );
    const r = setup({ home });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]?.status).toBe("unchanged");
    expect(json(".pi", "agent", "mcp.json").mcpServers.impression).toEqual({
      url: "https://x/mcp",
    });
  });

  it("removes Codex hooks and the MCP table an earlier setup wrote", () => {
    put(
      ".codex/config.toml",
      '[features]\nhooks = true\n\n[mcp_servers.impression]\ncommand = "impression-mcp"\n\n[mcp_servers.a]\ncommand = "a"\n',
    );
    put(
      ".codex/hooks.json",
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: "command", command: "impression hook session-start" },
              ],
            },
          ],
          Stop: [],
        },
      }),
    );
    const r = setup({ home });
    expect(json(".codex", "hooks.json")).toEqual({ hooks: { Stop: [] } });
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(
      '[features]\nhooks = true\n\n[mcp_servers.a]\ncommand = "a"\n',
    );
    expect(r.notes.join()).toContain(CODEX_INSTALL[1]);
  });

  it("--dry-run writes nothing; --only limits the harness", () => {
    put(".claude/settings.json", "{}");
    put(".pi/agent/settings.json", "{}");
    const dry = setup({ home, dryRun: true });
    expect(dry.changes.length).toBeGreaterThan(0);
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(
      "{}",
    );
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    expect(formatSetup(dry, true)).toContain("would be added");
    expect(existsSync(join(home, ".pi", "agent", "settings.json"))).toBe(true);
    expect(
      readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"),
    ).toBe("{}");

    const only = setup({ home, only: "pi" });
    expect(only.changes.every((c) => c.harness === "pi")).toBe(true);
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(
      "{}",
    );
  });

  it("refuses to touch a file that isn't valid JSON", () => {
    put(".claude/settings.json", "{ nope");
    expect(() => setup({ home })).toThrow();
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(
      "{ nope",
    );
  });
});

describe("oldHookFiles", () => {
  it("finds files still holding Impression hooks", () => {
    const home = mkdtempSync(join(tmpdir(), "imp-old-"));
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".codex"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        command: "impression hook session-start --agent claude",
      }),
    );
    writeFileSync(
      join(home, ".codex", "hooks.json"),
      JSON.stringify({ command: "petdex hook session-start" }),
    );
    expect(oldHookFiles(home)).toEqual([
      join(home, ".claude", "settings.json"),
    ]);
  });
});
