// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Tokens } from "./Tokens";

const hoursAgo = (h: number) =>
  new Date(Date.now() - h * 3_600_000).toISOString();
const token = (o = {}) => ({
  id: "t1",
  name: "tom",
  source: "cli",
  current: false,
  createdAt: hoursAgo(100),
  revokedAt: null,
  lastUsedAt: hoursAgo(2),
  lastClient: "pi/0.3.0 (tom-mini)",
  lastIp: "203.0.113.7",
  lastRejectedAt: null,
  lastRejectedClient: null,
  lastRejectedIp: null,
  ...o,
});
let items: unknown[] = [];
let calls: { url: string; method: string }[] = [];
beforeEach(() => {
  calls = [];
  localStorage.setItem("impression.token", "t");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET" });
      return new Response(
        JSON.stringify(init.method === "POST" ? {} : { items }),
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("lists where each token was last used and revokes one", async () => {
  items = [
    token({ id: "web", source: "web", current: true, lastClient: "web" }),
    token(),
    token({
      id: "old",
      name: "me",
      source: "manual",
      revokedAt: hoursAgo(5),
      lastRejectedAt: hoursAgo(1),
      lastRejectedClient: "cli/0.2.0 (old-box)",
      lastRejectedIp: null,
    }),
  ];
  render(<Tokens />);
  expect(await screen.findByText("pi/0.3.0 (tom-mini)")).toBeTruthy();
  expect(screen.getByText("this browser")).toBeTruthy();
  expect(
    screen.getByText("Still tried by cli/0.2.0 (old-box) 1 hour ago"),
  ).toBeTruthy();
  const revoke = screen.getAllByRole("button", { name: "Revoke" });
  expect(revoke).toHaveLength(1);
  fireEvent.click(revoke[0] as HTMLElement);
  await screen.findByText("pi/0.3.0 (tom-mini)");
  await vi.waitFor(() =>
    expect(calls.some((c) => c.url === "/api/tokens/t1/revoke")).toBe(true),
  );
});
