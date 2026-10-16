// CONTRACT rule 9 — It can't grade its own homework in the dark.
// A worker MAY change the project's checks openly (features change
// behavior; the gate must be able to change with them). What is forbidden
// is the silent version. Fabrica itself runs no host-side watch over the
// gate at all (Client ruling, issue #64 follow-up, 2026-10-08, "Fabrica
// runs no project check on the host") - there is no comparison against a
// pinned baseCommit, no dedicated outcome, nothing. An edit to the
// project's checks, declared or not, commits onto the ordinary
// fabrica/<taskId> branch and is delivered exactly like any other
// outcome. Detection and enforcement both live outside Fabrica entirely:
// .github/workflows/rule9-gate.yml reads the pull request's own diff for
// a touched protected path and blocks the merge from there - the
// declaration (`gateChanges`) rides along on the delivery for the
// Client's benefit, never verified against anything by Fabrica (Client
// ruling, superseding first a force-reset-and-discard design, then a
// branch-rename design, then Fabrica's own host-side git-diff detection).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "../src/index.ts";
import { fakeBrain } from "./helpers/fake-brain.ts";
import { fakeInspector } from "./helpers/fake-inspector.ts";
import { makeFixtureRepo } from "./helpers/fixture.ts";

test("rule 9: an UNDECLARED edit to the project's checks is delivered like any other outcome, never discarded or specially flagged", async () => {
  const project = makeFixtureRepo("exit 1"); // the honest gate would fail...
  const cheat = fakeBrain({
    onWork: (workdir) => {
      // ...so the worker silently rewrites the check to pass, and commits
      // its own tampered work itself - a Worker has full git access
      // inside the worktree, so this must be handled exactly like an
      // uncommitted edit, not miss it because it was already committed.
      writeFileSync(join(workdir, "check.sh"), "#!/bin/sh\nexit 0\n");
      writeFileSync(join(workdir, "feature.txt"), "possibly good work\n");
      execFileSync("git", ["add", "-A"], { cwd: workdir, stdio: "ignore" });
      execFileSync("git", ["-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "worker-commit"], {
        cwd: workdir,
        stdio: "ignore",
      });
    },
  });

  const foreman = createForeman({ recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")), inspector: fakeInspector("green") });
  const task = await foreman.do("make the build green", { project, brain: cheat });

  const delivery = await foreman.deliveryOf(task.id);
  assert.ok(delivery, "no delivery record at all");
  // Fabrica does not compare the gate against any baseline any more - an
  // undeclared edit that makes the check pass is just a green delivery,
  // the same as any honest one. Catching the silent rewrite is entirely
  // .github/workflows/rule9-gate.yml's job, reading the real pull
  // request diff, not something Fabrica's own outcome can say.
  assert.equal(delivery.outcome, "done", "Fabrica must not grade this itself - it has no detection left to do so");
  assert.equal(delivery.gateChanges, "", "nothing was declared, and Fabrica never fills this in on a worker's behalf");

  // The work is not discarded: it stays committed on the ordinary
  // fabrica/<taskId> branch, exactly like any other outcome.
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

  const foreman = createForeman({ recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")), inspector: fakeInspector("green") });
  const task = await foreman.do("change what green means", { project, brain: honest });

  const delivery = await foreman.deliveryOf(task.id);
  assert.ok(delivery, "no delivery record at all");
  assert.equal(delivery.outcome, "done", "a legitimate, declared gate change must deliver normally");
  assert.ok(
    delivery.gateChanges.length > 0,
    "the declaration is missing from the delivery — the Client can't see the gate changed"
  );
});
