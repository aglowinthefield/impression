#!/usr/bin/env node
import { createSavedClient } from "@impression/shared";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// IMPRESSION_URL and IMPRESSION_TOKEN win; otherwise use what `impression login`
// saved. The client re-reads that after a 401, so a re-login needs no restart.
const server = createServer({
  client: createSavedClient("mcp"),
  cwd: process.cwd(),
});
await server.connect(new StdioServerTransport());
