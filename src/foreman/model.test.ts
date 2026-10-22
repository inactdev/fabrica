// Issue #184: which model a task asked for, which one actually ran, and
// the one thing a receipt may never say again - "default".

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTask, writeTaskFile } from "../record/index.ts";
import { UNKNOWN_MODEL } from "../brain/index.ts";
import {
  describeDeclaration,
  describeModel,
  modelFromEvents,
  modelFromTranscript,
  readModelChoice,
  receiptModel,
  resolveModelChoice,
  writeModelChoice,
} from "./model.ts";
import type { FabricaEvent } from "../record/index.ts";

function home(projectsToml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-model-"));
  if (projectsToml !== undefined) writeFileSync(join(dir, "projects.toml"), projectsToml);
  return dir;
}

function event(name: FabricaEvent["name"], details: unknown): FabricaEvent {
  return { occurredAt: new Date().toISOString(), taskId: "task-1", name, details };
}

// The DONE WHEN the issue states outright: "a test proves 'default' can
// no longer appear in a receipt". receiptModel is the only builder of
// that field anywhere (attempts.ts calls nothing else), so proving it
// here proves it for every receipt - including the case that produced
// every "default" receipt there has ever been: a brain whose own label
// is that placeholder, reporting no model for the call.
test("a receipt can never record a placeholder as the model that ran", () => {
  for (const placeholder of ["default", "unset", "", "  ", "DEFAULT", "unknown"]) {
    assert.equal(
      receiptModel(null, placeholder),
      UNKNOWN_MODEL,
      `"${placeholder}" is not a model name and must never be recorded as one`
    );
    assert.notEqual(receiptModel(null, placeholder), "default");
    // Nor through the other door: a brain reporting a placeholder on the
    // transcript entry itself.
    assert.equal(receiptModel(placeholder, placeholder), UNKNOWN_MODEL);
  }
  assert.notEqual(UNKNOWN_MODEL, "default", "the stand-in must not be the word this issue removed");
});

test("the model a worker reported wins over the brain's own label", () => {
  assert.equal(receiptModel("small-5", "big-9"), "small-5");
  // The label is the fallback, for a brain that reports nothing per call
  // but genuinely knows which model it was configured with.
  assert.equal(receiptModel(null, "big-9"), "big-9");
  assert.equal(receiptModel("  spaced-5  ", null), "spaced-5");
});

test("modelFromTranscript reads the reserved entry, last one winning, and ignores placeholders", () => {
  assert.equal(modelFromTranscript([{ kind: "text", text: "hello" }]), null);
  assert.equal(
    modelFromTranscript([
      { kind: "model", text: "first-5" },
      { kind: "text", text: "work" },
      { kind: "model", text: "second-5" },
    ]),
    "second-5"
  );
  assert.equal(modelFromTranscript([{ kind: "model", text: "default" }]), null);
});

test("resolveModelChoice: the flag beats the project's setting, which beats nothing", () => {
  const recordHome = home(`[projects.thing]\npath = "/proj/thing"\nmodel = "project-5"\n`);

  assert.deepEqual(resolveModelChoice(recordHome, "/proj/thing", "flag-5"), {
    declaredModel: "flag-5",
    modelSource: "flag",
  });
  assert.deepEqual(resolveModelChoice(recordHome, "/proj/thing"), {
    declaredModel: "project-5",
    modelSource: "project",
  });
  // A project with no setting of its own, and an unregistered path, both
  // declare nothing - the brain's own configuration decides.
  assert.deepEqual(resolveModelChoice(recordHome, "/proj/elsewhere"), { declaredModel: null, modelSource: "default" });
  assert.deepEqual(resolveModelChoice(home(), "/proj/thing"), { declaredModel: null, modelSource: "default" });
});

test("resolveModelChoice does not throw on a projects.toml that will not parse", () => {
  // `fabrica do` already refuses on this file long before here (it
  // spends money); a second refusal from this depth would say nothing
  // the first did not.
  const recordHome = home("[caps\nperDayUsd = ");
  assert.deepEqual(resolveModelChoice(recordHome, "/proj/thing"), { declaredModel: null, modelSource: "default" });
});

test("the choice round-trips through the task's own record, and an old task reads as undeclared", () => {
  const recordHome = home();
  const { id } = registerTask(recordHome, "a task");

  assert.deepEqual(readModelChoice(recordHome, id), { declaredModel: null, modelSource: "default" });

  writeModelChoice(recordHome, id, { declaredModel: "small-5", modelSource: "flag" });
  assert.deepEqual(readModelChoice(recordHome, id), { declaredModel: "small-5", modelSource: "flag" });

  // Nothing is ever backfilled onto a task registered before this
  // existed, and a file that cannot be read is that same task.
  writeTaskFile(recordHome, id, "model.json", "{not json");
  assert.deepEqual(readModelChoice(recordHome, id), { declaredModel: null, modelSource: "default" });
});

test("modelFromEvents: the newest receipt's actual model, and the declaration from the moment work starts", () => {
  const started = event("work-started", { project: "/p", declaredModel: "small-5", modelSource: "flag" });

  assert.deepEqual(modelFromEvents([started]), {
    actualModel: null,
    declaredModel: "small-5",
    modelSource: "flag",
  });

  const withReceipts = [
    started,
    event("receipt-recorded", { receipt: { attempt: 1, model: "small-5-20260101", declaredModel: "small-5", modelSource: "flag" } }),
    event("receipt-recorded", { receipt: { attempt: 2, model: "small-5-20260202", declaredModel: "small-5", modelSource: "flag" } }),
  ];
  assert.deepEqual(modelFromEvents(withReceipts), {
    actualModel: "small-5-20260202",
    declaredModel: "small-5",
    modelSource: "flag",
  });

  // A receipt carried only on a delivered event's own list counts too,
  // and a receipt still saying "unknown" reports no actual model rather
  // than that word.
  assert.deepEqual(
    modelFromEvents([event("delivered", { outcome: "done", receipts: [{ attempt: 1, model: "unknown" }] })]),
    { actualModel: null, declaredModel: null, modelSource: "default" }
  );
});

test("describeModel: one wording for every surface, naming both models when they differ", () => {
  assert.equal(describeModel({ actualModel: "big-9", declaredModel: null, modelSource: "default" }), "big-9");
  assert.equal(
    describeModel({ actualModel: null, declaredModel: null, modelSource: "default" }),
    "not reported yet"
  );
  assert.equal(
    describeModel({ actualModel: "small-5", declaredModel: "small-5", modelSource: "flag" }),
    "small-5 (declared via --model)"
  );
  // The case worth seeing: the worker ran something other than what was
  // asked for, so both are named rather than collapsed.
  assert.equal(
    describeModel({ actualModel: "big-9", declaredModel: "small-5", modelSource: "project" }),
    "big-9 (declared small-5 via projects.toml)"
  );
  assert.equal(
    describeModel({ actualModel: null, declaredModel: "small-5", modelSource: "flag" }),
    "not reported yet (declared small-5 via --model)"
  );
  assert.equal(describeDeclaration("small-5", "project"), "small-5 (via projects.toml)");
});
