// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Memories } from "./Memories";

const mem = (o = {}) => ({
  id: "1",
  scope: "project",
  content: "Use pnpm",
  status: "active",
  staleReason: null,
  pinned: false,
  pathPrefix: null,
  supersededBy: null,
  createdAt: "",
  ...o,
});
let calls: { url: string; method: string; body?: string }[] = [];
const stub = (reply: (url: string, method: string) => unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      calls.push({ url, method, body: init.body as string | undefined });
      return new Response(JSON.stringify(reply(url, method)), { status: 200 });
    }),
  );
beforeEach(() => {
  calls = [];
  localStorage.setItem("impression.token", "t");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("lists memories for the project and shows stale reasons", async () => {
  stub(() => ({
    items: [
      mem(),
      mem({
        id: "2",
        content: "Fly",
        status: "possibly_stale",
        staleReason: "file gone",
      }),
    ],
  }));
  render(<Memories project="a/x" />);
  expect(await screen.findByText("Use pnpm")).toBeTruthy();
  expect(screen.getByText(/possibly stale \(file gone\)/)).toBeTruthy();
  expect(calls[0]?.url).toBe("/api/memories?project=a%2Fx");
});

test("typing searches instead of listing", async () => {
  stub((url) =>
    url === "/api/search"
      ? { results: [mem({ content: "Found it" })] }
      : { items: [] },
  );
  render(<Memories project="a/x" />);
  fireEvent.change(screen.getByLabelText("Search memories"), {
    target: { value: "deploy" },
  });
  expect(await screen.findByText("Found it")).toBeTruthy();
  const search = calls.find((c) => c.url === "/api/search");
  expect(JSON.parse(search?.body ?? "{}")).toEqual({
    query: "deploy",
    project: "a/x",
  });
});

test("edit saves with PATCH, pin toggles, delete confirms first", async () => {
  stub((_u, method) => (method === "GET" ? { items: [mem()] } : mem()));
  render(<Memories project="a/x" />);
  fireEvent.click(await screen.findByText("Edit"));
  fireEvent.change(screen.getByLabelText("Edit memory"), {
    target: { value: "Use pnpm 12" },
  });
  fireEvent.click(screen.getByText("Save"));
  await waitFor(() =>
    expect(
      calls.some(
        (c) => c.method === "PATCH" && c.body === '{"content":"Use pnpm 12"}',
      ),
    ).toBe(true),
  );
  fireEvent.click(await screen.findByText("Pin to core"));
  await waitFor(() =>
    expect(calls.some((c) => c.body === '{"pinned":true}')).toBe(true),
  );
  vi.spyOn(window, "confirm").mockReturnValueOnce(false);
  fireEvent.click(screen.getByText("Delete"));
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  vi.spyOn(window, "confirm").mockReturnValueOnce(true);
  fireEvent.click(screen.getByText("Delete"));
  await waitFor(() =>
    expect(calls.some((c) => c.method === "DELETE")).toBe(true),
  );
});

test("history view has no edit actions", async () => {
  stub(() => ({ items: [mem({ status: "superseded" })] }));
  render(<Memories project="a/x" />);
  await screen.findByText("Use pnpm");
  expect(screen.queryByText("Edit")).toBeNull();
});
