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
import { formatSetup, setup } from "./setup.js";

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
const EXT = "/pkg/pi/impression.ts";

describe("setup", () => {
  it("reports when no harness is installed", () => {
    const r = setup({ home });
    expect(r.changes).toEqual([]);
    expect(r.missing).toEqual(["claude", "pi", "codex"]);
    expect(formatSetup(r)).toContain("No supported harness found.");
  });

  it("writes Claude Code hooks and MCP, keeping other settings", () => {
    const other = { hooks: [{ type: "command", command: "echo hi" }] };
    put(
      ".claude/settings.json",
      JSON.stringify({
        theme: "dark",
        hooks: { SessionStart: [{ hooks: [other.hooks[0]] }], Stop: [] },
      }),
    );
    put(
      ".claude.json",
      JSON.stringify({
        projects: { a: 1 },
        mcpServers: { x: { command: "x" } },
      }),
    );
    setup({ home, stamp: "t" });
    const s = json(".claude", "settings.json");
    expect(s.theme).toBe("dark");
    expect(s.hooks.Stop).toEqual([]);
    expect(s.hooks.SessionStart).toHaveLength(2);
    expect(s.hooks.SessionStart[1].hooks[0].command).toBe(
      "impression hook session-start",
    );
    expect(s.hooks.SessionEnd[0].hooks[0].command).toBe(
      "impression hook session-end --extract",
    );
    const c = json(".claude.json");
    expect(c.projects).toEqual({ a: 1 });
    expect(c.mcpServers.x).toEqual({ command: "x" });
    expect(c.mcpServers.impression.command).toBe("impression-mcp");
    expect(
      existsSync(join(home, ".claude", "settings.json.impression-backup-t")),
    ).toBe(true);
    expect(existsSync(join(home, ".claude.json.impression-backup-t"))).toBe(
      true,
    );
  });

  it("is idempotent: a second run changes and backs up nothing", () => {
    put(".claude/settings.json", "{}");
    put(".pi/agent/settings.json", "{}");
    put(".codex/config.toml", "[features]\nhooks = true\n");
    setup({ home, piExtension: EXT, stamp: "1" });
    const files = () => readdirSync(home, { recursive: true }).sort().join();
    const before = files();
    const second = setup({ home, piExtension: EXT, stamp: "2" });
    expect(second.changes.every((c) => c.status === "unchanged")).toBe(true);
    expect(second.backups).toEqual([]);
    expect(files()).toBe(before);
  });

  it("rewrites an old checkout hook and MCP entry instead of adding a second", () => {
    put(
      ".claude/settings.json",
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command:
                    "node /x/impression/packages/cli/dist/bin.js hook session-start",
                },
              ],
            },
          ],
        },
      }),
    );
    put(
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          impression: {
            type: "stdio",
            command: "node",
            args: ["/x/bin.js"],
            env: { A: "1" },
          },
        },
      }),
    );
    setup({ home });
    expect(json(".claude", "settings.json").hooks.SessionStart).toHaveLength(1);
    expect(
      json(".claude", "settings.json").hooks.SessionStart[0].hooks[0].command,
    ).toBe("impression hook session-start");
    expect(json(".claude.json").mcpServers.impression).toEqual({
      type: "stdio",
      command: "impression-mcp",
      args: [],
      env: { A: "1" },
    });
  });

  it("registers the pi extension once, replacing an older path, and the pi MCP server", () => {
    put(
      ".pi/agent/settings.json",
      JSON.stringify({
        extensions: [
          "/other/ext.ts",
          "/old/impression/packages/pi/impression.ts",
        ],
        theme: "x",
      }),
    );
    put(
      ".pi/agent/mcp.json",
      JSON.stringify({ mcpServers: { Neon: { url: "u" } } }),
    );
    setup({ home, piExtension: EXT });
    expect(json(".pi", "agent", "settings.json")).toEqual({
      extensions: ["/other/ext.ts", EXT],
      theme: "x",
    });
    expect(json(".pi", "agent", "mcp.json").mcpServers).toEqual({
      Neon: { url: "u" },
      impression: { command: "impression-mcp" },
    });
  });

  it("writes Codex hooks.json and appends an MCP table to config.toml", () => {
    put(
      ".codex/config.toml",
      '[features]\nhooks = true\n\n[mcp_servers.a]\ncommand = "a"',
    );
    put(".codex/hooks.json", JSON.stringify({ hooks: { Stop: [] } }));
    const r = setup({ home });
    expect(
      json(".codex", "hooks.json").hooks.SessionStart[0].hooks[0].command,
    ).toBe("impression hook session-start");
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain(
      '[mcp_servers.a]\ncommand = "a"\n\n[mcp_servers.impression]\ncommand = "impression-mcp"\n',
    );
    expect(r.notes).toEqual([]);
  });

  it("notes when Codex hooks are not enabled", () => {
    put(".codex/config.toml", "");
    expect(setup({ home }).notes.join()).toContain("hooks = true");
  });

  it("--dry-run writes nothing; --only limits the harness", () => {
    put(".claude/settings.json", "{}");
    put(".pi/agent/settings.json", "{}");
    const dry = setup({ home, dryRun: true, piExtension: EXT });
    expect(dry.changes.length).toBeGreaterThan(0);
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(
      "{}",
    );
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    expect(formatSetup(dry, true)).toContain("would be added");

    const only = setup({ home, only: "pi", piExtension: EXT });
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
