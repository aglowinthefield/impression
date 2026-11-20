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

test("signs in to every repo, and the repo filter narrows it", async () => {
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
  const select = (await screen.findByLabelText("Repo")) as HTMLSelectElement;
  expect(select.value).toBe("");
  expect(await screen.findByText("y")).toBeTruthy();
  expect(location.pathname).toBe("/");
  fireEvent.change(select, { target: { value: "github.com/a/y" } });
  expect(location.pathname).toBe("/a/y/memories");
  fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "a/x" } });
  expect(location.pathname + location.search).toBe("/memories?project=a%2Fx");
  fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "" } });
  expect(location.pathname + location.search).toBe("/memories");
  fireEvent.click(screen.getByText("Sign out"));
  expect(localStorage.getItem("impression.token")).toBeNull();
  expect(screen.getByLabelText("API token")).toBeTruthy();
});

test("tab and repo live in the URL", async () => {
  history.replaceState(null, "", "/");
  localStorage.setItem("impression.token", "imp_ok");
  respond({
    "/whoami": { name: "alice", admin: true },
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
  expect(location.pathname).toBe("/debug");
  cleanup();
  history.replaceState(null, "", "/a/z/review");
  render(<App />);
  const select = (await screen.findByLabelText("Repo")) as HTMLSelectElement;
  await screen.findByText("z");
  expect(select.value).toBe("github.com/a/z");
  // Review and Evals were folded into Activity; old links land there.
  expect(screen.getByText("Activity").getAttribute("aria-current")).toBe(
    "true",
  );
  expect(screen.queryByText("Review")).toBeNull();
  expect(screen.queryByText("Evals")).toBeNull();
  cleanup();
  history.replaceState(null, "", "/evals?project=github.com%2Fa%2Fx");
  render(<App />);
  await screen.findByText("x");
  expect((screen.getByLabelText("Repo") as HTMLSelectElement).value).toBe(
    "github.com/a/x",
  );
  expect(screen.getByText("Activity").getAttribute("aria-current")).toBe(
    "true",
  );
});

test("shows the GitHub button only when the server has it on", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response('{"github":true}')),
  );
  render(<App />);
  const link = await screen.findByText("Sign in with GitHub");
  expect(link.getAttribute("href")).toBe("/auth/github");
  // The token field waits behind a link when GitHub sign-in is on.
  expect(screen.queryByLabelText("API token")).toBeNull();
  fireEvent.click(screen.getByText("Use an API token"));
  expect(screen.getByLabelText("API token")).toBeTruthy();
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

test("hides Debug from people who aren't admins", async () => {
  history.replaceState(null, "", "/");
  localStorage.setItem("impression.token", "imp_ok");
  respond({
    "/whoami": { name: "sam", admin: false },
    "/projects": { items: [] },
  });
  render(<App />);
  await screen.findByText("sam");
  expect(screen.queryByText("Debug")).toBeNull();
  expect(screen.getByText("Help").getAttribute("href")).toBe("/start");
});

test("shows the setup steps until the first memory, ticking off what's done", async () => {
  history.replaceState(null, "", "/");
  localStorage.setItem("impression.token", "imp_ok");
  respond({
    "/whoami": { name: "sam" },
    "/projects": { items: [] },
    "/setup": {
      name: "sam",
      admin: false,
      repos: 3,
      cliSignedIn: true,
      sessions: 0,
      memories: 0,
    },
  });
  render(<App />);
  expect(await screen.findByText("Welcome, sam")).toBeTruthy();
  expect(screen.getByText("The GitHub app reaches 3 repos")).toBeTruthy();
  expect(screen.getByText("A machine is set up")).toBeTruthy();
  expect(
    screen.getByText("Start a session in one of those repos"),
  ).toBeTruthy();
});

test("serves the Get started page at /start, signed in or not", async () => {
  history.replaceState(null, "", "/start");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          '{"github":true,"installUrl":"https://github.com/apps/x/installations/new"}',
        ),
    ),
  );
  render(<App />);
  expect(screen.getByText("Get started")).toBeTruthy();
  expect(
    screen.getByText("npx @aglowinthefield/impression setup"),
  ).toBeTruthy();
  expect(
    (await screen.findByText("Install or change the app's repos")).getAttribute(
      "href",
    ),
  ).toBe("https://github.com/apps/x/installations/new");
  expect(screen.getByText("Sign in").getAttribute("href")).toBe("/");
  history.replaceState(null, "", "/");
});
