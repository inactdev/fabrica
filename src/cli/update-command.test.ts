// `fabrica update`: works out dev-checkout vs. installed copy (the
// same question doctor's own "checkout" check answers), updates
// accordingly, then reuses up-command.ts's own stale-live-view check to
// decide whether to restart the live view. Every probe here is
// injected, so no test ever runs a real `git pull`, `npm install`, or
// touches this repo's own working tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommitAncestry, InspectorBuild } from "../index.ts";
import type { CopyInfo } from "./doctor-command.ts";
import { runUpdateCommand, type InspectorUpdateProbes, type UpdateProbes } from "./update-command.ts";

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

/** Inspector's side of the update, all four probes faked: no test reads
 * a real binary's build info, asks GitHub for main's tip, or runs a real
 * `go install`. The default is an Inspector already at main's tip, so
 * every test that is about something else says nothing about Inspector
 * and nothing happens to it. */
const INSPECTOR_MAIN_TIP = "4f297d8be50e4f5b24460b5813ca50729d6413f9";
const INSPECTOR_OLD_COMMIT = "0835e554d251";

/** What `go version -m` would have been parsed into for a binary
 * installed from `commit` - the same shape doctor's own classifier
 * reads, so these fixtures exercise the real one rather than a stub of
 * it. */
function installedAt(commit: string): InspectorBuild {
  return { version: `v0.0.0-20261020120900-${commit}`, commit, fromCheckout: false, dirty: false, unreadable: null };
}

function inspectorProbes(
  overrides: Partial<InspectorUpdateProbes> = {}
): InspectorUpdateProbes & { installs: string[] } {
  const installs: string[] = [];
  const base: InspectorUpdateProbes = {
    build: (): InspectorBuild | null => installedAt(INSPECTOR_MAIN_TIP.slice(0, 12)),
    mainCommit: () => INSPECTOR_MAIN_TIP,
    ancestry: (): CommitAncestry => "behind",
    install: () => ({ ok: true, message: "" }),
  };
  const chosen = { ...base, ...overrides };
  // Every install is recorded whatever the override does with it, so no
  // fixture can quietly defeat the "what was installed" assertion.
  return {
    ...chosen,
    installs,
    install: (revision: string) => {
      installs.push(revision);
      return chosen.install(revision);
    },
  };
}

/** An Inspector that is genuinely behind main until `install` runs,
 * after which its own commit reads as main's tip - so a test can see the
 * before and after the summary line reports. */
function behindInspectorProbes(overrides: Partial<InspectorUpdateProbes> = {}): InspectorUpdateProbes & { installs: string[] } {
  let commit = INSPECTOR_OLD_COMMIT;
  return inspectorProbes({
    build: (): InspectorBuild | null => installedAt(commit),
    install: (revision: string) => {
      commit = revision.slice(0, 12);
      return { ok: true, message: "" };
    },
    ...overrides,
  });
}

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
    inspector: inspectorProbes(),
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
    inspector: inspectorProbes(),
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

