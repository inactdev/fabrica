// `fabrica doctor`'s Inspector-side checks: a GitHub token Inspector can
// use, and an installed Inspector that takes -branch and is not behind
// origin main's tip.
//
// Every probe is faked here - a fake `inspector`, `go` and `git` on a
// throwaway PATH, and an injected ancestry answer - so the default `npm
// test` run reads no real binary, asks GitHub nothing, and fetches
// nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommitAncestry } from "./ancestry.ts";
import {
  INSPECTOR_MODULE_PATH,
  githubTokenStatus,
  inspectorBranchStatus,
  inspectorInstallArgs,
  inspectorInstallCommand,
  inspectorVersionCheck,
  parseGoBuildInfo,
  pseudoVersionCommit,
  type InspectorBuild,
} from "./doctor-checks.ts";

function pathWithAll(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-doctor-insp-"));
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return `${dir}:/usr/bin:/bin`;
}

function pathWith(name: string, body: string): string {
  return pathWithAll({ [name]: body });
}

const MAIN_TIP = "4f297d8be50e4f5b24460b5813ca50729d6413f9";
const INSTALL_FIX = `go install github.com/inactdev/inspector/cmd/inspector@${MAIN_TIP}`;

/** The ancestry answer, injected: the one probe that would otherwise
 * fetch a commit graph over the network. `never` is the default so a
 * test that should not reach it fails loudly rather than quietly
 * fetching. */
function ancestry(answer: CommitAncestry | "never" = "never"): (commit: string) => CommitAncestry {
  return () => {
    if (answer === "never") throw new Error("ancestry must not be asked here");
    return answer;
  };
}

/** `go version -m` output as a real one prints it - tab-indented,
 * tab-separated records. The installed shape comes from a real
 * `go install github.com/inactdev/inspector/cmd/inspector@latest`; the
 * checkout shape from a real `go build` in a clone of the same
 * repository. */
function goBuildInfo(records: string[]): string {
  return ["/some/where/inspector: go1.26.8", ...records.map((record) => `\t${record}`)].join("\n") + "\n";
}

const INSTALLED_AT_MAIN = goBuildInfo([
  `path\t${INSPECTOR_MODULE_PATH}/cmd/inspector`,
  `mod\t${INSPECTOR_MODULE_PATH}\tv0.0.0-20261020120900-4f297d8be50e\th1:hQlv4AJxRNRJvpNSw1xlZimmOv/T8qlGdSbfYkaxvtE=`,
  "build\t-buildmode=exe",
  `dep\tgithub.com/some/other\tv1.4.0\th1:aaaa=`,
]);

const INSTALLED_BEHIND_MAIN = goBuildInfo([
  `path\t${INSPECTOR_MODULE_PATH}/cmd/inspector`,
  `mod\t${INSPECTOR_MODULE_PATH}\tv0.0.0-20260901093000-1a2b3c4d5e6f\th1:aaaa=`,
]);

const BUILT_FROM_CHECKOUT = goBuildInfo([
  `path\t${INSPECTOR_MODULE_PATH}/cmd/inspector`,
  `mod\t${INSPECTOR_MODULE_PATH}\tv0.0.0-20260901093000-1a2b3c4d5e6f+dirty\t`,
  "build\tvcs=git",
  "build\tvcs.revision=1a2b3c4d5e6f78901234567890abcdef12345678",
  "build\tvcs.modified=true",
]);

/** An Inspector that answers -branch, a `go` that reports `info` for it,
 * and a `git` that answers `ls-remote` with `tip`. Nothing here touches
 * the real network, the real Go toolchain or a real Inspector. */
function inspectorOn(info: string, tip: string | null): string {
  return pathWithAll({
    inspector: "echo '  -branch string'; exit 0",
    go: `cat <<'EOF'\n${info}EOF`,
    git: tip === null ? "exit 128" : `printf '%s\\trefs/heads/main\\n' ${tip}`,
  });
}

test("GitHub token: GITHUB_TOKEN set is OK, never showing it", () => {
  const status = githubTokenStatus({ PATH: "/usr/bin:/bin", GITHUB_TOKEN: "fake-gh-1" });
  assert.equal(status.ok, true);
  assert.match(status.detail, /GITHUB_TOKEN/);
  assert.ok(!JSON.stringify(status).includes("fake-gh-1"));
});

test("GitHub token: unset but gh auth token works is OK, never showing it", () => {
  const status = githubTokenStatus({ PATH: pathWith("gh", "echo fake-gh-2") });
  assert.equal(status.ok, true);
  assert.match(status.detail, /gh auth token/);
  assert.ok(!JSON.stringify(status).includes("fake-gh-2"));
});

