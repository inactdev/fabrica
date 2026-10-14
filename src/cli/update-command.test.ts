// `fabrica update`: all external actions (git, npm, the live view probe,
// its /api/version, stopping and starting it) are injected test seams -
// nothing here spawns a real git/npm/pkill process or binds a real
// port, matching up-command.test.ts's own convention for the live view.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CopyInfo } from "./doctor-command.ts";
import { runUpdateCommand } from "./update-command.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-update-home-"));
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

function devCheckout(overrides: Partial<CopyInfo> = {}): CopyInfo {
  return { kind: "dev-checkout", root: "/src/fabrica", branch: "master", commit: "aaa111aaa111", version: "0.0.0", ...overrides };
}

function installedCopy(overrides: Partial<CopyInfo> = {}): CopyInfo {
  return { kind: "installed", root: "/usr/local/lib/fabrica", branch: null, commit: "aaa111aaa111", version: "1.2.3", ...overrides };
}

function neverCalled(name: string) {
  return () => {
    throw new Error(`must not call ${name}`);
  };
}

test("runUpdateCommand: an unknown flag is refused with exact instructions, not ignored", async () => {
  const io = captureIo();
  const code = await runUpdateCommand(["--json"], { recordHome: tempRecordHome(), ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.match(io.err[0], /unknown flag "--json"/);
  assert.match(io.err[0], /Usage: fabrica update/);
});

test("runUpdateCommand: a stray positional is refused, not silently ignored", async () => {
  const io = captureIo();
  const code = await runUpdateCommand(["oops"], { recordHome: tempRecordHome(), ...io });

  assert.equal(code, 1);
  assert.match(io.err[0], /unexpected argument "oops"/);
  assert.match(io.err[0], /update takes none/);
});

test("runUpdateCommand: a clean checkout on master pulls, with no live view listening", async () => {
  const io = captureIo();
  let pulled = false;

  const code = await runUpdateCommand([], {
    recordHome: tempRecordHome(),
    copy: devCheckout({ commit: "aaa111aaa111" }),
    gitStatusPorcelain: () => "",
    gitPullFfOnly: () => {
      pulled = true;
      return { ok: true, message: "" };
    },
    gitRevParseHead: () => "bbb222bbb222",
    isLiveViewListening: async () => false,
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.ok(pulled, "git pull --ff-only must have been called");
  assert.match(io.out[0], /aaa111aaa111 -> bbb222bbb222/);
  assert.match(io.out[0], /not restarted/);
  assert.match(io.out[0], /resume your session with: fabrica up --continue/);
});

test("runUpdateCommand: a checkout off master is refused with the exact message, and never pulls", async () => {
  const io = captureIo();

  const code = await runUpdateCommand([], {
    recordHome: tempRecordHome(),
    copy: devCheckout({ branch: "fm/some-feature" }),
    gitStatusPorcelain: neverCalled("gitStatusPorcelain"),
    gitPullFfOnly: neverCalled("gitPullFfOnly"),
    ...io,
  });

  assert.equal(code, 1);
  assert.match(io.err[0], /this checkout is on "fm\/some-feature", not master/);
  assert.deepEqual(io.out, []);
});

test("runUpdateCommand: a dirty checkout is refused with the exact message, and never pulls", async () => {
  const io = captureIo();

  const code = await runUpdateCommand([], {
    recordHome: tempRecordHome(),
    copy: devCheckout(),
    gitStatusPorcelain: () => " M some-file.ts\n",
    gitPullFfOnly: neverCalled("gitPullFfOnly"),
    ...io,
  });

  assert.equal(code, 1);
  assert.match(io.err[0], /uncommitted changes - commit or stash them first/);
  assert.deepEqual(io.out, []);
});

test("runUpdateCommand: a failed git pull --ff-only is reported and exits non-zero", async () => {
  const io = captureIo();

  const code = await runUpdateCommand([], {
    recordHome: tempRecordHome(),
    copy: devCheckout(),
    gitStatusPorcelain: () => "",
    gitPullFfOnly: () => ({ ok: false, message: "not possible to fast-forward" }),
    ...io,
  });

  assert.equal(code, 1);
  assert.match(io.err[0], /git pull --ff-only origin master failed/);
  assert.match(io.err[0], /not possible to fast-forward/);
});

test("runUpdateCommand: an installed copy re-runs the documented install command", async () => {
  const io = captureIo();
  let installed = false;

  const code = await runUpdateCommand([], {
    recordHome: tempRecordHome(),
    copy: installedCopy({ commit: "aaa111aaa111" }),
    runInstallCommand: () => {
      installed = true;
      return { ok: true, message: "" };
    },
    detectInstalledCommit: () => "ccc333ccc333",
    isLiveViewListening: async () => false,
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.ok(installed, "npm install -g github:inactdev/fabrica must have been run");
  assert.match(io.out[0], /aaa111aaa111 -> ccc333ccc333/);
});

test("runUpdateCommand: a failed install command is reported and exits non-zero", async () => {
  const io = captureIo();

  const code = await runUpdateCommand([], {
    recordHome: tempRecordHome(),
    copy: installedCopy(),
    runInstallCommand: () => ({ ok: false, message: "ENOTFOUND registry.npmjs.org" }),
    ...io,
  });

  assert.equal(code, 1);
  assert.match(io.err[0], /npm install -g github:inactdev\/fabrica failed/);
  assert.match(io.err[0], /ENOTFOUND/);
});

test("runUpdateCommand: a stale live view (different /api/version commit) is stopped and restarted", async () => {
  const io = captureIo();
  let stopped = false;
  let started = false;
  let listening = true;

  const code = await runUpdateCommand([], {
    recordHome: tempRecordHome(),
    copy: devCheckout({ commit: "aaa111aaa111" }),
    gitStatusPorcelain: () => "",
    gitPullFfOnly: () => ({ ok: true, message: "" }),
    gitRevParseHead: () => "bbb222bbb222",
    isLiveViewListening: async () => listening,
    fetchLiveViewCommit: async () => (stopped ? "bbb222bbb222" : "aaa111aaa111"),
    stopLiveView: () => {
      stopped = true;
      listening = false;
      return { ok: true, message: "" };
    },
    startLiveView: () => {
      started = true;
      listening = true;
    },
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.ok(stopped, "the stale live view must have been stopped");
  assert.ok(started, "a fresh live view must have been started");
  assert.match(io.out[0], /live view restarted/);
});

test("runUpdateCommand: a live view already on the new commit is left alone", async () => {
  const io = captureIo();

  const code = await runUpdateCommand([], {
    recordHome: tempRecordHome(),
    copy: devCheckout({ commit: "aaa111aaa111" }),
    gitStatusPorcelain: () => "",
    gitPullFfOnly: () => ({ ok: true, message: "" }),
    gitRevParseHead: () => "bbb222bbb222",
    isLiveViewListening: async () => true,
    fetchLiveViewCommit: async () => "bbb222bbb222",
    stopLiveView: neverCalled("stopLiveView"),
    startLiveView: neverCalled("startLiveView"),
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.match(io.out[0], /live view not restarted/);
});

test("runUpdateCommand: no live view listening at all is left alone, no stop/start attempted", async () => {
  const io = captureIo();

  const code = await runUpdateCommand([], {
    recordHome: tempRecordHome(),
    copy: devCheckout({ commit: "aaa111aaa111" }),
    gitStatusPorcelain: () => "",
    gitPullFfOnly: () => ({ ok: true, message: "" }),
    gitRevParseHead: () => "bbb222bbb222",
    isLiveViewListening: async () => false,
    fetchLiveViewCommit: neverCalled("fetchLiveViewCommit"),
    stopLiveView: neverCalled("stopLiveView"),
    startLiveView: neverCalled("startLiveView"),
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.match(io.out[0], /live view not restarted/);
});
