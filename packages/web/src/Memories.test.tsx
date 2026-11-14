// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
    source: "web",
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
  fireEvent.click(screen.getByText("Retire"));
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  vi.spyOn(window, "confirm").mockReturnValueOnce(true);
  fireEvent.click(screen.getByText("Retire"));
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

test("the tag filter lists with that tag, and tags seen are offered", async () => {
  stub(() => ({ items: [mem({ tags: ["practice", "design"] })] }));
  render(<Memories project="a/x" />);
  await screen.findByText("Use pnpm");
  fireEvent.change(screen.getByLabelText("Tag"), {
    target: { value: "design" },
  });
  await waitFor(() =>
    expect(calls.at(-1)?.url).toBe("/api/memories?project=a%2Fx&tag=design"),
  );
});

test("adds a tag with Enter and removes one with its ×", async () => {
  stub(() => ({ items: [mem({ tags: ["practice"] })] }));
  render(<Memories project="a/x" />);
  await screen.findByText("Use pnpm");
  fireEvent.change(screen.getByLabelText("Add tag"), {
    target: { value: "Design Pass" },
  });
  fireEvent.keyDown(screen.getByLabelText("Add tag"), { key: "Enter" });
  await waitFor(() =>
    expect(calls.find((c) => c.method === "PATCH")?.body).toBe(
      JSON.stringify({ tags: ["practice", "design-pass"] }),
    ),
  );
  calls = [];
  fireEvent.click(screen.getByLabelText("Remove tag practice"));
  await waitFor(() =>
    expect(calls.find((c) => c.method === "PATCH")?.body).toBe(
      JSON.stringify({ tags: [], project: { key: "a/x" } }),
    ),
  );
});

test("history rows can't be tagged", async () => {
  stub(() => ({ items: [mem({ status: "retired", tags: ["x"] })] }));
  render(<Memories project="a/x" />);
  await screen.findByText("Use pnpm");
  expect(screen.queryByLabelText("Add tag")).toBeNull();
  expect(screen.queryByLabelText("Remove tag x")).toBeNull();
});

test("tagging practice confirms, and un-tagging it sends the project back", async () => {
  stub(() => ({ items: [mem({ tags: ["practice"], scope: "user" })] }));
  render(<Memories project="a/x" />);
  await screen.findByText("Use pnpm");
  fireEvent.click(screen.getByLabelText("Remove tag practice"));
  await waitFor(() =>
    expect(calls.find((c) => c.method === "PATCH")?.body).toBe(
      JSON.stringify({ tags: [], project: { key: "a/x" } }),
    ),
  );
});

test("the tag box offers known tags and lets you create a new one", async () => {
  stub(() => ({
    items: [
      mem({ tags: ["design"] }),
      mem({ id: "2", content: "Other", tags: [] }),
    ],
  }));
  render(<Memories project="a/x" />);
  await screen.findByText("Other");
  const box = screen.getAllByLabelText("Add tag")[1] as HTMLInputElement;
  fireEvent.focus(box);
  // Known tags are listed; picking one adds it.
  fireEvent.mouseDown(
    within(await screen.findByLabelText("Tag suggestions")).getByText("design"),
  );
  await waitFor(() =>
    expect(calls.find((c) => c.method === "PATCH")?.body).toBe(
      JSON.stringify({ tags: ["design"] }),
    ),
  );
  calls = [];
  fireEvent.change(box, { target: { value: "Brand New" } });
  fireEvent.mouseDown(
    within(await screen.findByLabelText("Tag suggestions")).getByText(
      "Create “brand-new”",
    ),
  );
  await waitFor(() =>
    expect(calls.find((c) => c.method === "PATCH")?.body).toBe(
      JSON.stringify({ tags: ["brand-new"] }),
    ),
  );
});
