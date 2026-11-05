import { expect, test } from "vitest";
import {
  injectedMemories,
  parseSession,
  sessionHeader,
  summarize,
} from "./pi-session.js";

const line = (o: unknown) => JSON.stringify(o);
const log = [
  line({
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: "how do I build" }],
    },
  }),
  line({
    type: "custom_message",
    customType: "impression",
    content:
      "Memories from Impression that match this prompt:\n- Run pnpm install first\n- Use tsrs",
  }),
  line({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Run pnpm install first." }],
    },
  }),
  line({ type: "message", message: { role: "user", content: "yes" } }),
  line({ type: "custom_message", customType: "other", content: "- ignored" }),
  "not json",
].join("\n");

test("pairs each user prompt with the memories injected after it", () => {
  const turns = parseSession(log);
  expect(turns).toHaveLength(2);
  expect(turns[0]).toEqual({
    index: 0,
    at: null,
    prompt: "how do I build",
    injected: ["Run pnpm install first", "Use tsrs"],
    reply: "Run pnpm install first.",
  });
  expect(turns[1]?.injected).toEqual([]);
});

test("counts how often each memory surfaced", () => {
  const r = summarize(parseSession(log));
  expect(r.prompts).toBe(2);
  expect(r.withMemories).toBe(1);
  expect(r.counts.get("Use tsrs")).toBe(1);
});

test("injectedMemories keeps only bullet lines", () => {
  expect(injectedMemories("header\n- a\nnot a bullet\n- b")).toEqual([
    "a",
    "b",
  ]);
});

test("sessionHeader reads the first line", () => {
  expect(
    sessionHeader(
      '{"type":"session","id":"s1","cwd":"/a/b"}\n{"type":"message"}',
    ),
  ).toEqual({ id: "s1", cwd: "/a/b" });
  expect(sessionHeader("garbage")).toBeNull();
});
