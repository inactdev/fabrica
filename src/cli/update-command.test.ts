// `fabrica update`: works out dev-checkout vs. installed copy (the
// same question doctor's own "checkout" check answers), updates
// accordingly, then reuses up-command.ts's own stale-live-view check to
// decide whether to restart the live view. Every probe here is
// injected, so no test ever runs a real `git pull`, `npm install`, or
// touches this repo's own working tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CopyInfo } from "./doctor-command.ts";
import { runUpdateCommand, type UpdateProbes } from "./update-command.ts";

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

function neverCalled(label: string) {
  return () => {
    throw new Error(`must not be called: ${label}`);
  };
}

/** A dev-checkout fixture whose `copy()` reports whatever `pull()` last
 * left as the commit - mirrors the real detectCopy's own "re-derive
 * live every call" behavior, so a test can tell the before/after
 * commits apart without touching real git. */
// Exactly 12 characters each - doctor-command.ts's `short()` slices a
// commit to 12 chars for display, so these pass through unchanged and
// the summary-line assertions below can match them literally.
const BEFORE_COMMIT = "before000001";
const AFTER_COMMIT = "after0000001";
const OLD_BUILD_COMMIT = "oldbuild0001";
const NEW_BUILD_COMMIT = "newbuild0001";

function devCheckoutProbes(overrides: Partial<UpdateProbes> = {}): UpdateProbes {
  let commit = BEFORE_COMMIT;
  const base: UpdateProbes = {
    copy: (): CopyInfo => ({ kind: "dev-checkout", root: "/fake/checkout", branch: "master", commit, version: "0.0.0" }),
    isDirty: () => false,
    pull: () => {
      commit = AFTER_COMMIT;
      return { ok: true, message: "Updating abc123..def456\nFast-forward" };
    },
    reinstall: neverCalled("reinstall on a dev checkout"),
  };
  return { ...base, ...overrides };
}

function installedProbes(overrides: Partial<UpdateProbes> = {}): UpdateProbes {
  let commit = OLD_BUILD_COMMIT;
  const base: UpdateProbes = {
    copy: (): CopyInfo => ({ kind: "installed", root: "/fake/install", branch: null, commit, version: "1.2.3" }),
    isDirty: neverCalled("isDirty on an installed copy"),
    pull: neverCalled("pull on an installed copy"),
    reinstall: () => {
      commit = NEW_BUILD_COMMIT;
      return { ok: true, message: "" };
    },
  };
  return { ...base, ...overrides };
}

const liveViewNotListening = { isLiveViewListening: async () => false };

test("runUpdateCommand: an unknown flag is refused with exact instructions, not ignored", async () => {
  const io = captureIo();
  const code = await runUpdateCommand(["--json"], { ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.match(io.err[0], /unknown flag "--json"/);
  assert.match(io.err[0], /Usage: fabrica update/);
});

test("runUpdateCommand: a stray positional is refused, not silently ignored", async () => {
  const io = captureIo();
  const code = await runUpdateCommand(["oops"], { ...io });

  assert.equal(code, 1);
  assert.match(io.err[0], /unexpected argument "oops"/);
  assert.match(io.err[0], /update takes none/);
});

test("runUpdateCommand: a dev checkout on master with no local changes is pulled", async () => {
  const io = captureIo();
  let pulledRoot: string | undefined;
  const probes = devCheckoutProbes();
  const realPull = probes.pull;
  probes.pull = (root) => {
    pulledRoot = root;
    return realPull(root);
  };

  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes, ...liveViewNotListening, ...io });

  assert.equal(code, 0, io.err.join("\n"));
  assert.equal(pulledRoot, "/fake/checkout");
  assert.match(io.out.join("\n"), new RegExp(`${BEFORE_COMMIT} -> ${AFTER_COMMIT}`));
});

test("runUpdateCommand: a dirty checkout is refused with a clear message, and never pulled", async () => {
  const io = captureIo();
  const probes = devCheckoutProbes({
    isDirty: () => true,
    pull: neverCalled("pull on a dirty checkout"),
  });

  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes, ...liveViewNotListening, ...io });

  assert.equal(code, 1);
  assert.match(io.err.join("\n"), /uncommitted changes/i);
  assert.deepEqual(io.out, []);
});

