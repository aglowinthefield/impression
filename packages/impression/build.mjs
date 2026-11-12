// Bundles the CLI and MCP server, with @impression/shared and every other dependency
// inlined, so the published package has no runtime dependencies.
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
rmSync("dist", { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  alias: { "@impression/shared": "../shared/src/index.ts" },
  define: { __IMPRESSION_VERSION__: JSON.stringify(pkg.version) },
  // Bundled CommonJS dependencies call require(); give ESM output one.
  banner: {
    js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
  },
  logLevel: "warning",
};

await build({
  ...common,
  entryPoints: {
    impression: "../cli/src/bin.ts",
    "impression-mcp": "../mcp/src/bin.ts",
    lib: "../cli/src/lib.ts",
  },
  outdir: "dist",
});

mkdirSync("pi", { recursive: true });
copyFileSync("../pi/impression.ts", "pi/impression.ts");
copyFileSync("../../LICENSE", "LICENSE");
copyFileSync("../../README.md", "README.md");

// Plugin files for Claude Code and Codex. Both install this npm package as the plugin
// root and only fetch a new copy when the manifest version changes, so the version
// comes from package.json. Hooks and MCP run the bundled JS with node from the
// plugin's own directory, never an `impression` on PATH.
const meta = {
  name: "impression",
  version: pkg.version,
  description:
    "Memories from your Impression server at session start and on each prompt, and the session sent back for review when it ends.",
  author: { name: "aglowinthefield" },
  homepage: pkg.homepage,
  repository: "https://github.com/aglowinthefield/impression",
  license: pkg.license,
};

/** A hooks file running `impression hook <sub> --agent <agent>` from `root`. */
const hooks = (agent, root, events) => ({
  hooks: Object.fromEntries(
    events.map(([event, sub, timeout, matcher]) => [
      event,
      [
        {
          ...(matcher ? { matcher } : {}),
          hooks: [
            {
              type: "command",
              command: `node "${root}/dist/impression.js" hook ${sub} --agent ${agent}`,
              timeout,
            },
          ],
        },
      ],
    ]),
  ),
});

const events = [
  ["SessionStart", "session-start", 10, "startup|resume|clear|compact"],
  ["UserPromptSubmit", "prompt", 5],
  ["SessionEnd", "session-end --extract", 3],
];

const write = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

write(".claude-plugin/plugin.json", {
  ...meta,
  hooks: "./hooks/claude.json",
  mcpServers: "./.mcp.json",
});
write("hooks/claude.json", hooks("claude", "${CLAUDE_PLUGIN_ROOT}", events));
write(".mcp.json", {
  mcpServers: {
    impression: {
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/dist/impression-mcp.js"],
    },
  },
});

// Codex sets PLUGIN_ROOT for hooks but doesn't expand variables in MCP config, where
// paths are relative to the plugin root.
write(".codex-plugin/plugin.json", {
  ...meta,
  hooks: "./hooks/codex.json",
  mcpServers: "./.codex-plugin/mcp.json",
  interface: { displayName: "Impression", category: "Productivity" },
});
write("hooks/codex.json", hooks("codex", "${PLUGIN_ROOT}", events));
write(".codex-plugin/mcp.json", {
  mcpServers: {
    impression: {
      command: "node",
      args: ["./dist/impression-mcp.js"],
      cwd: ".",
    },
  },
});