test("runUpdateCommand: an installed copy is reinstalled into the prefix it lives under", async () => {
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

// Reinstalling is two npm commands now (global-reinstall.ts: pack the
// spec, install the tarball), so only the step that really ran knows
// which command failed - it names it in the message, and this layer
// passes that through verbatim rather than reconstructing a command of
// its own that might not be the one that broke. The exact commands
// themselves are asserted in global-reinstall.test.ts.
test("runUpdateCommand: a failed install is reported verbatim, command and all, and refuses", async () => {
  const io = captureIo();
  const probes = installedProbes({
    reinstall: (prefix) => ({
      ok: false,
      message: `npm install -g --prefix ${prefix} /tmp/fabrica-update-x1y2/fabrica-0.0.0.tgz failed: npm error EACCES`,
    }),
  });

  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes, ...liveViewNotListening, ...io });

  assert.equal(code, 1);
  assert.equal(
    io.err.join("\n"),
    `fabrica update: npm install -g --prefix ${INSTALL_PREFIX} /tmp/fabrica-update-x1y2/fabrica-0.0.0.tgz ` +
      `failed: npm error EACCES`
  );
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

// Inspector's half of the same update (task: "make fabrica update keep
// Inspector current too"). The deciding rule throughout: nothing here
// may fail the update, and nothing here may replace an Inspector that is
// not genuinely behind main.
test("runUpdateCommand: an Inspector behind main is installed at main's tip, before and after in the summary", async () => {
  const io = captureIo();
  const inspector = behindInspectorProbes();
  const live = startableLiveView();

  const code = await runUpdateCommand([], {
    recordHome: "/fake/home",
    probes: devCheckoutProbes({ inspector }),
    ...live.opts,
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.deepEqual(inspector.installs, [INSPECTOR_MAIN_TIP], "installed at the exact commit main's tip names");
  assert.match(io.out.join("\n"), new RegExp(`inspector ${INSPECTOR_OLD_COMMIT} -> ${INSPECTOR_MAIN_TIP.slice(0, 12)}`));
});

test("runUpdateCommand: no Inspector installed at all is installed fresh at main's tip", async () => {
  const io = captureIo();
  let build: InspectorBuild | null = null;
  const inspector = inspectorProbes({
    build: () => build,
    ancestry: neverCalled("ancestry of a commit that does not exist") as () => CommitAncestry,
    install: (revision) => {
      build = installedAt(revision.slice(0, 12));
      return { ok: true, message: "" };
    },
  });
  const live = startableLiveView();

  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes: devCheckoutProbes({ inspector }), ...live.opts, ...io });

  assert.equal(code, 0, io.err.join("\n"));
  assert.match(io.out.join("\n"), new RegExp(`inspector not installed -> ${INSPECTOR_MAIN_TIP.slice(0, 12)}`));
});

test("runUpdateCommand: an Inspector already at main's tip is left alone, with no ancestry lookup", async () => {
  const io = captureIo();
  const inspector = inspectorProbes({
    ancestry: neverCalled("ancestry of a commit already known to be main's tip") as () => CommitAncestry,
    install: neverCalled("installing over an Inspector that is already current") as (r: string) => { ok: boolean; message: string },
  });
  const live = startableLiveView();

  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes: devCheckoutProbes({ inspector }), ...live.opts, ...io });

  assert.equal(code, 0, io.err.join("\n"));
  assert.match(io.out.join("\n"), /inspector 4f297d8be50e unchanged, already current/);
});

// The task's own rule: "a network failure warns and leaves the install
// alone, never fails update."
test("runUpdateCommand: no answer from the remote warns, installs nothing, and still exits 0", async () => {
  const io = captureIo();
  const inspector = behindInspectorProbes({
    mainCommit: () => null,
    install: neverCalled("installing with no idea what main's tip is") as (r: string) => { ok: boolean; message: string },
  });
  const live = startableLiveView();

  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes: devCheckoutProbes({ inspector }), ...live.opts, ...io });

  assert.equal(code, 0, io.err.join("\n"));
  assert.match(io.err.join("\n"), /could not check origin main \(no network, or git unavailable\)/);
  assert.match(io.err.join("\n"), /left the installed Inspector alone - commit 0835e554d251/);
  assert.match(io.out.join("\n"), /inspector left as is \(couldn't check against main\)/);
  // Fabrica's own update still happened, and still reports itself.
  assert.match(io.out.join("\n"), new RegExp(`${BEFORE_COMMIT} -> ${AFTER_COMMIT}`));
});

test("runUpdateCommand: an ancestry lookup that failed leaves the install alone too, never reinstalling blind", async () => {
  const io = captureIo();
  const inspector = behindInspectorProbes({
    ancestry: () => "unknown",
    install: neverCalled("installing without knowing which way round the two commits are") as (r: string) => { ok: boolean; message: string },
  });
  const live = startableLiveView();

  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes: devCheckoutProbes({ inspector }), ...live.opts, ...io });

  assert.equal(code, 0, io.err.join("\n"));
  assert.match(io.err.join("\n"), /whether it is behind origin main \(at 4f297d8be50e\) could not be checked/);
  assert.match(io.out.join("\n"), /inspector left as is \(couldn't check against main\)/);
});

// The other way a lookup can come back empty, worded as its own case:
// here there is no installed commit to report at all.
test("runUpdateCommand: nothing installed and no answer from the remote installs nothing, and says that", async () => {
  const io = captureIo();
  const inspector = inspectorProbes({
    build: () => null,
    mainCommit: () => null,
    install: neverCalled("installing with no idea what main's tip is") as (r: string) => { ok: boolean; message: string },
  });
  const live = startableLiveView();

  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes: devCheckoutProbes({ inspector }), ...live.opts, ...io });

  assert.equal(code, 0, io.err.join("\n"));
  assert.match(io.err.join("\n"), /no Inspector is installed, and its main could not be read/);
  assert.match(io.out.join("\n"), /inspector left as is \(couldn't check against main\)/);
});

