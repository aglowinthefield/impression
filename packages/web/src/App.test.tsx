// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App";

const respond = (routes: Record<string, unknown>) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization;
      if (auth !== "Bearer imp_ok")
        return new Response('{"error":"invalid token"}', { status: 401 });
      const body = routes[url.replace("/api", "")];
      return new Response(JSON.stringify(body ?? {}), {
        status: body ? 200 : 404,
      });
    }),
  );

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("rejects a bad token and stays on the login form", async () => {
  respond({});
  render(<App />);
  fireEvent.change(screen.getByLabelText("API token"), {
    target: { value: "imp_bad" },
  });
  fireEvent.click(screen.getByText("Sign in"));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "That token isn't valid.",
  );
  expect(localStorage.getItem("impression.token")).toBeNull();
});

test("signs in and opens the most recently active project", async () => {
  history.replaceState(null, "", "/");
  respond({
    "/whoami": { name: "alice" },
    "/projects": {
      items: [
        { key: "github.com/a/y", name: "y" },
        { key: "a/x", name: "x" },
      ],
    },
  });
  render(<App />);
  fireEvent.change(screen.getByLabelText("API token"), {
    target: { value: "imp_ok" },
  });
  fireEvent.click(screen.getByText("Sign in"));
  const select = (await screen.findByLabelText("Project")) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe("github.com/a/y"));
  expect(location.pathname).toBe("/a/y/memories");
  fireEvent.change(select, { target: { value: "a/x" } });
  expect(location.pathname + location.search).toBe("/memories?project=a%2Fx");
  fireEvent.click(screen.getByText("Sign out"));
  expect(localStorage.getItem("impression.token")).toBeNull();
  expect(screen.getByLabelText("API token")).toBeTruthy();
});

test("tab and project live in the URL", async () => {
  history.replaceState(null, "", "/");
  localStorage.setItem("impression.token", "imp_ok");
  respond({
    "/whoami": { name: "alice" },
    "/projects": {
      items: [
        { key: "github.com/a/x", name: "x" },
        { key: "github.com/a/z", name: "z" },
      ],
    },
    "/debug/requests": { items: [] },
  });
  render(<App />);
  fireEvent.click(await screen.findByText("Debug"));
  expect(location.pathname).toBe("/a/x/debug");
  cleanup();
  history.replaceState(null, "", "/a/z/review");
  render(<App />);
  const select = (await screen.findByLabelText("Project")) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe("github.com/a/z"));
  expect(location.pathname).toBe("/a/z/review");
  history.pushState(null, "", "/a/x/debug");
  history.back();
  history.back();
  await waitFor(() => expect(location.pathname).not.toBe("/debug"));
});

test("shows the GitHub button only when the server has it on", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response('{"github":true}')),
  );
  render(<App />);
  const link = await screen.findByText("Sign in with GitHub");
  expect(link.getAttribute("href")).toBe("/auth/github");
  cleanup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response('{"github":false}')),
  );
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText("API token")).toBeTruthy());
  expect(screen.queryByText("Sign in with GitHub")).toBeNull();
});

test("saves the token from the GitHub redirect and clears the fragment", async () => {
  history.replaceState(null, "", "/#token=imp_ok");
  respond({ "/whoami": { name: "sam" }, "/projects": { items: [] } });
  render(<App />);
  expect(localStorage.getItem("impression.token")).toBe("imp_ok");
  expect(location.hash).toBe("");
  expect(await screen.findByText("sam")).toBeTruthy();
});
