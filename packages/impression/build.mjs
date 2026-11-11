// Bundles the CLI and MCP server, with @impression/shared and every other dependency
// inlined, so the published package has no runtime dependencies.
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
