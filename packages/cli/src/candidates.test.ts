import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { projectCandidates, toolTouches } from "./candidates.js";
import { entries, sendSession } from "./session-end.js";

const lines = (...es: unknown[]) => es.map((e) => JSON.stringify(e)).join("\n");
const touches = (...es: unknown[]) =>
  toolTouches(entries(lines(...es))).map((t) => `${t.kind} ${t.path}`);

describe("toolTouches, per format", () => {
  test("pi: read, edit, write, bash cd and codemode", () => {
    const call = (name: string, args: unknown) => ({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t", name, arguments: args }],
      },
    });
    expect(
      touches(
        call("read", { path: "/r/a.ts", offset: null, limit: null }),
        call("edit", { path: "/r/b.ts", edits: [] }),
        call("write", { path: "src/c.ts", content: "x" }),
        call("bash", { command: "cd /other && git status; rg x /lib/y.ts" }),
        call("codemode", {
          code: 'await tools.edit({ path: "/w/e.ts", edits: [] }); await tools.read({path:"/w/f.ts"})',
        }),
        call("compress", { content: "mentions /noise/path.ts" }),
      ),
    ).toEqual([
      "read /r/a.ts",
      "edit /r/b.ts",
      "edit src/c.ts",
      "edit /other",
      "read /lib/y.ts",
      "edit /w/e.ts",
      "read /w/f.ts",
    ]);
  });

  test("Claude Code and Cursor tool_use blocks", () => {
    const use = (name: string, input: unknown, role?: string) => ({
      ...(role ? { role } : { type: "assistant" }),
      message: { content: [{ type: "tool_use", name, input }] },
    });
    expect(
      touches(
        use("Read", { file_path: "/r/a.ts" }),
        use("Edit", { file_path: "/r/b.ts", old_string: "", new_string: "" }),
        use("Bash", { command: 'cd "/x y" && pnpm test', description: "t" }),
        use("StrReplace", { path: "/c/d.ts" }, "assistant"),
        use("Shell", { command: "ls", working_directory: "/c" }, "assistant"),
      ),
    ).toEqual([
      "read /r/a.ts",
      "edit /r/b.ts",
      "edit /x y",
      "edit /c/d.ts",
      "edit /c",
    ]);
  });

  test("Codex: shell, exec_command, apply_patch and local shell", () => {
    const item = (payload: unknown) => ({ type: "response_item", payload });
    expect(
      touches(
        item({
          type: "function_call",
          name: "shell",
          arguments: JSON.stringify({
            command: ["bash", "-lc", "git -C /g log"],
            workdir: "/w",
          }),
        }),
        item({
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "cat /r/x.md", workdir: "/e" }),
        }),
        item({
          type: "custom_tool_call",
          name: "apply_patch",
          input:
            "*** Begin Patch\n*** Update File: /p/a.ts\n@@\n*** Add File: b.ts\n*** End Patch",
        }),
        item({
          type: "local_shell_call",
          action: { command: ["ls"], working_directory: "/l" },
        }),
      ),
    ).toEqual([
      "edit /w",
      "edit /g",
      "edit /e",
      "read /r/x.md",
      "edit /p/a.ts",
      "edit b.ts",
      "edit /l",
    ]);
  });

  test("Gemini toolCalls and Copilot events", () => {
    expect(
      touches(
        {
          id: "1",
          type: "gemini",
          content: "ok",
          toolCalls: [
            { name: "read_file", args: { absolute_path: "/g/a.ts" } },
            { name: "replace", args: { file_path: "/g/b.ts" } },
            {
              name: "run_shell_command",
              args: { command: "make", directory: "/g" },
            },
          ],
        },
        {
          type: "tool.execution_start",
          data: { toolName: "view", arguments: { path: "/c/a.ts" } },
        },
        {
          type: "tool.execution_start",
          data: {
            toolName: "str_replace_editor",
            arguments: { command: "create", path: "/c/b.ts" },
          },
        },
        {
          type: "tool.execution_start",
          data: { toolName: "bash", arguments: { command: "cd /c && make" } },
        },
      ),
    ).toEqual([
      "read /g/a.ts",
      "edit /g/b.ts",
      "edit /g",
      "read /c/a.ts",
      "edit /c/b.ts",
      "edit /c",
    ]);
  });

  test("URLs and cd to variables aren't paths", () => {
    expect(
      touches({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: 'curl https://x.dev/a; cd "$DIR"; cd -' },
            },
          ],
        },
      }),
    ).toEqual([]);
  });
});