test("GitHub token: unset and gh missing or logged out fails, with gh auth login as the fix", () => {
  for (const PATH of ["/usr/bin:/bin", pathWith("gh", "exit 1")]) {
    const status = githubTokenStatus({ PATH });
    assert.equal(status.ok, false);
    assert.match(status.fix ?? "", /gh auth login/);
  }
});

test("Inspector: on PATH, -h shows -branch, built from origin main's tip is OK", () => {
  const status = inspectorBranchStatus({ PATH: inspectorOn(INSTALLED_AT_MAIN, MAIN_TIP) }, "inspector", ancestry());
  assert.equal(status.ok, true);
  assert.match(status.detail, /-branch/);
  assert.match(status.detail, /commit 4f297d8be50e, up to date with origin main/);
});

test("Inspector: a binary behind origin main fails, printing the exact install command", () => {
  const status = inspectorBranchStatus({ PATH: inspectorOn(INSTALLED_BEHIND_MAIN, MAIN_TIP) }, "inspector", ancestry("behind"));
  assert.equal(status.ok, false);
  assert.match(status.detail, /commit 1a2b3c4d5e6f is behind origin main, which is at 4f297d8be50e/);
  assert.equal(status.fix, INSTALL_FIX);
});

test("Inspector: a commit ahead of origin main, or on a branch, passes - different is not behind", () => {
  const status = inspectorBranchStatus({ PATH: inspectorOn(INSTALLED_BEHIND_MAIN, MAIN_TIP) }, "inspector", ancestry("not-behind"));
  assert.equal(status.ok, true);
  assert.match(status.detail, /commit 1a2b3c4d5e6f is not behind origin main, which is at 4f297d8be50e/);
  assert.match(status.detail, /ahead of main, or built from a branch/);
  assert.equal(status.fix, undefined);
});

test("Inspector: an ancestry lookup that failed passes too, never reported as behind", () => {
  const status = inspectorBranchStatus({ PATH: inspectorOn(INSTALLED_BEHIND_MAIN, MAIN_TIP) }, "inspector", ancestry("unknown"));
  assert.equal(status.ok, true);
  assert.match(status.detail, /whether it is behind origin main \(at 4f297d8be50e\) could not be checked/);
  assert.equal(status.fix, undefined, "nothing to fix: this is a lookup that failed, not a stale binary");
});

test("Inspector: a local build passes, naming its commit and its uncommitted changes", () => {
  const status = inspectorBranchStatus({ PATH: inspectorOn(BUILT_FROM_CHECKOUT, MAIN_TIP) }, "inspector", ancestry());
  assert.equal(status.ok, true);
  assert.match(status.detail, /a local build at commit 1a2b3c4d5e6f with uncommitted changes/);
  assert.equal(status.fix, undefined);
});

test("Inspector: an unreachable origin main passes with a note, never a FAIL", () => {
  const status = inspectorBranchStatus({ PATH: inspectorOn(INSTALLED_BEHIND_MAIN, null) }, "inspector", ancestry());
  assert.equal(status.ok, true);
  assert.match(status.detail, /could not check origin main/);
});

test("Inspector: on PATH but -h has no -branch fails - Fabrica's call would be refused", () => {
  const path = pathWithAll({
    inspector: "echo '  -repo string'; exit 0",
    git: `printf '%s\\trefs/heads/main\\n' ${MAIN_TIP}`,
  });
  const status = inspectorBranchStatus({ PATH: path }, "inspector", ancestry());
  assert.equal(status.ok, false);
  assert.match(status.detail, /-branch/);
  assert.equal(status.fix, INSTALL_FIX, "the fix is the same install, at main's tip");
});

test("Inspector: not on PATH fails, saying tasks will be self-tested, with the go install fix", () => {
  const path = pathWith("git", `printf '%s\\trefs/heads/main\\n' ${MAIN_TIP}`);
  const status = inspectorBranchStatus({ PATH: path }, "inspector", ancestry());
  assert.equal(status.ok, false);
  assert.match(status.detail, /not on PATH/);
  assert.match(status.detail, /self-tested/);
  assert.equal(status.fix, INSTALL_FIX);
});

test("Inspector: nothing installed and no answer from the remote still prints an install fix, at latest", () => {
  const status = inspectorBranchStatus({ PATH: pathWith("git", "exit 128") }, "inspector", ancestry());
  assert.equal(status.ok, false);
  assert.equal(status.fix, "go install github.com/inactdev/inspector/cmd/inspector@latest");
});

test("Inspector build: a pseudo-version carries the commit; a tag carries none", () => {
  assert.equal(pseudoVersionCommit("v0.0.0-20261020120900-4f297d8be50e"), "4f297d8be50e");
  assert.equal(pseudoVersionCommit("v0.0.0-20261020120900-4f297d8be50e+dirty"), "4f297d8be50e");
  assert.equal(pseudoVersionCommit("v1.2.4-pre.0.20261020120900-4f297d8be50e"), "4f297d8be50e");
  assert.equal(pseudoVersionCommit("v1.2.3"), null);
  assert.equal(pseudoVersionCommit("(devel)"), null);
  assert.equal(pseudoVersionCommit(null), null);
});