test("runUpdateCommand: a checkout not on master is refused with a clear message, and never pulled", async () => {
  const io = captureIo();
  const probes = devCheckoutProbes({
    copy: () => ({ kind: "dev-checkout", root: "/fake/checkout", branch: "some-feature", commit: "deadbeef0000", version: "0.0.0" }),
    pull: neverCalled("pull on a non-master checkout"),
  });

  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes, ...liveViewNotListening, ...io });

  assert.equal(code, 1);
  assert.match(io.err.join("\n"), /not master/i);
  assert.match(io.err.join("\n"), /some-feature/);
  assert.deepEqual(io.out, []);
});

test("runUpdateCommand: a failed git pull --ff-only is reported and refuses", async () => {
  const io = captureIo();
  const probes = devCheckoutProbes({
    pull: () => ({ ok: false, message: "fatal: Not possible to fast-forward, aborting." }),
  });

  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes, ...liveViewNotListening, ...io });

  assert.equal(code, 1);
  assert.match(io.err.join("\n"), /fatal: Not possible to fast-forward/);
});

test("runUpdateCommand: an installed copy re-runs the documented install command", async () => {
  const io = captureIo();
  let reinstallCalls = 0;
  const probes = installedProbes();
  const realReinstall = probes.reinstall;
  probes.reinstall = () => {
    reinstallCalls += 1;
    return realReinstall();
  };

  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes, ...liveViewNotListening, ...io });

  assert.equal(code, 0, io.err.join("\n"));
  assert.equal(reinstallCalls, 1);
  assert.match(io.out.join("\n"), new RegExp(`${OLD_BUILD_COMMIT} -> ${NEW_BUILD_COMMIT}`));
});

test("runUpdateCommand: a failed install is reported and refuses", async () => {
  const io = captureIo();
  const probes = installedProbes({
    reinstall: () => ({ ok: false, message: "npm error 404 Not Found" }),
  });

  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes, ...liveViewNotListening, ...io });

  assert.equal(code, 1);
  assert.match(io.err.join("\n"), /npm error 404 Not Found/);
});

test("runUpdateCommand: no live view listening is left alone, and the summary says so", async () => {
  const io = captureIo();
  const probes = devCheckoutProbes();

  const code = await runUpdateCommand([], {
    recordHome: "/fake/home",
    probes,
    isLiveViewListening: async () => false,
    startLiveView: neverCalled("starting a live view that was never running"),
    stopLiveViewProcess: neverCalled("stopping a live view that was never running"),
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.match(io.out.join("\n"), /live view left as is/);
  assert.match(io.out.join("\n"), /fabrica up --continue/);
});

test("runUpdateCommand: a live view already running the new commit is left alone", async () => {
  const io = captureIo();
  const probes = devCheckoutProbes();
  let stopped = false;

  const code = await runUpdateCommand([], {
    recordHome: "/fake/home",
    probes,
    isLiveViewListening: async () => true,
    fetchLiveViewVersion: async () => AFTER_COMMIT,
    stopLiveViewProcess: () => {
      stopped = true;
    },
    startLiveView: neverCalled("starting a fresh live view when the current one is already current"),
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.equal(stopped, false);
  assert.match(io.out.join("\n"), /live view left as is/);
});

test("runUpdateCommand: a stale live view is stopped and restarted, and the summary says so", async () => {
  const io = captureIo();
  const probes = devCheckoutProbes();
  let listening = true;
  let stoppedPid: number | null = null;
  let startCalls = 0;

  const code = await runUpdateCommand([], {
    recordHome: "/fake/home",
    probes,
    isLiveViewListening: async () => listening,
    fetchLiveViewVersion: async () => "stale-commit",
    findLiveViewProcess: () => ({ pid: 4242 }),
    stopLiveViewProcess: (pid) => {
      stoppedPid = pid;
      listening = false;
    },
    startLiveView: () => {
      startCalls += 1;
      listening = true;
    },
    openBrowser: () => {},
    liveViewStartTimeoutMs: 2_000,
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.equal(stoppedPid, 4242);
  assert.equal(startCalls, 1);
  assert.match(io.out.join("\n"), /live view restarted/);
  assert.match(io.out.join("\n"), /fabrica up --continue/);
});
