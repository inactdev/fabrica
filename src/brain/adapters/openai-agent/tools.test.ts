// The tools a direct-API worker works with. They really read, write and
// run things, so these tests really do too - in a throwaway directory,
// with no Docker needed (the container is what confines this in a real
// run; `resolveInside` only keeps an honest mistake from going
// somewhere surprising).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clamp, loadSession, resolveInside, runTool, saveSession, sessionPath, WORK_TOOLS } from "./tools.mjs";

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-agent-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function env(root: string) {
  return { root, maxToolOutputChars: 2_000, bashTimeoutMs: 5_000 };
}

test("every tool the model is offered is one runTool actually implements", async (t) => {
  const root = scratch(t);
  for (const tool of WORK_TOOLS) {
    const result = await runTool(env(root), tool.function.name, {});
    assert.equal(result.isError, true, `${tool.function.name} accepted empty arguments`);
    assert.doesNotMatch(result.text, /no tool called/, `${tool.function.name} is offered but not implemented`);
  }
});

test("read_file, write_file and list_dir work on the project copy", async (t) => {
  const root = scratch(t);
  writeFileSync(join(root, "a.txt"), "first\n");
  mkdirSync(join(root, "sub"));

  assert.deepEqual(await runTool(env(root), "read_file", { path: "a.txt" }), { text: "first\n", isError: false });

  const written = await runTool(env(root), "write_file", { path: "sub/deeper/b.txt", content: "second" });
  assert.equal(written.isError, false);
  assert.equal(readFileSync(join(root, "sub/deeper/b.txt"), "utf8"), "second");

  const listed = await runTool(env(root), "list_dir", { path: "." });
  assert.equal(listed.isError, false);
  assert.match(listed.text, /^\.:\n/);
  assert.match(listed.text, /a\.txt/);
  assert.match(listed.text, /sub\//);

  const missing = await runTool(env(root), "read_file", { path: "nope.txt" });
  assert.equal(missing.isError, true);
  const directory = await runTool(env(root), "read_file", { path: "sub" });
  assert.match(directory.text, /use list_dir/);
});

test("edit_file replaces exactly, and refuses an ambiguous edit instead of guessing", async (t) => {
  const root = scratch(t);
  writeFileSync(join(root, "f.ts"), "const a = 1;\nconst b = 1;\n");

  const ambiguous = await runTool(env(root), "edit_file", { path: "f.ts", oldText: "= 1;", newText: "= 2;" });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.text, /appears 2 times/);
  assert.equal(readFileSync(join(root, "f.ts"), "utf8"), "const a = 1;\nconst b = 1;\n", "an ambiguous edit changed the file anyway");

  const all = await runTool(env(root), "edit_file", { path: "f.ts", oldText: "= 1;", newText: "= 2;", replaceAll: true });
  assert.equal(all.isError, false);
  assert.equal(readFileSync(join(root, "f.ts"), "utf8"), "const a = 2;\nconst b = 2;\n");

  const one = await runTool(env(root), "edit_file", { path: "f.ts", oldText: "const a", newText: "let a" });
  assert.equal(one.isError, false);
  assert.match(readFileSync(join(root, "f.ts"), "utf8"), /^let a/);

  assert.equal((await runTool(env(root), "edit_file", { path: "f.ts", oldText: "not here", newText: "x" })).isError, true);
  assert.equal((await runTool(env(root), "edit_file", { path: "gone.ts", oldText: "a", newText: "b" })).isError, true);
});

test("bash runs in the project root and reports the exit code as success or failure", async (t) => {
  const root = scratch(t);
  writeFileSync(join(root, "check.sh"), "exit 0\n");

  const green = await runTool(env(root), "bash", { command: "ls check.sh && echo here" });
  assert.equal(green.isError, false);
  assert.match(green.text, /exit code 0/);
  assert.match(green.text, /here/);

  const red = await runTool(env(root), "bash", { command: "echo oops >&2; exit 3" });
  assert.equal(red.isError, true, "a non-zero exit must read as an error to the model");
  assert.match(red.text, /exit code 3/);
  assert.match(red.text, /oops/, "stderr belongs in the output a model sees");
});

test("a command that will not finish is killed and reported, not waited on forever", async (t) => {
  const root = scratch(t);
  const result = await runTool({ ...env(root), bashTimeoutMs: 300 }, "bash", { command: "sleep 30" });
  assert.equal(result.isError, true);
  assert.match(result.text, /timed out after 300ms/);
});

test("no tool takes a path outside the project", async (t) => {
  const root = scratch(t);
  for (const path of ["../outside.txt", "/etc/hosts", "sub/../../outside.txt"]) {
    const result = await runTool(env(root), "write_file", { path, content: "x" });
    assert.equal(result.isError, true, `${path} was accepted`);
    assert.match(result.text, /outside the project/);
  }
  assert.equal(resolveInside(root, "./a/../b.txt"), join(root, "b.txt"));
  assert.throws(() => resolveInside(root, ""), /non-empty string/);
});

test("an oversized output keeps both ends and says what it dropped", () => {
  const text = `${"a".repeat(5_000)}UNIQUE-END`;
  const clamped = clamp(text, 400);
  assert.ok(clamped.length < 600);
  assert.match(clamped, /characters dropped from the middle/);
  assert.match(clamped, /UNIQUE-END$/, "the end of a check's output is the part that says what failed");
  assert.equal(clamp("short", 400), "short");
});

test("a session round-trips through the box's own $HOME, and a corrupt one is a cold start", (t) => {
  const home = scratch(t);
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  });

  saveSession("abc", [{ role: "user", content: "one" }]);
  assert.deepEqual(loadSession("abc"), [{ role: "user", content: "one" }]);
  assert.deepEqual(loadSession("never-saved"), []);

  const path = sessionPath("abc");
  assert.ok(path !== undefined);
  writeFileSync(path, "{ truncated mid-writ");
  assert.deepEqual(loadSession("abc"), [], "a corrupt session file must not fail a task");

  process.env.HOME = "/";
  assert.equal(sessionPath("abc"), undefined, "with no mounted home there is nowhere to persist a session");
});
