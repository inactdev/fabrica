// `fabrica update`'s Inspector seam: the real probes, and the one action
// only that command takes.
//
// Everything about *classifying* a build is `doctor-checks.test.ts`'s,
// since the classifier itself lives there and both callers share it.
// What is left to prove here is that the real probes answer honestly on
// a machine with nothing installed, and that a failing install reports
// rather than throws - the property `fabrica update` leans on to promise
// it can never fail on the Inspector step.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { inspectorInstallArgs, inspectorInstallCommand } from "./doctor-checks.ts";
import {
  directoryIsOnPath,
  goInstallDirectory,
  goInstallInspector,
  inspectorDirectoryOnPath,
  inspectorInstallTarget,
  realInspectorVersionProbes,
} from "./version.ts";

/** A throwaway directory, and a script inside one. */
function scratch(label: string): string {
  return mkdtempSync(join(tmpdir(), `fabrica-inspector-version-${label}-`));
}

function script(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

/** A throwaway PATH holding one script, so nothing here runs a real
 * `go`, a real `git` or a real Inspector. */
function pathWith(name: string, body: string): string {
  const dir = scratch("path");
  script(dir, name, body);
  return `${dir}:/usr/bin:/bin`;
}

test("the real probes: no inspector on PATH is no build at all, not an unreadable one", () => {
  const probes = realInspectorVersionProbes("inspector", { PATH: mkdtempSync(join(tmpdir(), "fabrica-empty-path-")) });
  assert.equal(probes.build(), null, "`fabrica update` installs fresh from this, so it must not look like a bad read");
});

test("the real probes: a binary that is there but tells nothing is a build, reported as unreadable", () => {
  const PATH = pathWith("inspector", "exit 0");
  const probes = realInspectorVersionProbes("inspector", { PATH });
  const build = probes.build();
  assert.notEqual(build, null);
  // No `go` on that PATH, so its own build record cannot be read -
  // which is a state to report, not an absent Inspector to install over.
  assert.match(build?.unreadable ?? "", /go/);
});

test("a failed go install is reported, never thrown - the update must not die on it", () => {
  const PATH = pathWith("go", "echo 'go: module lookup disabled' >&2; exit 1");
  const result = goInstallInspector("4f297d8be50e4f5b24460b5813ca50729d6413f9", { PATH });
  assert.equal(result.ok, false);
  assert.match(result.message, /module lookup disabled/);
});

test("a go that is not there at all is reported too, not thrown", () => {
  const result = goInstallInspector("latest", { PATH: mkdtempSync(join(tmpdir(), "fabrica-empty-path-")) });
  assert.equal(result.ok, false);
  assert.ok(result.message.length > 0);
});

test("a successful go install reports what it printed", () => {
  const PATH = pathWith("go", "echo installed");
  const result = goInstallInspector("latest", { PATH });
  assert.equal(result.ok, true);
  assert.equal(result.message, "installed");
});

// Issue #339: where the install lands. `go install` puts the binary in
// Go's own GOBIN, which has nothing to do with which `inspector` PATH
// resolves - on a host whose dotfiles put `~/.local/bin` on PATH and
// leave Go's default alone, an unpinned install is a silent no-op. These
// tests run a fake `go` that honours $GOBIN exactly as the real one
// documents, so the destination is observed rather than assumed.
const FAKE_MAIN_TIP = "4f297d8be50e4f5b24460b5813ca50729d6413f9";
const FAKE_OLD_COMMIT = "0835e554d251";

/** A stand-in `go` with the three sub-commands this module uses:
 * `install` (writes an `inspector` plus the commit it came from into
 * $GOBIN, or into its own default when GOBIN is unset, exactly as the
 * real one's documented precedence does), `env` (one value per line, and
 * an empty line for an unset GOBIN, as `go env` really prints), and
 * `version -m` (the build record of whichever binary it is handed). */
const FAKE_GO = `
case "$1" in
  install)
    rev=\${2##*@}
    dir=\${GOBIN:-$FAKE_GO_OWN_BIN}
    mkdir -p "$dir"
    printf '#!/bin/sh\\nexit 0\\n' > "$dir/inspector"
    chmod 755 "$dir/inspector"
    printf '%.12s' "$rev" > "$dir/commit"
    exit 0
    ;;
  env)
    shift
    for name in "$@"; do
      case "$name" in
        GOBIN) printf '%s\\n' "$FAKE_GOBIN" ;;
        GOPATH) printf '%s\\n' "$FAKE_GOPATH" ;;
        *) printf '\\n' ;;
      esac
    done
    exit 0
    ;;
  version)
    printf 'go version go1.26.8 darwin/arm64\\n'
    printf '\\tpath\\tgithub.com/inactdev/inspector/cmd/inspector\\n'
    printf '\\tmod\\tgithub.com/inactdev/inspector\\tv0.0.0-20261020120900-%s\\t\\n' "$(cat "$(dirname "$3")/commit")"
    exit 0
    ;;
esac
exit 1`;

/** A machine like the work Mac: `inspector` on PATH in one directory,
 * Go's own GOBIN somewhere else that PATH never reads, and `go` itself
 * in a third. */
function fakeMachine(opts: { inspectorOnPath: boolean; goBinOnPath?: boolean } = { inspectorOnPath: true }) {
  const pathBin = scratch("pathbin");
  const toolBin = scratch("tool");
  const goOwnBin = join(scratch("gopath"), "bin");
  if (opts.inspectorOnPath) {
    script(pathBin, "inspector", "exit 0");
    writeFileSync(join(pathBin, "commit"), FAKE_OLD_COMMIT);
  }
  script(toolBin, "go", FAKE_GO);
  // The real system directories come last so the fake `go` has the
  // ordinary shell utilities it uses (`mkdir`, `cat`, `dirname`); neither
  // holds an `inspector`, so they never decide what PATH resolves here.
  const entries = [pathBin, toolBin, ...(opts.goBinOnPath ? [goOwnBin] : []), "/usr/bin", "/bin"];
  return {
    pathBin,
    goOwnBin,
    env: {
      PATH: entries.join(delimiter),
      // Read by the fake `go` only - the real one keeps these in its own
      // config file, which is why `goInstallDirectory` asks `go env`
      // rather than reading the environment itself.
      FAKE_GO_OWN_BIN: goOwnBin,
      FAKE_GOBIN: "",
      FAKE_GOPATH: join(goOwnBin, ".."),
    } as NodeJS.ProcessEnv,
  };
}

test("the install goes into the directory holding the inspector PATH resolves, never Go's own GOBIN", () => {
  const machine = fakeMachine({ inspectorOnPath: true });
  const probes = realInspectorVersionProbes("inspector", machine.env);
  assert.equal(probes.build()?.commit, FAKE_OLD_COMMIT, "the fixture starts on an older binary, in PATH's own directory");
  assert.equal(probes.directoryOnPath(), machine.pathBin);

  const result = goInstallInspector(FAKE_MAIN_TIP, machine.env);

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.target, { kind: "path", dir: machine.pathBin });
  assert.equal(
    readFileSync(join(machine.pathBin, "commit"), "utf8"),
    FAKE_MAIN_TIP.slice(0, 12),
    "the binary PATH resolves is the one that was replaced"
  );
  assert.equal(existsSync(join(machine.goOwnBin, "inspector")), false, "and nothing landed in Go's own GOBIN");
  // The read-back `fabrica update` does, against the same binary: it
  // now reports main's tip, which is what makes the version check pass.
  assert.equal(probes.build()?.commit, FAKE_MAIN_TIP.slice(0, 12));
});

