import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLI_INSTALL,
  cliOnPath,
  offerGlobalCli,
  runCommand,
} from "./global-cli.js";

describe("runCommand", () => {
  it("runs the line through the shell on Windows, where npm is a .cmd shim", () => {
    const r = runCommand("echo", ["a", "b"], {}, true);
    expect(r.error).toBeUndefined();
    expect(r.stdout.trim()).toBe("a b");
  });
});

describe("cliOnPath", () => {
  const has =
    (...files: string[]) =>
    (f: string) =>
      files.includes(f);

  it("finds impression in a PATH directory", () => {
    const env = { PATH: ["/usr/bin", "/home/me/.npm-global/bin"].join(":") };
    expect(
      cliOnPath(
        env,
        has(join("/home/me/.npm-global/bin", "impression")),
        false,
      ),
    ).toBe(true);
    expect(cliOnPath(env, has(), false)).toBe(false);
    expect(cliOnPath({}, has(), false)).toBe(false);
  });

  it("ignores npx's temporary bin directory", () => {
    const npx = "/home/me/.npm/_npx/abc123/node_modules/.bin";
    expect(
      cliOnPath(
        { PATH: `${npx}:/usr/bin` },
        has(join(npx, "impression")),
        false,
      ),
    ).toBe(false);
  });

  it("looks for the .cmd shim on Windows", () => {
    const dir = "C:\\npm";
    expect(
      cliOnPath({ Path: dir }, has(join(dir, "impression.cmd")), true),
    ).toBe(true);
  });
});

describe("offerGlobalCli", () => {
  const recorder = (ok: boolean) => {
    const runs: string[][] = [];
    return {
      runs,
      install: (c: string, a: string[]) => {
        runs.push([c, ...a]);
        return ok;
      },
    };
  };

  it("does nothing when the command is already on PATH", async () => {
    const r = recorder(true);
    expect(await offerGlobalCli({ onPath: true, install: r.install })).toBe(
      undefined,
    );
    expect(r.runs).toEqual([]);
  });

  it("installs without asking when setup runs without questions", async () => {
    const r = recorder(true);
    expect(await offerGlobalCli({ onPath: false, install: r.install })).toMatch(
      /installed/,
    );
    expect(r.runs).toEqual([CLI_INSTALL.flat()]);
  });

  it("asks, and prints the command when declined or failed", async () => {
    const declined = recorder(true);
    expect(
      await offerGlobalCli({
        onPath: false,
        ask: async () => false,
        install: declined.install,
      }),
    ).toMatch(/skipped.*npm i -g @aglowinthefield\/impression/);
    expect(declined.runs).toEqual([]);

    const failed = recorder(false);
    expect(
      await offerGlobalCli({
        onPath: false,
        ask: async () => true,
        install: failed.install,
      }),
    ).toMatch(/failed.*npm i -g @aglowinthefield\/impression/);
    expect(failed.runs).toHaveLength(1);
  });

  it("only names the command on a dry run", async () => {
    const r = recorder(true);
    expect(
      await offerGlobalCli({ onPath: false, dryRun: true, install: r.install }),
    ).toBe("cli: would run npm i -g @aglowinthefield/impression");
    expect(r.runs).toEqual([]);
  });
});
