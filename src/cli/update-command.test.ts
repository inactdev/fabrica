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

/** An installed copy's root is npm's own global layout,
 * `<prefix>/lib/node_modules/fabrica` - which is where `fabrica update`
 * reads the prefix to reinstall into back off (issue #171 / "updatable
 * from wherever it lives"). */
const INSTALL_PREFIX = "/fake/prefix";
const INSTALL_ROOT = `${INSTALL_PREFIX}/lib/node_modules/fabrica`;

function installedProbes(overrides: Partial<UpdateProbes> = {}): UpdateProbes {
  let commit = OLD_BUILD_COMMIT;
  const base: UpdateProbes = {
    copy: (): CopyInfo => ({ kind: "installed", root: INSTALL_ROOT, branch: null, commit, version: "1.2.3" }),
    isDirty: neverCalled("isDirty on an installed copy"),
    pull: neverCalled("pull on an installed copy"),
    reinstall: () => {
      commit = NEW_BUILD_COMMIT;
      return { ok: true, message: "" };
    },
  };
  return { ...base, ...overrides };
}

/** For the tests that never reach the live-view step at all (every
 * refusal below): nothing is listening and nothing may be started. */
const liveViewNotListening = {
  isLiveViewListening: async () => false,
  startLiveView: neverCalled("starting a live view in a run that should have refused first"),
};

/** A live view that is not running but can be started - which is what
 * `fabrica update` now does whenever the commit changed (Client ruling:
 * "if none is running, start one"). `startLiveView` flips the probe to
 * listening, so the post-start wait resolves immediately instead of
 * burning the whole start timeout. */
function startableLiveView() {
  let listening = false;
  const state = { startCalls: 0 };
  return {
    state,
    opts: {
      isLiveViewListening: async () => listening,
      startLiveView: () => {
        state.startCalls += 1;
        listening = true;
      },
      openBrowser: () => {},
      liveViewStartTimeoutMs: 2_000,
    },
  };
}

/** A dev checkout whose pull lands on the commit it was already on -
 * `git pull --ff-only` on an already-current checkout. The commit not
 * changing is what keeps `fabrica update` on its ordinary
 * ask-/api/version-first path instead of the forced restart. */
function alreadyCurrentProbes(): UpdateProbes {
  return devCheckoutProbes({ pull: () => ({ ok: true, message: "Already up to date." }) });
}

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

  const live = startableLiveView();
  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes, ...live.opts, ...io });

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

test("runUpdateCommand: an installed copy re-runs the documented install command, into the prefix it lives under", async () => {
  const io = captureIo();
  const prefixes: string[] = [];
  const probes = installedProbes();
  const realReinstall = probes.reinstall;
  probes.reinstall = (prefix) => {
    prefixes.push(prefix);
    return realReinstall(prefix);
  };

  const live = startableLiveView();
  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes, ...live.opts, ...io });

  assert.equal(code, 0, io.err.join("\n"));
  // Derived from the running copy's own path, never npm's default -
  // which on a Nix-managed host is a read-only store path.
  assert.deepEqual(prefixes, [INSTALL_PREFIX]);
  assert.match(io.out.join("\n"), new RegExp(`${OLD_BUILD_COMMIT} -> ${NEW_BUILD_COMMIT}`));
});

test("runUpdateCommand: a failed install is reported, naming the exact command that ran", async () => {
  const io = captureIo();
  const probes = installedProbes({
    reinstall: () => ({ ok: false, message: "npm error 404 Not Found" }),
  });

  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes, ...liveViewNotListening, ...io });

  assert.equal(code, 1);
  assert.match(io.err.join("\n"), /npm error 404 Not Found/);
  assert.match(io.err.join("\n"), new RegExp(`npm install -g --prefix ${INSTALL_PREFIX} github:inactdev/fabrica`));
});

test("runUpdateCommand: a copy that is neither a checkout nor a global install is refused, never reinstalled", async () => {
  const io = captureIo();
  // What `npx fabrica update` runs: a throwaway copy in npx's own
  // cache, under no npm prefix at all.
  const probes = installedProbes({
    copy: () => ({
      kind: "installed",
      root: "/home/me/.npm/_npx/0a1b2c3d/node_modules/fabrica",
      branch: null,
      commit: OLD_BUILD_COMMIT,
      version: "1.2.3",
    }),
    reinstall: neverCalled("reinstall of a copy that lives under no npm prefix"),
  });

  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes, ...liveViewNotListening, ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  const err = io.err.join("\n");
  assert.match(err, /_npx/);
  assert.match(err, /needs an installed or checked-out copy/);
  assert.match(err, /npm install -g github:inactdev\/fabrica/);
});

