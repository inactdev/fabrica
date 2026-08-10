import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLineTail } from "./tail.ts";
import { makeTestHome } from "./helpers/test-home.ts";

function tailOverNewFile(): { path: string; tail: () => string[] } {
  const path = join(makeTestHome(), "appended.log");
  return { path, tail: createLineTail(path) };
}

test("createLineTail: a file that doesn't exist yet reads as empty, not an error", () => {
  const { tail } = tailOverNewFile();
  assert.deepEqual(tail(), []);
});

test("createLineTail: the first call returns every line, the next only what was appended after it", () => {
  const { path, tail } = tailOverNewFile();
  appendFileSync(path, "one\ntwo\n");
  assert.deepEqual(tail(), ["one", "two"]);

  assert.deepEqual(tail(), [], "nothing new means nothing returned");

  appendFileSync(path, "three\n");
  assert.deepEqual(tail(), ["three"], "only the appended line, not the whole file again");
});

test("createLineTail: a line still mid-append is withheld until its newline lands", () => {
  const { path, tail } = tailOverNewFile();
  appendFileSync(path, "complete\n{\"half\":");
  assert.deepEqual(tail(), ["complete"]);

  appendFileSync(path, "1}\n");
  assert.deepEqual(tail(), ['{"half":1}'], "the torn line is returned once, whole");
});

test("createLineTail: a file replaced with a shorter one is read from the top again", () => {
  const { path, tail } = tailOverNewFile();
  appendFileSync(path, "first\nsecond\n");
  assert.deepEqual(tail(), ["first", "second"]);

  writeFileSync(path, "fresh\n");
  assert.deepEqual(tail(), ["fresh"]);
});

test("createLineTail: two tails over the same file each keep their own place", () => {
  const { path, tail } = tailOverNewFile();
  appendFileSync(path, "one\n");
  assert.deepEqual(tail(), ["one"]);

  const second = createLineTail(path);
  assert.deepEqual(second(), ["one"], "a fresh tail starts at the beginning");
  assert.deepEqual(tail(), [], "the older tail is unaffected");
});