// Not stale, so not replaced: installing main's tip over a commit that
// is ahead of main, or on a branch, is a silent downgrade of a binary
// someone put there on purpose.
test("runUpdateCommand: an Inspector ahead of main or on a branch is left alone, and said so", async () => {
  const io = captureIo();
  const inspector = behindInspectorProbes({
    ancestry: () => "not-behind",
    install: neverCalled("installing over an Inspector that is not behind main") as (r: string) => { ok: boolean; message: string },
  });
  const live = startableLiveView();

  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes: devCheckoutProbes({ inspector }), ...live.opts, ...io });

  assert.equal(code, 0, io.err.join("\n"));
  assert.match(io.err.join("\n"), /is not behind origin main/);
  assert.match(io.out.join("\n"), /inspector left as is \(not behind main\)/);
});

test("runUpdateCommand: an Inspector built from a local source tree is never replaced", async () => {
  const io = captureIo();
  const inspector = inspectorProbes({
    build: () => ({
      version: "v0.0.0-20261021125757-8783916e454a+dirty",
      commit: "8783916e454a78901234567890abcdef12345678",
      fromCheckout: true,
      dirty: true,
      unreadable: null,
    }),
    ancestry: neverCalled("ancestry of a binary built right here") as () => CommitAncestry,
    install: neverCalled("installing over a local build") as (r: string) => { ok: boolean; message: string },
  });
  const live = startableLiveView();

  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes: devCheckoutProbes({ inspector }), ...live.opts, ...io });

  assert.equal(code, 0, io.err.join("\n"));
  assert.match(io.err.join("\n"), /a local build at commit 8783916e454a with uncommitted changes/);
  assert.match(io.out.join("\n"), /inspector left as is \(a local build\)/);
});

// The other way there can be nothing to compare: the binary is there and
// readable, but its own build record names no commit - a release tag, or
// a `-buildvcs=false` build.
test("runUpdateCommand: an Inspector whose build names no commit is left alone, and said so", async () => {
  const io = captureIo();
  const inspector = inspectorProbes({
    build: () => ({ version: "v1.2.3", commit: null, fromCheckout: false, dirty: false, unreadable: null }),
    mainCommit: neverCalled("asking the remote about a commit there isn't one of") as () => string | null,
    ancestry: neverCalled("ordering a commit there isn't one of") as () => CommitAncestry,
    install: neverCalled("installing over a build nothing could be compared with") as (r: string) => { ok: boolean; message: string },
  });
  const live = startableLiveView();

  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes: devCheckoutProbes({ inspector }), ...live.opts, ...io });

  assert.equal(code, 0, io.err.join("\n"));
  assert.match(io.err.join("\n"), /no commit to check against origin main \(module version v1\.2\.3\)/);
  assert.match(io.out.join("\n"), /inspector left as is \(no commit to compare with main\)/);
});

test("runUpdateCommand: a failed go install warns with what go said, and never fails the update", async () => {
  const io = captureIo();
  const inspector = behindInspectorProbes({
    install: () => ({ ok: false, message: "go: module github.com/inactdev/inspector: Get ...: dial tcp: i/o timeout" }),
  });
  const live = startableLiveView();

  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes: devCheckoutProbes({ inspector }), ...live.opts, ...io });

  assert.equal(code, 0, io.err.join("\n"));
  assert.match(io.err.join("\n"), /dial tcp: i\/o timeout/);
  assert.match(io.err.join("\n"), new RegExp(`go install github.com/inactdev/inspector/cmd/inspector@${INSPECTOR_MAIN_TIP} failed`));
  assert.match(io.err.join("\n"), /left as it was/);
  assert.match(io.out.join("\n"), new RegExp(`inspector ${INSPECTOR_OLD_COMMIT} unchanged \\(install failed\\)`));
});

// "Update means everything comes forward" (Client ruling): Fabrica
// already being current is not a reason to leave Inspector behind.
test("runUpdateCommand: Inspector still comes forward when Fabrica itself was already up to date", async () => {
  const io = captureIo();
  const inspector = behindInspectorProbes();

  const code = await runUpdateCommand([], {
    recordHome: "/fake/home",
    probes: { ...alreadyCurrentProbes(), inspector },
    isLiveViewListening: async () => false,
    startLiveView: neverCalled("starting a live view when the commit never changed"),
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.deepEqual(inspector.installs, [INSPECTOR_MAIN_TIP]);
});

test("runUpdateCommand: an update that refuses before touching anything never touches Inspector either", async () => {
  const io = captureIo();
  const probes = devCheckoutProbes({
    isDirty: () => true,
    pull: neverCalled("pull on a dirty checkout"),
    inspector: inspectorProbes({
      build: neverCalled("reading Inspector after a refusal") as () => InspectorBuild | null,
      mainCommit: neverCalled("asking the remote after a refusal") as () => string | null,
      install: neverCalled("installing Inspector after a refusal") as (r: string) => { ok: boolean; message: string },
    }),
  });

  const code = await runUpdateCommand([], { recordHome: "/fake/home", probes, ...liveViewNotListening, ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
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
