import { describe, expect, test } from "vitest";
import { dashboardUrl, openCommand } from "./browser.js";

describe("dashboardUrl", () => {
  test("puts GitHub projects in the path", () => {
    expect(dashboardUrl("https://impression.quest/", "github.com/a/b")).toBe(
      "https://impression.quest/a/b/memories",
    );
  });

  test("keeps other projects in the query", () => {
    expect(dashboardUrl("http://h", "path:/tmp/x y")).toBe(
      "http://h/memories?project=path%3A%2Ftmp%2Fx%20y",
    );
    expect(dashboardUrl("http://h", "gitlab.com/a/b")).toBe(
      "http://h/memories?project=gitlab.com%2Fa%2Fb",
    );
  });
});

test("openCommand picks the platform's opener", () => {
  expect(openCommand("u", "darwin")).toEqual(["open", ["u"]]);
  expect(openCommand("u", "linux")).toEqual(["xdg-open", ["u"]]);
  expect(openCommand("u", "win32")).toEqual(["cmd", ["/c", "start", "", "u"]]);
});