test("with no inspector on PATH at all, Go's own GOBIN is the fallback, and whether it is on PATH is part of the answer", () => {
  const off = fakeMachine({ inspectorOnPath: false });
  const offTarget = inspectorInstallTarget(off.env);
  assert.deepEqual(offTarget, { kind: "go-default", dir: off.goOwnBin, onPath: false });

  const on = fakeMachine({ inspectorOnPath: false, goBinOnPath: true });
  assert.deepEqual(inspectorInstallTarget(on.env), { kind: "go-default", dir: on.goOwnBin, onPath: true });

  // And the install really does land there, so a fresh machine ends up
  // with an Inspector wherever Go puts one.
  const result = goInstallInspector(FAKE_MAIN_TIP, on.env);
  assert.equal(result.ok, true, result.message);
  assert.equal(existsSync(join(on.goOwnBin, "inspector")), true);
});

test("Go's own install directory is GOBIN when set, $GOPATH/bin when it isn't - asked of `go env`, not of the environment", () => {
  const machine = fakeMachine({ inspectorOnPath: false });
  assert.equal(goInstallDirectory(machine.env), machine.goOwnBin, "an empty GOBIN line falls through to $GOPATH/bin");

  const explicit = scratch("explicit-gobin");
  assert.equal(goInstallDirectory({ ...machine.env, FAKE_GOBIN: explicit }), explicit, "a set GOBIN wins");

  // GOPATH may be a list, and Go installs into the first entry's bin.
  const second = scratch("second-gopath");
  assert.equal(
    goInstallDirectory({ ...machine.env, FAKE_GOPATH: `${join(machine.goOwnBin, "..")}${delimiter}${second}` }),
    machine.goOwnBin
  );

  // A machine with no `go` at all cannot be asked, and says so rather
  // than guessing at ~/go/bin.
  assert.equal(goInstallDirectory({ PATH: scratch("empty") }), null);
  assert.deepEqual(inspectorInstallTarget({ PATH: scratch("empty") }), { kind: "unknown" });
});

test("a PATH entry and the same directory spelled differently are one directory, and a symlinked inspector is not followed", () => {
  const dir = scratch("onpath");
  assert.equal(directoryIsOnPath(dir, { PATH: `/usr/bin${delimiter}${dir}/` }), true, "a trailing slash is the same directory");
  assert.equal(directoryIsOnPath(dir, { PATH: `/usr/bin${delimiter}${dir}/./` }), true);
  assert.equal(directoryIsOnPath(dir, { PATH: "/usr/bin:/bin" }), false);

  // The directory reported is the PATH entry the binary was found in,
  // not whatever a symlink there points at: a host that symlinked around
  // Go's GOBIN must not have the install sent back into it.
  const linkDir = scratch("linked");
  const realDir = scratch("real");
  script(realDir, "inspector", "exit 0");
  writeFileSync(join(linkDir, "inspector"), "");
  chmodSync(join(linkDir, "inspector"), 0o755);
  assert.equal(inspectorDirectoryOnPath("inspector", { PATH: `${linkDir}${delimiter}${realDir}` }), linkDir);
});

// The one spelling: what every message prints and what this actually
// runs are built from the same package path, so a fix the Client is told
// to run can never differ from the command `fabrica update` ran.
test("the printed install command and the argv that runs it are the same command", () => {
  for (const revision of ["latest", "4f297d8be50e4f5b24460b5813ca50729d6413f9"]) {
    assert.equal(inspectorInstallCommand(revision), `go ${inspectorInstallArgs(revision).join(" ")}`);
  }
});
