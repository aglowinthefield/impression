// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MemoriesPage } from "./Concepts";

const concept = (o = {}) => ({
  id: "c1",
  parentId: null,
  name: "Auth",
  summary: "How sign-in works",
  count: 2,
  related: [],
  updatedAt: "",
  ...o,
});
let calls: { url: string; method: string }[] = [];
let concepts: unknown[] = [];
beforeEach(() => {
  calls = [];
  localStorage.setItem("impression.token", "t");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      calls.push({ url, method });
      const body = url.startsWith("/api/dream")
        ? method === "POST"
          ? {}
          : { items: concepts }
        : { items: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("lists areas with subtopics and filters memories by the chosen one", async () => {
  concepts = [
    concept(),
    concept({
      id: "c2",
      parentId: "c1",
      name: "Tokens",
      count: 3,
      related: ["c3"],
    }),
    concept({ id: "c3", name: "Hooks", count: 1 }),
  ];
  render(<MemoriesPage project="a/x" />);
  const auth = await screen.findByRole("button", { name: /^Auth\s*5$/ });
  expect(screen.getByRole("button", { name: /^Tokens\s*3$/ })).toBeTruthy();
  fireEvent.click(auth);
  expect(await screen.findByText("How sign-in works")).toBeTruthy();
  expect(calls.at(-1)?.url).toBe("/api/memories?project=a%2Fx&concept=c1");

  fireEvent.click(screen.getByRole("button", { name: /^Tokens\s*3$/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Hooks" }));
  expect(await screen.findByRole("heading", { name: "Hooks" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Uncategorized" }));
  await screen.findByText("No memories.");
  expect(calls.at(-1)?.url).toBe("/api/memories?project=a%2Fx&concept=none");

  fireEvent.click(screen.getByRole("button", { name: "Practices" }));
  await screen.findByText("No memories.");
  expect(calls.at(-1)?.url).toBe(
    "/api/memories?project=a%2Fx&scope=user&tag=practice",
  );
});

test("offers to group a project that has no concepts", async () => {
  concepts = [];
  render(<MemoriesPage project="a/x" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Group into concepts" }),
  );
  await screen.findByRole("button", { name: "Group into concepts" });
  expect(
    calls.some(
      (c) => c.method === "POST" && c.url === "/api/dream?project=a%2Fx",
    ),
  ).toBe(true);
  expect(screen.queryByRole("button", { name: "Uncategorized" })).toBeNull();
});
