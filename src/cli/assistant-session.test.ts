// Issue #359: who a verdict or an answer is recorded as having been run
// by. The whole module is two pure functions, so these are plain
// value-in/value-out assertions - what matters is the direction each
// one fails in, which is why the "fails closed" cases are here one by
// one rather than as a single truthiness check.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ASSISTANT_SESSION_ENV, assistantSessionEnv, ranViaAssistant, VIA_ASSISTANT_NOTE } from "./assistant-session.ts";

test("ranViaAssistant: the sentinel set to 1 means the assistant ran it", () => {
  assert.equal(ranViaAssistant({ [ASSISTANT_SESSION_ENV]: "1" }), true);
});

test("ranViaAssistant: anything but the exact string 1 is the Client's own", () => {
  // Every one of these fails in the safe direction. The error this
  // ordering exists to prevent is the other one: writing the
  // assistant's name onto a ruling the Client typed himself, which
  // would quietly contradict the only thing CONTRACT rule 6 asks the
  // record to keep straight.
  for (const value of ["", "0", "false", "no", "2", "true", " 1", "1 "]) {
    assert.equal(
      ranViaAssistant({ [ASSISTANT_SESSION_ENV]: value }),
      false,
      `the sentinel set to ${JSON.stringify(value)} must not be read as the assistant's`
    );
  }
  assert.equal(ranViaAssistant({}), false, "no sentinel at all must not be read as the assistant's");
});

test("ranViaAssistant: an unrelated environment variable never decides this", () => {
  assert.equal(ranViaAssistant({ FABRICA_HOME: "/tmp/x", CI: "1", TERM: "xterm" }), false);
});

test("ranViaAssistant: the explicit flag overrides the environment in both directions", () => {
  // --via-assistant in a session fabrica up did not start.
  assert.equal(ranViaAssistant({}, true), true);
  // --by-client in a shell that inherited the sentinel - the Client
  // typing in a terminal spawned from his own chat session.
  assert.equal(ranViaAssistant({ [ASSISTANT_SESSION_ENV]: "1" }, false), false);
  // And the flag agreeing with the environment changes nothing.
  assert.equal(ranViaAssistant({ [ASSISTANT_SESSION_ENV]: "1" }, true), true);
  assert.equal(ranViaAssistant({}, false), false);
});

test("assistantSessionEnv: keeps the caller's environment and adds the sentinel", () => {
  const env = assistantSessionEnv({ FABRICA_HOME: "/tmp/home", PATH: "/usr/bin" });
  assert.equal(env.FABRICA_HOME, "/tmp/home");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env[ASSISTANT_SESSION_ENV], "1");
  // The round trip is the actual contract between `fabrica up` and the
  // two commands: whatever this produces must read as the assistant's.
  assert.equal(ranViaAssistant(env), true);
});

test("assistantSessionEnv: does not mutate the environment it was handed", () => {
  const base: NodeJS.ProcessEnv = { FABRICA_HOME: "/tmp/home" };
  assistantSessionEnv(base);
  assert.equal(base[ASSISTANT_SESSION_ENV], undefined);
  assert.equal(ranViaAssistant(base), false);
});

test("the note the record and the terminal share is one string, not two spellings", () => {
  // Cheap, but it is the thing that keeps `fabrica log`'s wording and
  // the two commands' own confirmation line from drifting apart - both
  // read this constant.
  assert.equal(VIA_ASSISTANT_NOTE, "run by the assistant on the Client's instruction");
});

// Issue #359's first two parts are prose, not code: what the assistant
// must do when a delivery arrives (case 4), and the one condition under
// which it may run a verdict or an answer at all (cases 3 and 5).
// Nothing under src/ enforces either - the handbook is appended to the
// session's own system prompt by `fabrica up` and that is the whole
// mechanism - so these read the handbook's own text directly, the same
// way do-args.test.ts pins case 1's `--issue` judgment call and
// rule9-gate.contract-paths.test.ts pins CI wording with no Fabrica code
// behind it to unit-test. The point is not to police the wording: it is
// that a later edit which quietly drops "only after the Client has
// agreed" fails loudly instead of silently handing an assistant the
// Client's last word.
const handbook = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "HANDBOOK.md"), "utf8");

test("HANDBOOK.md case 4: a delivery is shown in full first, then reviewed as a labelled recommendation", () => {
  assert.match(handbook, /Show the note and the diff first, then review it and say what you\s+would do/);
  // The recommendation is the assistant's own, and named as such.
  assert.match(handbook, /clearly labelled\s+recommendation/);
  assert.match(handbook, /which verdict you would pick/);
  // All three rulings are on the table, and a `fix` comes with its note
  // drafted - a recommendation to fix with no note is not actionable.
  assert.match(handbook, /`fix` with the note you would send drafted out in full/);
  // And the flagging duty survives the new opinion: nothing the delivery
  // raises may be softened on the way to him.
  assert.match(handbook, /Don't soften or drop anything the delivery flags/);
  assert.match(handbook, /A recommendation is not a decision/);
});

test("HANDBOOK.md cases 3 and 5: the assistant may run answer and verdict, but only on the Client's own agreement", () => {
  // Said in the same words in both cases, deliberately - these are the
  // two commands that record his judgment.
  const permissions = handbook.match(/\*\*You may run it — but only after he has/g) ?? [];
  assert.equal(
    permissions.length,
    2,
    `expected cases 3 and 5 each to state the condition, found ${permissions.length}`
  );
  assert.match(handbook, /in his own message in\s+this conversation/);
  assert.match(handbook, /name the task \(or plainly refer\s*\n?to the one just discussed\)/);
  // The three things that are never agreement.
  assert.match(handbook, /silence is never agreement/);
  assert.match(handbook, /Each ruling needs\s+its own agreement/);
  assert.match(handbook, /It goes through as\s+agreed/);
});

test("HANDBOOK.md: the record keeps the Client's own rulings and the assistant's apart", () => {
  assert.match(handbook, /recorded as run by you on his instruction/);
  assert.match(handbook, /`fabrica log` says so/);
  // `cost`, `up` and `update` are still denied outright - the deny list
  // did not disappear, it narrowed.
  assert.match(handbook, /`fabrica cost` is owner-only/);
  assert.match(handbook, /`fabrica up` and `fabrica update` are denied/);
});
