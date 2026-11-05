// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Evals, fixtureSnippet } from "./Evals";

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
      if (url.startsWith("/api/evals/turns?"))
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "t1",
                at: null,
                prompt: "how do I build",
                reply: "run pnpm install",
                injected: [
                  {
                    text: "Run pnpm install first",
                    memoryId: "m1",
                    status: "active",
                    rating: null,
                  },
                ],
              },
            ],
          }),
        );
      return new Response(JSON.stringify({ ok: true }));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("rates an injected memory and clears the rating on a second click", async () => {
  render(<Evals project="a/x" />);
  expect(await screen.findByText("Run pnpm install first")).toBeTruthy();
  expect(calls[0]?.url).toBe("/api/evals/turns?project=a%2Fx&unrated=true");
  fireEvent.click(screen.getByText("Useful"));
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.url === "/api/evals/turns/t1/rating" &&
          c.method === "PUT" &&
          c.body === '{"memory":"Run pnpm install first","rating":"useful"}',
      ),
    ).toBe(true),
  );
  fireEvent.click(screen.getByText("Useful"));
  await waitFor(() =>
    expect(
      calls.some(
        (c) => c.body === '{"memory":"Run pnpm install first","rating":null}',
      ),
    ).toBe(true),
  );
});

test("a wrong rating offers to retire the memory", async () => {
  render(<Evals project="a/x" />);
  fireEvent.click(await screen.findByText("Wrong"));
  expect(await screen.findByText("Retire memory")).toBeTruthy();
});

test("fixtureSnippet escapes the transcript and builds an avoid pattern", () => {
  const s = fixtureSnippet(
    "Next up: strip `impression` messages",
    "user: a `b` ${c}",
  );
  expect(s).toContain("transcript: `user: a \\`b\\` \\${c}`");
  expect(s).toContain("avoid: [/Next up: strip `impression`/i]");
});
