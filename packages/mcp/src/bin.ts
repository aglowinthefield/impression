#!/usr/bin/env node
import { createClient, loadConfig } from "@impression/shared";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// IMPRESSION_URL and IMPRESSION_TOKEN win; otherwise use what `impression login` saved.
const { url, token } = loadConfig();
if (!token) {
  console.error("Not signed in. Run: impression login --github");
  process.exit(1);
}
const server = createServer({
  client: createClient(url, token),
  cwd: process.cwd(),
});
await server.connect(new StdioServerTransport());
