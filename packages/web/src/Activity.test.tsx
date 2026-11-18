// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Activity, describe, type Entry } from "./Activity";

const entry = (o: Partial<Entry>): Entry => ({
  id: "e1",
  at: new Date().toISOString(),
  kind: "extracted",
  actor: "extraction",
  principal: "alice",
  memory: {
    id: "m1",
    content: "Builds use tsrs",
    scope: "project",
    status: "active",
  },
  reason: "",
  undone: false,
  canUndo: true,
  ...o,
});

let calls: { url: string; method: string }[] = [];
let pages: Record<string, unknown> = {};
let undoStatus = 200;

beforeEach(() => {
  calls = [];
  undoStatus = 200;
  localStorage.setItem("impression.token", "t");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      calls.push({ url, method });
      if (url.endsWith("/undo"))
        return new Response(
          JSON.stringify(
            undoStatus === 200
              ? {}
              : { error: "the memory changed since this entry" },
          ),
          { status: undoStatus },
        );
      if (url.startsWith("/api/activity/summary"))
        return new Response(
          JSON.stringify({
            weeks: [
              {
                week: "2026-11-11T00:00:00Z",
                added: 4,
                rewritten: 1,
                retired: 1,
                retireRate: 25,
              },
            ],
          }),
        );
      const before = new URL(url, "http://x").searchParams.get("before") ?? "";
      return new Response(
        JSON.stringify(pages[before] ?? { items: [], next: null }),
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("describes who made each change", () => {
  expect(describe(entry({ session: { id: "s", agent: "pi" } }))).toBe(
    "Extracted from a pi session",
  );
  expect(describe(entry({ kind: "retired", actor: "check" }))).toBe(
    "Retired by the staleness check",
  );
  expect(
    describe(entry({ kind: "undone", actor: "person", undoes: "merged" })),
  ).toBe("Undid merged by alice");
  expect(
    describe(
      entry({
        kind: "dreamed",
        actor: "dream",
        memory: null,
        run: {
          created: 1,
          kept: 3,
          removed: 0,
          uncategorized: 2,
          concepts: 4,
          error: null,
        },
      }),
    ),
  ).toBe(
    "Grouped into concepts: 1 new, 3 kept, 0 removed, 2 memories uncategorized",
  );
});

test("lists entries with before and after, the weekly summary, and pages on", async () => {
  pages = {
    "": {
      items: [
        entry({
          kind: "merged",
          before: "Deploy with fly",
          after: "Deploy with fly --remote-only",
        }),
      ],
      next: "c1",
    },
    c1: {
      items: [
        entry({
          id: "e2",
          memory: {
            id: "m2",
            content: "Second page",
            scope: "project",
            status: "active",
          },
        }),
      ],
      next: null,
    },
  };
  const { container } = render(<Activity project="github.com/a/x" />);
  await screen.findByText("Deploy with fly");
  expect(container.querySelector("del")?.textContent).toBe("Deploy with fly");
  expect(container.querySelector("ins")?.textContent).toBe(
    "Deploy with fly --remote-only",
  );
  expect(screen.getByText("25%")).toBeTruthy();
  fireEvent.click(screen.getByText("Load 50 more"));
  expect(await screen.findByText("Second page")).toBeTruthy();
  expect(screen.queryByText("Load 50 more")).toBeNull();
});

test("undo calls the API and shows a refusal", async () => {
  pages = { "": { items: [entry({})], next: null } };
  render(<Activity project="github.com/a/x" />);
  fireEvent.click(await screen.findByText("Undo"));
  await waitFor(() =>
    expect(
      calls.some(
        (c) => c.url === "/api/activity/e1/undo" && c.method === "POST",
      ),
    ).toBe(true),
  );
  undoStatus = 409;
  fireEvent.click(await screen.findByText("Undo"));
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /changed since/,
  );
});

test("the source filter goes to the API", async () => {
  pages = { "": { items: [], next: null } };
  render(<Activity project="github.com/a/x" />);
  await screen.findByText("Nothing has happened here yet.");
  fireEvent.change(screen.getByLabelText("Source"), {
    target: { value: "dream" },
  });
  await waitFor(() =>
    expect(calls.some((c) => c.url.includes("source=dream"))).toBe(true),
  );
});

test("an entry without undo shows no button", async () => {
  pages = {
    "": { items: [entry({ canUndo: false, undone: true })], next: null },
  };
  render(<Activity project="github.com/a/x" />);
  expect(await screen.findByText(/undone/)).toBeTruthy();
  expect(screen.queryByText("Undo")).toBeNull();
});