// Client ruling: "Restart unconditionally when the commit changed; if
// none is running, start one; no opt-out flag." This test asserted the
// opposite before that ruling (nothing listening was left stopped) - the
// Client's reason for changing it is that `fabrica update` otherwise
// takes away the live view he was watching a moment earlier, which is
// not something he asked it to do.
test("runUpdateCommand: a changed commit with no live view running starts one, and the summary says so", async () => {
  const io = captureIo();
  const probes = devCheckoutProbes();
  const live = startableLiveView();

  const code = await runUpdateCommand([], {
    recordHome: "/fake/home",
    probes,
    ...live.opts,
    stopLiveViewProcess: neverCalled("stopping a live view that was never running"),
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.equal(live.state.startCalls, 1);
  assert.match(io.out.join("\n"), /live view started/);
  assert.match(io.out.join("\n"), /fabrica up --continue/);
});

// The other half of that ruling: nothing is started when nothing moved.
// An already-up-to-date pull must not conjure a live view the Client
// never had open.
test("runUpdateCommand: an unchanged commit with no live view running leaves it stopped", async () => {
  const io = captureIo();

  const code = await runUpdateCommand([], {
    recordHome: "/fake/home",
    probes: alreadyCurrentProbes(),
    isLiveViewListening: async () => false,
    startLiveView: neverCalled("starting a live view when the commit never changed"),
    stopLiveViewProcess: neverCalled("stopping a live view that was never running"),
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.match(io.out.join("\n"), new RegExp(`${BEFORE_COMMIT} -> ${BEFORE_COMMIT}`));
  assert.match(io.out.join("\n"), /live view left as is/);
});

// Also inverted by that same ruling. A live view reporting the brand-new
// commit immediately after a pull can only have been started inside the
// race between the pull and this check - rare, and not worth trusting:
// "restart unconditionally when the commit changed" means the
// /api/version answer cannot save it, and must not even be asked for.
test("runUpdateCommand: a changed commit restarts the live view without asking its /api/version at all", async () => {
  const io = captureIo();
  const probes = devCheckoutProbes();
  let listening = true;
  let stoppedPid: number | null = null;
  let startCalls = 0;

  const code = await runUpdateCommand([], {
    recordHome: "/fake/home",
    probes,
    isLiveViewListening: async () => listening,
    fetchLiveViewVersion: neverCalled("asking /api/version when the commit is already known to have changed"),
    findLiveViewProcess: () => ({ pid: 99 }),
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
  assert.equal(stoppedPid, 99);
  assert.equal(startCalls, 1);
  assert.match(io.out.join("\n"), /live view restarted/);
});

// The unchanged-commit path still asks, and still leaves a current live
// view exactly where it is.
test("runUpdateCommand: an unchanged commit leaves a live view already on that commit alone", async () => {
  const io = captureIo();
  let stopped = false;

  const code = await runUpdateCommand([], {
    recordHome: "/fake/home",
    probes: alreadyCurrentProbes(),
    isLiveViewListening: async () => true,
    fetchLiveViewVersion: async () => BEFORE_COMMIT,
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

// And the unchanged-commit path still replaces a live view that really
// is stale - one left over from an even older commit, which is what the
// /api/version comparison exists to catch.
test("runUpdateCommand: an unchanged commit still replaces a live view running older code", async () => {
  const io = captureIo();
  let listening = true;
  let stoppedPid: number | null = null;
  let startCalls = 0;

  const code = await runUpdateCommand([], {
    recordHome: "/fake/home",
    probes: alreadyCurrentProbes(),
    isLiveViewListening: async () => listening,
    fetchLiveViewVersion: async () => "much-older-1",
    findLiveViewProcess: () => ({ pid: 1234 }),
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
  assert.equal(stoppedPid, 1234);
  assert.equal(startCalls, 1);
  assert.match(io.out.join("\n"), /live view restarted/);
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
