import { expect, test } from "vitest";
import { pieceHash } from "./piece-hash.js";

test("hashes the trimmed text, so surrounding whitespace doesn't change it", () => {
  expect(pieceHash("  user: hi\nassistant: hello \n")).toBe(
    pieceHash("user: hi\nassistant: hello"),
  );
  expect(pieceHash("a")).toMatch(/^[0-9a-f]{64}$/);
  expect(pieceHash("a")).not.toBe(pieceHash("b"));
});
