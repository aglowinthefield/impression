// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Review } from "./Review";

const m = (id: string, project: string | null, o = {}) => ({
  id,
  project,
  scope: "project",
  content: `memory ${id}`,
  status: "possibly_stale",
  staleReason: "Makefile no longer has db-migrate",
  pinned: false,
  pathPrefix: null,
  supersededBy: null,
  createdAt: "",
  anchors: [{ path: "Makefile", symbol: "db-migrate" }],
  ...o,
});
let calls: { url: string; method: string; body?: string }[] = [];
beforeEach(() => {
  calls = [];
  localStorage.setItem("impression.token", "t");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        body: init.body as string | undefined,
      });
      return new Response(
        JSON.stringify(
          init.method !== "GET"
            ? {}
            : { items: [m("a", "p/x"), m("b", "p/y"), m("c", null)] },
        ),
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("shows this project's flagged memories with reason and anchor", async () => {
  render(<Review project="p/x" />);
  expect(await screen.findByText("memory a")).toBeTruthy();
  expect(screen.queryByText("memory b")).toBeNull();
  expect(screen.getByText("memory c")).toBeTruthy();
  expect(
    screen.getAllByText(
      /Makefile no longer has db-migrate · Makefile#db-migrate/,
    ),
  ).toHaveLength(2);
});

test("confirm, update and retire call the right endpoints", async () => {
  render(<Review project="p/x" />);
  fireEvent.click((await screen.findAllByText("Still true"))[0] as HTMLElement);
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.url === "/api/memories/a/staleness" &&
          c.method === "PUT" &&
          c.body === '{"stale":false}',
      ),
    ).toBe(true),
  );
  fireEvent.click((await screen.findAllByText("Update"))[0] as HTMLElement);
  fireEvent.change(screen.getByLabelText("Update memory"), {
    target: { value: "new text" },
  });
  fireEvent.click(screen.getByText("Save update"));
  await waitFor(() =>
    expect(
      calls.some(
        (c) => c.method === "PATCH" && c.body === '{"content":"new text"}',
      ),
    ).toBe(true),
  );
  fireEvent.click((await screen.findAllByText("Retire"))[0] as HTMLElement);
  await waitFor(() =>
    expect(calls.some((c) => c.method === "DELETE")).toBe(true),
  );
});
