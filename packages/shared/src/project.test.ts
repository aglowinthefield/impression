import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { normalizeRemoteUrl, resolveProject } from "./project.js";

describe("normalizeRemoteUrl", () => {
  test.each([
    ["git@github.com:acme/app.git", "github.com/acme/app"],
    ["git@github.com:acme/app", "github.com/acme/app"],
    ["https://github.com/acme/app.git", "github.com/acme/app"],
    ["https://github.com/acme/app/", "github.com/acme/app"],
    ["https://user:token@github.com/acme/app.git", "github.com/acme/app"],
    ["ssh://git@github.com/acme/app.git", "github.com/acme/app"],
    ["ssh://git@github.com:22/acme/app.git", "github.com/acme/app"],
    ["https://GitHub.com/acme/app", "github.com/acme/app"],
    ["https://gitlab.com/group/sub/app.git", "gitlab.com/group/sub/app"],
    ["github.com:acme/app.git", "github.com/acme/app"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeRemoteUrl(input)).toBe(expected);
  });

  test("keeps owner and repo case, since some hosts are case-sensitive", () => {
    expect(normalizeRemoteUrl("git@github.com:Acme/App.git")).toBe(
      "github.com/Acme/App",
    );
  });

  test.each(["", "   ", "not a url", "file:///srv/repos/app.git"])(
    "returns null for %j",
    (input) => {
      expect(normalizeRemoteUrl(input)).toBeNull();
    },
  );
});

describe("resolveProject", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "impression-")));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "ignore" });

  function repo(name: string, remote?: string) {
    const dir = join(base, name);
    mkdirSync(dir);
    run(dir, "init", "-q", "-b", "main");
    run(
      dir,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    if (remote) run(dir, "remote", "add", "origin", remote);
    return dir;
  }

  test("a clone over ssh and a clone over https share a key", () => {
    const a = repo("clone-a", "git@github.com:acme/app.git");
    const b = repo("clone-b", "https://github.com/acme/app");
    expect(resolveProject(a).key).toBe("github.com/acme/app");
    expect(resolveProject(b).key).toBe(resolveProject(a).key);
  });

  test("a worktree shares the key of its repo", () => {
    const main = repo("with-wt", "git@github.com:acme/wt.git");
    const wt = join(base, "with-wt-feature");
    run(main, "worktree", "add", "-q", wt, "-b", "feature");
    expect(resolveProject(wt).key).toBe("github.com/acme/wt");
    expect(resolveProject(wt).pathPrefix).toBeNull();
  });

  test("without a remote, the key is the main checkout path, shared by worktrees", () => {
    const main = repo("no-remote");
    const wt = join(base, "no-remote-feature");
    run(main, "worktree", "add", "-q", wt, "-b", "feature");
    expect(resolveProject(main).key).toBe(`path:${main}`);
    expect(resolveProject(wt).key).toBe(`path:${main}`);
  });

  test("uses a non-origin remote when there is no origin", () => {
    const dir = repo("upstream-only");
    run(dir, "remote", "add", "upstream", "git@github.com:acme/up.git");
    expect(resolveProject(dir).key).toBe("github.com/acme/up");
  });

  test("a subdirectory narrows with a path prefix but keeps the project key", () => {
    const dir = repo("mono", "git@github.com:acme/mono.git");
    const pkg = join(dir, "packages", "api");
    mkdirSync(pkg, { recursive: true });
    expect(resolveProject(pkg)).toMatchObject({
      key: "github.com/acme/mono",
      name: "mono",
      pathPrefix: "packages/api",
    });
    expect(resolveProject(dir).pathPrefix).toBeNull();
  });

  test("outside a git repo, the key is the directory path", () => {
    const dir = join(base, "plain");
    mkdirSync(dir);
    expect(resolveProject(dir)).toEqual({
      key: `path:${dir}`,
      name: "plain",
      pathPrefix: null,
    });
  });
});
