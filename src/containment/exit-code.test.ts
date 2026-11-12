import { test } from "node:test";
import assert from "node:assert/strict";

import { describeExit } from "./exit-code.ts";

test("an ordinary exit names the process and its code", () => {
  assert.equal(describeExit("npm test", 1), "npm test exited 1");
  assert.equal(describeExit("npm test", 0), "npm test exited 0");
});

test("a signal death names the process and the signal, never a bare null", () => {
  const said = describeExit("the worker's own command", null, "SIGKILL");
  assert.match(said, /the worker's own command/);
  assert.match(said, /SIGKILL/);
  assert.doesNotMatch(said, /null/);
});

test("an unreadable exit code with no signal reported still names the process and says a signal ended it", () => {
  const said = describeExit("docker", null);
  assert.match(said, /^docker /);
  assert.match(said, /signal/);
  assert.doesNotMatch(said, /null/);
});

test("undefined is treated as unreadable, not printed", () => {
  assert.doesNotMatch(describeExit("open -a Docker", undefined), /undefined/);
});
