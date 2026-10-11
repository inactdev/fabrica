import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialEnvFrom, defaultBrainAdapter } from "./index.ts";

// Issue #85, and the worker-token half of the "a failed start is never
// silent" ruling. `Brain` is name/model/work/ask - the `env` an adapter
// was built with never surfaces on it - so these assert on the one
// function that makes the choice. Every token here is a fake value.

function recordHome(brainEnv?: { content: string; mode: number }): string {
  const home = mkdtempSync(join(tmpdir(), "fabrica-brain-env-"));
  if (brainEnv) {
    writeFileSync(join(home, "brain.env"), brainEnv.content);
    chmodSync(join(home, "brain.env"), brainEnv.mode);
  }
  return home;
}

test("the brain credential is forwarded when it is set in the host environment", () => {
  assert.deepEqual(credentialEnvFrom({ CLAUDE_CODE_OAUTH_TOKEN: "a-fake-token-not-a-real-one" }, recordHome()), {
    env: { CLAUDE_CODE_OAUTH_TOKEN: "a-fake-token-not-a-real-one" },
  });
});

test("unset in the environment, it is read from <recordHome>/brain.env - that one variable only, Fabrica's env untouched", () => {
  const before = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const home = recordHome({ content: "# the worker token\nCLAUDE_CODE_OAUTH_TOKEN=fake-from-file\n", mode: 0o600 });

  // A whole host environment, credential absent: nothing else in it may
  // reach the container.
  const chosen = credentialEnvFrom(
    { PATH: "/usr/bin", ANTHROPIC_API_KEY: "must-not-be-forwarded", AWS_SECRET_ACCESS_KEY: "must-not-be-forwarded" },
    home
  );

  assert.deepEqual(chosen, { env: { CLAUDE_CODE_OAUTH_TOKEN: "fake-from-file" } });
  assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, before, "the token leaked into Fabrica's own environment");
});

test("brain.env: an optional leading `export ` on the token line is accepted", () => {
  const home = recordHome({ content: "export CLAUDE_CODE_OAUTH_TOKEN=fake-exported\n", mode: 0o600 });
  assert.deepEqual(credentialEnvFrom({}, home), { env: { CLAUDE_CODE_OAUTH_TOKEN: "fake-exported" } });
});

test("brain.env: a second variable or any other line is ignored, never forwarded", () => {
  const home = recordHome({
    content: [
      "ANTHROPIC_API_KEY=must-not-be-forwarded",
      "export AWS_SECRET_ACCESS_KEY=must-not-be-forwarded",
      "export CLAUDE_CODE_OAUTH_TOKEN=fake-the-one",
      "not a variable at all",
      "exportCLAUDE_CODE_OAUTH_TOKEN=must-not-be-read",
      "",
    ].join("\n"),
    mode: 0o600,
  });
  assert.deepEqual(credentialEnvFrom({}, home), { env: { CLAUDE_CODE_OAUTH_TOKEN: "fake-the-one" } });
});

for (const [label, content] of [
  ["no token line", "ANTHROPIC_API_KEY=also-fake\n"],
  ["an empty token", "export CLAUDE_CODE_OAUTH_TOKEN=\n"],
  ["two token lines", "CLAUDE_CODE_OAUTH_TOKEN=fake-one\nexport CLAUDE_CODE_OAUTH_TOKEN=fake-two\n"],
] as const) {
  test(`brain.env with ${label} is refused, naming the file and never printing a value`, () => {
    const home = recordHome({ content, mode: 0o600 });
    assert.throws(
      () => credentialEnvFrom({}, home),
      (err: Error) =>
        err.message.includes(join(home, "brain.env")) &&
        /CLAUDE_CODE_OAUTH_TOKEN=/.test(err.message) &&
        !/fake/.test(err.message)
    );
  });
}

test("brain.env readable by group or others is refused, naming chmod 600", () => {
  for (const mode of [0o640, 0o604, 0o644]) {
    const home = recordHome({ content: "CLAUDE_CODE_OAUTH_TOKEN=fake\n", mode });
    assert.throws(
      () => credentialEnvFrom({}, home),
      (err: Error) => err.message.includes(`chmod 600 ${join(home, "brain.env")}`),
      `mode ${mode.toString(8)} was accepted`
    );
  }
});

test("neither the environment nor brain.env: refused, naming claude setup-token and the file path", () => {
  const home = recordHome();
  assert.throws(
    () => credentialEnvFrom({ PATH: "/usr/bin" }, home),
    (err: Error) => err.message.includes("claude setup-token") && err.message.includes(join(home, "brain.env"))
  );
});

test("the refusal never prints the token", () => {
  const home = recordHome({ content: "CLAUDE_CODE_OAUTH_TOKEN=fake-secret-value\n", mode: 0o644 });
  assert.throws(() => credentialEnvFrom({}, home), (err: Error) => !err.message.includes("fake-secret-value"));
});

test("defaultBrainAdapter returns a usable brain, and refuses at its first call when no token is found", async () => {
  const brain = defaultBrainAdapter(recordHome());
  assert.equal(typeof brain.work, "function");
  assert.equal(typeof brain.ask, "function");
  await assert.rejects(() => brain.ask("anything"), /claude setup-token/);
});
