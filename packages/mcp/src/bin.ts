#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "./client.js";
import { createServer } from "./server.js";

const token = process.env.IMPRESSION_TOKEN;
if (!token) {
  console.error("IMPRESSION_TOKEN is required");
  process.exit(1);
}
const server = createServer({
  client: createClient(
    process.env.IMPRESSION_URL ?? "http://localhost:3000",
    token,
  ),
  cwd: process.cwd(),
});
await server.connect(new StdioServerTransport());
