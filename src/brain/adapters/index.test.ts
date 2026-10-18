import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRAIN_SELECTION_VAR,
  brainEnvValue,
  CLI_WORKER_VENDOR,
  credentialEnvFrom,
  defaultBrainAdapter,
  DIRECT_BRAIN_NAME,
  DIRECT_VARS,
  DIRECT_WORKER_VENDOR,
  selectedBrain,
  workerVendor,
} from "./index.ts";

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

// Issue #200: the per-token pipe is opened deliberately, with one
// switch, and nothing changes for anyone who leaves it alone.

test("with no FABRICA_BRAIN set, the flat-rate CLI worker is still the brain", () => {
  const brain = selectedBrain({ CLAUDE_CODE_OAUTH_TOKEN: "fake" }, recordHome());
  assert.equal(brain.name, "claude-code");
});

test("FABRICA_BRAIN selects the direct-API worker, pointed at the model named for it", () => {
  const brain = selectedBrain({ FABRICA_BRAIN: "openai-compatible", FABRICA_MODEL: "some/open-weight-model" }, recordHome());
  assert.equal(brain.name, "openai-compatible");
  assert.equal(brain.model, "some/open-weight-model");
});

test("the direct-API worker refuses to be built with no model named, pointing at where to name one", () => {
  const home = recordHome();
  assert.throws(
    () => selectedBrain({ FABRICA_BRAIN: "openai-compatible" }, home),
    (err: Error) => err.message.includes("FABRICA_MODEL") && err.message.includes(join(home, "brain.env"))
  );
});

test("a cost basis that is neither reported nor free is refused rather than guessed at", () => {
  assert.throws(
    () =>
      selectedBrain(
        { FABRICA_BRAIN: "openai-compatible", FABRICA_MODEL: "m", FABRICA_MODEL_COST: "cheap" },
        recordHome()
      ),
    /must be "reported" or "free"/
  );
});

test("every setting can live in brain.env instead of the environment", () => {
  const home = recordHome({
    content: [
      "FABRICA_BRAIN=openai-compatible",
      "export FABRICA_MODEL=from/the-file",
      "OPENROUTER_API_KEY=fake-key-from-the-file",
      "FABRICA_MODEL_BASE_URL=http://127.0.0.1:11434/v1",
      "",
    ].join("\n"),
    mode: 0o600,
  });

  const brain = selectedBrain({}, home);
  assert.equal(brain.name, "openai-compatible");
  assert.equal(brain.model, "from/the-file");
  assert.equal(brainEnvValue(home, "OPENROUTER_API_KEY"), "fake-key-from-the-file");
  assert.equal(brainEnvValue(home, "NOT_IN_THE_FILE"), undefined);
});

test("brainEnvValue holds the same file-permission line credentialEnvFrom does", () => {
  const home = recordHome({ content: "OPENROUTER_API_KEY=fake\n", mode: 0o644 });
  assert.throws(() => brainEnvValue(home, "OPENROUTER_API_KEY"), (err: Error) => err.message.includes("chmod 600"));
  assert.equal(brainEnvValue(recordHome(), "OPENROUTER_API_KEY"), undefined, "a missing file is simply not configured");
});

test("defaultBrainAdapter names the selected brain before its first call, and never throws while being built", () => {
  const home = recordHome({ content: "FABRICA_BRAIN=openai-compatible\n", mode: 0o644 });
  // A badly-permissioned brain.env is reported by the first real call,
  // not by building the adapter - an `accept` verdict needs no worker.
  assert.equal(defaultBrainAdapter(home).name, "claude-code");

  const previous = { brain: process.env.FABRICA_BRAIN, model: process.env.FABRICA_MODEL };
  process.env.FABRICA_BRAIN = "openai-compatible";
  process.env.FABRICA_MODEL = "named/before-any-call";
  try {
    const brain = defaultBrainAdapter(recordHome());
    assert.equal(brain.name, "openai-compatible");
    assert.equal(brain.model, "named/before-any-call");
  } finally {
    if (previous.brain === undefined) delete process.env.FABRICA_BRAIN;
    else process.env.FABRICA_BRAIN = previous.brain;
    if (previous.model === undefined) delete process.env.FABRICA_MODEL;
    else process.env.FABRICA_MODEL = previous.model;
  }
});

// The reviewer seam (src/reviewer/resolve.ts): "which vendor is the
// worker" has to be answerable, and this is the only directory allowed
// to answer it (CONTRACT rule 8). Asserted here against the literal
// names, because here is the one place those names may be written.
test("workerVendor names the vendor behind whichever worker is selected", () => {
  assert.equal(workerVendor({}, recordHome()), CLI_WORKER_VENDOR, "the flat-rate CLI worker is the default");

  const direct = recordHome({
    content: `${BRAIN_SELECTION_VAR}=${DIRECT_BRAIN_NAME}\n${DIRECT_VARS.model}=some/model\n`,
    mode: 0o600,
  });
  assert.equal(workerVendor({}, direct), DIRECT_WORKER_VENDOR);
  assert.equal(
    workerVendor({ [BRAIN_SELECTION_VAR]: DIRECT_BRAIN_NAME }, recordHome()),
    DIRECT_WORKER_VENDOR,
    "the environment selects a worker the same way brain.env does"
  );
});

test("workerVendor never throws on an unreadable brain.env - the first real call reports that", () => {
  const home = recordHome({ content: `${BRAIN_SELECTION_VAR}=${DIRECT_BRAIN_NAME}\n`, mode: 0o644 });

  assert.equal(workerVendor({}, home), CLI_WORKER_VENDOR);
});

test("the reviewer's vendor and the worker's are different strings, so a collision is detectable", () => {
  assert.notEqual(CLI_WORKER_VENDOR, DIRECT_WORKER_VENDOR);
});
