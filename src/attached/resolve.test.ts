// What a `--file <path>` value resolves to, and every shape that is
// refused instead. src/foreman/task-files.test.ts owns the end-to-end
// half (a real round whose worker finds the files in its workstation).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachedError } from "./errors.ts";
import { resolveAttachedFiles } from "./resolve.ts";

/** A throwaway folder holding the named files with the given contents. */
function makeFiles(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-attached-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

function refusal(run: () => unknown, code: string, named: string): void {
  assert.throws(run, (err: unknown) => {
    assert.ok(err instanceof AttachedError, `not an AttachedError: ${String(err)}`);
    assert.equal(err.code, code);
    assert.ok(err.message.includes(named), `did not name ${named}: ${err.message}`);
    return true;
  });
}

test("resolveAttachedFiles: nothing for no paths at all", () => {
  assert.deepEqual(resolveAttachedFiles([]), []);
});

test("resolveAttachedFiles: absolute path, bare name, real size, in the order named", () => {
  const dir = makeFiles({ "pots.md": "one two three", "data.csv": "a,b\n1,2\n" });

  assert.deepEqual(resolveAttachedFiles([join(dir, "data.csv"), join(dir, "pots.md")]), [
    { path: join(dir, "data.csv"), name: "data.csv", bytes: 8 },
    { path: join(dir, "pots.md"), name: "pots.md", bytes: 13 },
  ]);
});

test("resolveAttachedFiles: a relative path is resolved against the given cwd", () => {
  const dir = makeFiles({ "spec.md": "x" });

  assert.deepEqual(resolveAttachedFiles(["spec.md"], { cwd: dir }), [
    { path: join(dir, "spec.md"), name: "spec.md", bytes: 1 },
  ]);
});

test("resolveAttachedFiles: a path with nothing at it is refused, naming it", () => {
  const missing = join(tmpdir(), "fabrica-attached-no-such-file.md");
  refusal(() => resolveAttachedFiles([missing]), "no-such-file", missing);
});

test("resolveAttachedFiles: a folder is refused, naming it as a folder", () => {
  const dir = makeFiles({});
  mkdirSync(join(dir, "notes"));

  refusal(() => resolveAttachedFiles([join(dir, "notes")]), "not-a-file", "it is a folder");
});

test("resolveAttachedFiles: two paths ending in the same name are refused, naming both", () => {
  const one = makeFiles({ "spec.md": "first" });
  const two = makeFiles({ "spec.md": "second" });

  assert.throws(
    () => resolveAttachedFiles([join(one, "spec.md"), join(two, "spec.md")]),
    (err: unknown) => {
      assert.ok(err instanceof AttachedError);
      assert.equal(err.code, "duplicate-name");
      assert.ok(err.message.includes(join(one, "spec.md")), `did not name the first: ${err.message}`);
      assert.ok(err.message.includes(join(two, "spec.md")), `did not name the second: ${err.message}`);
      return true;
    }
  );
});

test("resolveAttachedFiles: the same path twice is the same collision", () => {
  const dir = makeFiles({ "spec.md": "x" });
  refusal(() => resolveAttachedFiles([join(dir, "spec.md"), join(dir, "spec.md")]), "duplicate-name", "spec.md");
});

test("resolveAttachedFiles: a file named .gitignore is refused - that name is the folder's own", () => {
  const dir = makeFiles({ ".gitignore": "node_modules\n" });
  refusal(() => resolveAttachedFiles([join(dir, ".gitignore")]), "reserved-name", "out of git");
});

test("resolveAttachedFiles: the size is today's, not one it was told", () => {
  const dir = makeFiles({ "spec.md": "short" });
  const path = join(dir, "spec.md");
  assert.equal(resolveAttachedFiles([path])[0].bytes, 5);

  writeFileSync(path, "a good deal longer than before");
  assert.equal(resolveAttachedFiles([path])[0].bytes, 30, "it reported a stale size");
});
