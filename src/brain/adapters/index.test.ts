import { test } from "node:test";
import assert from "node:assert/strict";
import { credentialEnvFrom, defaultBrainAdapter } from "./index.ts";

// Issue #85. `Brain` is name/model/work/ask - the `env` an adapter was
// built with never surfaces on it - so these assert on the one function
// that makes the choice, which `defaultBrainAdapter()` is a one-liner
// over.

test("the brain credential is forwarded when it is set in the host environment", () => {
  assert.deepEqual(credentialEnvFrom({ CLAUDE_CODE_OAUTH_TOKEN: "a-fake-token-not-a-real-one" }), {
    env: { CLAUDE_CODE_OAUTH_TOKEN: "a-fake-token-not-a-real-one" },
  });
});

test("nothing at all is forwarded when the brain credential is unset", () => {
  // A whole host environment, credential absent: every other variable in
  // it - API keys, tokens, anything - must stay on this side of the
  // container wall, so the options come back empty, not filtered.
  assert.deepEqual(
    credentialEnvFrom({
      PATH: "/usr/bin",
      HOME: "/home/someone",
      ANTHROPIC_API_KEY: "must-not-be-forwarded",
      AWS_SECRET_ACCESS_KEY: "must-not-be-forwarded",
    }),
    {}
  );
});

test("defaultBrainAdapter still returns a usable brain either way", () => {
  const brain = defaultBrainAdapter();
  assert.equal(typeof brain.work, "function");
  assert.equal(typeof brain.ask, "function");
});
