// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Proposals } from "./Proposals";

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
          init.method === "POST"
            ? {}
            : {
                items: [
                  {
                    id: "p1",
                    content: "Run db:migrate first",
                    confidence: 0.7,
                    anchors: [{ path: "Makefile", symbol: "db" }],
                    sessionExcerpt: "user: how do I migrate",
                  },
                ],
              },
        ),
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("shows confidence, anchors and the source session", async () => {
  render(<Proposals project="a/x" />);
  expect(await screen.findByDisplayValue("Run db:migrate first")).toBeTruthy();
  expect(screen.getByText(/confidence 70% · Makefile#db/)).toBeTruthy();
  expect(screen.getByText("user: how do I migrate")).toBeTruthy();
  expect(calls[0]?.url).toBe("/api/proposals?project=a%2Fx");
});

test("accept sends no body edit; editing sends the new text; reject posts", async () => {
  render(<Proposals project="a/x" />);
  fireEvent.click(await screen.findByText("Accept"));
  await waitFor(() =>
    expect(
      calls.some(
        (c) => c.url === "/api/proposals/p1/accept" && c.body === "{}",
      ),
    ).toBe(true),
  );
  fireEvent.change(await screen.findByLabelText("Proposed memory"), {
    target: { value: "Run make db-migrate" },
  });
  fireEvent.click(screen.getByText("Accept edited"));
  await waitFor(() =>
    expect(
      calls.some((c) => c.body === '{"content":"Run make db-migrate"}'),
    ).toBe(true),
  );
  fireEvent.click(await screen.findByText("Reject"));
  await waitFor(() =>
    expect(calls.some((c) => c.url === "/api/proposals/p1/reject")).toBe(true),
  );
});