function repo(root: string, name: string, remote?: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  if (remote) git("remote", "add", "origin", remote);
  writeFileSync(join(dir, "src", "a.ts"), "x");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "i");
  return dir;
}

const piCall = (name: string, args: unknown) => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id: "t", name, arguments: args }],
  },
});

function drift() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "imp-cand-")));
  const home = repo(root, "impression", "git@github.com:acme/impression.git");
  const other = repo(root, "silk", "https://github.com/acme/silk.git");
  const local = repo(root, "scratch");
  const raw = lines(
    { type: "session", cwd: home },
    { type: "message", message: { role: "user", content: "look at silk" } },
    piCall("read", { path: "AGENTS.md" }),
    piCall("bash", { command: `cd ${other} && git log -3` }),
    piCall("edit", { path: join(other, "src", "a.ts"), edits: [] }),
    piCall("write", { path: join(other, "src", "new", "b.ts"), content: "" }),
    piCall("read", { path: join(local, "src", "a.ts") }),
    piCall("read", { path: join(root, "gone", "x.ts") }),
  );
  return { root, home, other, local, raw };
}

describe("projectCandidates", () => {
  test("a pi session that starts in one repo and edits another", () => {
    const { home, other, raw } = drift();
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: other,
      encoding: "utf8",
    }).trim();
    expect(
      projectCandidates(entries(raw), home, "github.com/acme/impression"),
    ).toEqual([
      {
        key: "github.com/acme/silk",
        name: "silk",
        headSha: sha,
        edits: 3,
        reads: 0,
        files: ["src/a.ts", "src/new/b.ts"],
      },
      {
        key: "github.com/acme/impression",
        name: "impression",
        headSha: expect.stringMatching(/^[0-9a-f]{40}$/),
        edits: 0,
        reads: 1,
        files: ["AGENTS.md"],
      },
    ]);
  });

  test("a session that stays in its repo sends none", () => {
    const { home } = drift();
    const raw = lines(
      piCall("edit", { path: "src/a.ts", edits: [] }),
      piCall("bash", { command: `cd ${home}` }),
    );
    expect(
      projectCandidates(entries(raw), home, "github.com/acme/impression"),
    ).toEqual([]);
  });

  test("reading another repo counts as reads only", () => {
    const { home, other } = drift();
    const raw = lines(
      piCall("read", { path: join(other, "src", "a.ts") }),
      piCall("bash", { command: `rg foo ${other}/src` }),
    );
    expect(
      projectCandidates(entries(raw), home, "github.com/acme/impression"),
    ).toEqual([
      expect.objectContaining({
        key: "github.com/acme/silk",
        edits: 0,
        reads: 2,
        files: ["src/a.ts"],
      }),
    ]);
  });

  test("sendSession uploads candidates beside the session project", async () => {
    const { home, raw } = drift();
    const file = join(home, "t.jsonl");
    writeFileSync(file, raw);
    const calls: unknown[] = [];
    await sendSession(
      {
        get: async () => null,
        post: async (_p, b) => {
          calls.push(b);
          return { id: "s1" };
        },
      },
      { transcript_path: file, cwd: home },
    );
    expect(calls[0]).toMatchObject({
      project: { key: "github.com/acme/impression" },
      candidates: [
        { key: "github.com/acme/silk", edits: 3 },
        { key: "github.com/acme/impression", reads: 1 },
      ],
    });
  });
});