test("Inspector build: an installed binary's commit comes from its module version, a dep's never", () => {
  const build = parseGoBuildInfo(INSTALLED_AT_MAIN, INSPECTOR_MODULE_PATH);
  assert.equal(build.commit, "4f297d8be50e");
  assert.equal(build.version, "v0.0.0-20261020120900-4f297d8be50e");
  assert.equal(build.fromCheckout, false);
  assert.equal(build.dirty, false);
  assert.equal(build.unreadable, null);
});

test("Inspector build: a checkout build's commit comes from vcs.revision, in full", () => {
  const build = parseGoBuildInfo(BUILT_FROM_CHECKOUT, INSPECTOR_MODULE_PATH);
  assert.equal(build.commit, "1a2b3c4d5e6f78901234567890abcdef12345678");
  assert.equal(build.fromCheckout, true);
  assert.equal(build.dirty, true);
});

test("Inspector build: a binary from some other module, or none at all, is unreadable not wrong", () => {
  const other = parseGoBuildInfo(goBuildInfo(["mod\texample.com/other\tv1.0.0\t"]), INSPECTOR_MODULE_PATH);
  assert.match(other.unreadable ?? "", /example\.com\/other/);
  assert.equal(other.commit, null);
  assert.match(parseGoBuildInfo("", INSPECTOR_MODULE_PATH).unreadable ?? "", /no module information/);
});

const BEHIND: InspectorBuild = {
  version: "v0.0.0-20260901093000-1a2b3c4d5e6f",
  commit: "1a2b3c4d5e6f",
  fromCheckout: false,
  dirty: false,
  unreadable: null,
};

test("Inspector version: a build nothing could read, or that records no commit, passes with a note", () => {
  const unreadable = inspectorVersionCheck({ ...BEHIND, commit: null, unreadable: "`go` is not on PATH" }, MAIN_TIP, ancestry());
  assert.equal(unreadable.ok, true);
  assert.equal(unreadable.state, "unreadable");
  assert.match(unreadable.note, /`go` is not on PATH/);

  const tagged = inspectorVersionCheck({ ...BEHIND, version: "v1.2.3", commit: null }, MAIN_TIP, ancestry());
  assert.equal(tagged.ok, true);
  assert.equal(tagged.state, "no-commit");
  assert.match(tagged.note, /no commit to check against origin main \(module version v1\.2\.3\)/);
});

test("Inspector version: a local build is left to itself, with no ancestry lookup at all", () => {
  const ahead = inspectorVersionCheck({ ...BEHIND, fromCheckout: true }, MAIN_TIP, ancestry());
  assert.equal(ahead.ok, true);
  assert.equal(ahead.state, "local-build");
  assert.match(ahead.note, /a local build at commit 1a2b3c4d5e6f \(origin main is at 4f297d8be50e\)/);
  assert.equal(ahead.fix, undefined);
});

test("Inspector version: a 12-hex module commit matches main's full sha, and asks no ancestry either", () => {
  const current = inspectorVersionCheck({ ...BEHIND, commit: MAIN_TIP.slice(0, 12) }, MAIN_TIP, ancestry());
  assert.equal(current.ok, true);
  assert.equal(current.state, "current");
  assert.match(current.note, /up to date with origin main/);
});

test("Inspector version: an unreachable origin main asks no ancestry - there is nothing to compare with", () => {
  const noMain = inspectorVersionCheck(BEHIND, null, ancestry());
  assert.equal(noMain.ok, true);
  assert.equal(noMain.state, "no-main");
  assert.match(noMain.note, /could not check origin main/);
});

test("Inspector version: the fix pins the sha it compared against, not @latest", () => {
  assert.equal(inspectorInstallCommand(MAIN_TIP), INSTALL_FIX);
  const behind = inspectorVersionCheck(BEHIND, MAIN_TIP, ancestry("behind"));
  assert.equal(behind.state, "behind");
  assert.equal(behind.fix, inspectorInstallCommand(MAIN_TIP));
});

// One spelling of the install: what every message prints and what
// `goInstallInspector` actually runs are built from the same package
// path, so neither can name a command the other wouldn't.
test("Inspector version: the printed install command and the args that run it are the same command", () => {
  assert.equal(inspectorInstallCommand(MAIN_TIP), `go ${inspectorInstallArgs(MAIN_TIP).join(" ")}`);
  assert.equal(inspectorInstallCommand("latest"), `go ${inspectorInstallArgs("latest").join(" ")}`);
});
