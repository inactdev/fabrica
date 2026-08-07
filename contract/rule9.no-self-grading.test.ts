// CONTRACT rule 9 — It can't grade its own homework in the dark.
// A worker MAY change the project's checks openly (features change
// behavior; the gate must be able to change with them). What is forbidden
// is the silent version: an undeclared change to the gate is detected by
// the tool — it made the copy, it knows the before-state — and the work
// is recorded as discarded-protected-path. The work itself is never
// thrown away: it stays committed on the ordinary fabrica/<taskId> branch
// like any other outcome, reviewable. Enforcement lives outside Fabrica
// entirely now: .github/workflows/rule9-gate.yml reads the pull request's
// own diff for a touched protected path and blocks the merge from there,
// so Fabrica's own detection can't also be the thing a bug in it, or an
// evading Worker, fools (Client ruling, superseding first a force-reset-
// and-discard design, then a branch-rename design).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "../src/index.ts";
import { fakeBrain } from "./helpers/fake-brain.ts";
import { makeFixtureRepo } from "./helpers/fixture.ts";

test("rule 9: an UNDECLARED edit to the project's checks is recorded, not discarded", async () => {
  const project = makeFixtureRepo("exit 1"); // honest gate would fail...
  const cheat = fakeBrain({
    onWork: (workdir) => {
      // ...so the cheating worker silently rewrites the check to pass,
      // and commits its own tampered work itself - a Worker has full git
      // access inside the worktree, so detection must catch this exactly
      // like an uncommitted edit, not miss it because it was already
      // committed.
      writeFileSync(join(workdir, "check.sh"), "#!/bin/sh\nexit 0\n");
      writeFileSync(join(workdir, "feature.txt"), "possibly good work\n");
      execFileSync("git", ["add", "-A"], { cwd: workdir, stdio: "ignore" });
      execFileSync("git", ["-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "worker-commit"], {
        cwd: workdir,
        stdio: "ignore",
      });
    },
  });

  const foreman = createForeman({ recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")) });
  const task = await foreman.do("make the build green", { project, brain: cheat });

  const delivery = await foreman.deliveryOf(task.id);
  assert.ok(delivery, "no delivery record at all");
  assert.equal(
    delivery.outcome,
    "discarded-protected-path",
    "a silent gate edit was not caught - rule 9 broken"
  );

  const receipts = await foreman.receiptsOf(task.id);
  assert.ok(
    receipts.some((r) => r.outcome === "discarded-protected-path"),
    "the violation is not on the receipt - rules 5+9 broken"
  );

  // The work is not discarded: it stays committed on the ordinary
  // fabrica/<taskId> branch, exactly like any other outcome. Enforcement
  // is .github/workflows/rule9-gate.yml's job now, reading the pull
  // request's own diff - not something Fabrica marks on the branch itself.
  const branch = `fabrica/${task.id}`;
  assert.equal(delivery.branch, branch, "delivery.branch must stay the ordinary branch, not a special name");
  assert.ok(
    delivery.files.includes("feature.txt"),
    "the worker's file must survive on the branch, not come back empty"
  );

  const content = execFileSync("git", ["show", `${branch}:feature.txt`], {
    cwd: project,
    encoding: "utf8",
  });
  assert.equal(content, "possibly good work\n", "the branch must carry the worker's real content, not a stub");
});

test("rule 9: a DECLARED gate change is delivered, declaration attached", async () => {
  const project = makeFixtureRepo("exit 1"); // encodes the old truth...
  const honest = fakeBrain({
    onWork: (workdir) => {
      // ...and the brief legitimately changes that truth.
      writeFileSync(join(workdir, "check.sh"), "#!/bin/sh\nexit 0\n");
    },
    gateChanges: "check.sh: the brief changes the pass condition",
  });

  const foreman = createForeman({ recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")) });
  const task = await foreman.do("change what green means", { project, brain: honest });

  const delivery = await foreman.deliveryOf(task.id);
  assert.ok(delivery, "no delivery record at all");
  assert.notEqual(
    delivery.outcome,
    "discarded-protected-path",
    "an openly declared gate change was blocked - amended rule 9 broken"
  );
  assert.ok(
    delivery.gateChanges.length > 0,
    "the declaration is missing from the delivery — the Client can't see the gate changed"
  );
});
