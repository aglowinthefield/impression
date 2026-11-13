// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Settings } from "./Settings";

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
        init.method === "PUT"
          ? (init.body as string)
          : '{"extractionFloor":0.7}',
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("shows the extraction floor and saves a new one", async () => {
  render(<Settings />);
  const input = await screen.findByDisplayValue("0.7");
  const save = screen.getByRole("button", { name: "Save" });
  expect(save).toHaveProperty("disabled", true);
  fireEvent.change(input, { target: { value: "1.5" } });
  expect(save).toHaveProperty("disabled", true);
  fireEvent.change(input, { target: { value: "0.8" } });
  fireEvent.click(save);
  await waitFor(() =>
    expect(calls.at(-1)).toEqual({
      url: "/api/settings",
      method: "PUT",
      body: '{"extractionFloor":0.8}',
    }),
  );
  await waitFor(() => expect(save).toHaveProperty("disabled", true));
});
