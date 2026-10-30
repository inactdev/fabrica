// `fabrica doctor` (Client ruling 2026-10-10): a preflight that spends
// nothing, one line per check - OK, or FAIL with the exact fix - and a
// non-zero exit on any FAIL. Machine-level probes are injected here, so
// no test depends on this machine's Docker, tokens, or PATH; the
// per-project, caps and SPEND UNKNOWN checks read a real temp record home.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createForeman } from "../index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { fakeInspector } from "../../contract/helpers/fake-inspector.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { main } from "./main.ts";
import { collectDoctorChecks, runDoctorCommand, type CopyInfo, type DoctorCheck, type DoctorProbes } from "./doctor-command.ts";

const ok = (label: string): DoctorCheck => ({ ok: true, label, detail: "fine" });

function okProbes(overrides: Partial<DoctorProbes> = {}): DoctorProbes & { liveCalls: number } {
  const probes = {
    liveCalls: 0,
    node: () => ok("node"),
    checkout: () => ok("checkout"),
    npmLink: () => ok("npm link"),
    docker: () => ok("docker"),
    workerImage: () => ok("worker image"),
    workerCli: () => ok("worker CLI"),
    relayImage: () => ok("relay image"),
    workerNetworks: async () => ok("worker networks"),
    workerToken: () => ok("worker token"),
    githubApp: async () => ok("github app"),
    inspector: () => ok("inspector"),
    async live() {
      probes.liveCalls += 1;
      return ok("worker token (live)");
    },
    ...overrides,
  };
  return probes;
}

function healthyProject(): string {
  const project = makeFixtureRepo("exit 0", { origin: false });
  execFileSync("git", ["remote", "add", "origin", "https://example.invalid/demo.git"], { cwd: project });
  acceptToInspector(project);
  return project;
}

/** A fixture project's `.inspector.json` brought up to what the
 * installed Inspector accepts (issue #306): no retired `image` key, and
 * a committed `Dockerfile.inspector` for the check box. The shared
 * fixture still writes the retired key - see
 * notes/20261028-do-fabrica-issue-303-as-written-never-ed-ie.md - and a
 * project line now reports it, so a project meant to be healthy has to
 * say so here. */
function acceptToInspector(project: string): void {
  writeFileSync(join(project, ".inspector.json"), '{"check":"./check.sh"}\n');
  writeFileSync(join(project, "Dockerfile.inspector"), "FROM alpine\n");
  execFileSync("git", ["add", "-A"], { cwd: project });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "a box Inspector can build"], {
    cwd: project,
  });
}

function recordHome(projectsToml: string): string {
  const home = mkdtempSync(join(tmpdir(), "fabrica-doctor-home-"));
  writeFileSync(join(home, "projects.toml"), projectsToml);
  return home;
}

function healthyHome(): string {
  return recordHome(`[caps]\nperTaskUsd = 5\nperDayUsd = 25\n\n[projects.demo]\npath = "${healthyProject()}"\ncheck = "./check.sh"\n`);
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

async function doctor(home: string, probes: DoctorProbes, argv: string[] = []) {
  const io = captureIo();
  const code = await runDoctorCommand(argv, { recordHome: home, probes, ...io });
  return { code, lines: io.out };
}

test("fabrica doctor: everything healthy - every line OK, exit 0, and nothing is spent", async () => {
  const probes = okProbes();
  const { code, lines } = await doctor(healthyHome(), probes);
  assert.equal(code, 0, lines.join("\n"));
  // 11 machine checks, 1 project, caps, spend.
  assert.equal(lines.length, 14, lines.join("\n"));
  assert.ok(lines.every((l) => l.startsWith("OK ")), lines.join("\n"));
  assert.equal(probes.liveCalls, 0, "the live call ran without --live - doctor must spend nothing by default");
});

for (const name of [
  "node",
  "checkout",
  "npmLink",
  "docker",
  "workerImage",
  "workerCli",
  "relayImage",
  "workerToken",
  "inspector",
] as const) {
  test(`fabrica doctor: a failing ${name} check prints FAIL with its fix, and exits 1`, async () => {
    const failing: DoctorCheck = { ok: false, label: name, detail: "broken", fix: `the exact fix for ${name}` };
    const { code, lines } = await doctor(healthyHome(), okProbes({ [name]: () => failing }));
    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.startsWith("FAIL ") && l.includes(`the exact fix for ${name}`)), lines.join("\n"));
  });
}

// The GitHub App line is the one probe that is async (issue #187: asking
// where the App is installed is two GitHub calls), so it is driven on
// its own rather than through the loop above.
test("fabrica doctor: a failing githubApp check prints FAIL with its fix, and exits 1", async () => {
  const failing: DoctorCheck = { ok: false, label: "github app", detail: "broken", fix: "the exact fix for githubApp" };
  const { code, lines } = await doctor(healthyHome(), okProbes({ githubApp: async () => failing }));
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.startsWith("FAIL ") && l.includes("the exact fix for githubApp")), lines.join("\n"));
});

test("fabrica doctor: each registered project is checked - path, git root, a check, and an origin remote", async () => {
  const missing = join(mkdtempSync(join(tmpdir(), "fabrica-doctor-gone-")), "nowhere");
  const notGit = mkdtempSync(join(tmpdir(), "fabrica-doctor-notgit-"));
  const noCheck = makeFixtureRepo("exit 0", { inspector: false, origin: false });
  rmSync(join(noCheck, "check.sh"));
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "drop check"], { cwd: noCheck });
  execFileSync("git", ["remote", "add", "origin", "https://example.invalid/x.git"], { cwd: noCheck });
  const noOrigin = makeFixtureRepo("exit 0", { origin: false });
  const home = recordHome(
    `[caps]\nperDayUsd = 25\n\n` +
      `[projects.missing]\npath = "${missing}"\ncheck = "./check.sh"\n\n` +
      `[projects.notgit]\npath = "${notGit}"\ncheck = "./check.sh"\n\n` +
      `[projects.nocheck]\npath = "${noCheck}"\ncheck = "./check.sh"\n\n` +
      `[projects.noorigin]\npath = "${noOrigin}"\ncheck = "./check.sh"\n`
  );

  const { code, lines } = await doctor(home, okProbes());
  const text = lines.join("\n");
  assert.equal(code, 1);
  assert.match(text, /FAIL project missing: .*does not exist/);
  assert.match(text, /FAIL project notgit: .*not a git repository/);
  assert.match(text, /FAIL project nocheck: .*neither \.inspector\.json nor check\.sh/);
  assert.match(text, /FAIL project noorigin: .*no origin remote.*git -C \S+ remote add origin/);
});

// Issue #306. The 2026-10-27 migration: Inspector retired the `image`
// key, and every project still carrying it burned a full round before
// finding out. doctor is where the Client sees it first now.
test("fabrica doctor: a project whose .inspector.json Inspector would refuse FAILs, naming the key", async () => {
  const project = healthyProject();
  writeFileSync(join(project, ".inspector.json"), '{"check":"./check.sh","image":"alpine"}\n');
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "name an image"], {
    cwd: project,
  });
  const home = recordHome(`[caps]\nperDayUsd = 25\n\n[projects.retired]\npath = "${project}"\ncheck = "./check.sh"\n`);

  const { code, lines } = await doctor(home, okProbes());
  const text = lines.join("\n");
  assert.equal(code, 1);
  assert.match(text, /FAIL project retired: .*Inspector would refuse it - .*still names an "image"/);
  // The fix is the Client's own hand change, named exactly - Fabrica
  // never edits .inspector.json.
  assert.match(text, /fix: remove the "image" field/);
});

test("fabrica doctor: a project committing no Dockerfile.inspector FAILs, naming the file", async () => {
  const project = healthyProject();
  rmSync(join(project, "Dockerfile.inspector"));
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "drop the box"], { cwd: project });
  const home = recordHome(`[caps]\nperDayUsd = 25\n\n[projects.nobox]\npath = "${project}"\ncheck = "./check.sh"\n`);

  const { code, lines } = await doctor(home, okProbes());
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /FAIL project nobox: .*commits no Dockerfile\.inspector/);
});

// A project with no .inspector.json is self-tested: nothing is ever
// handed to Inspector, so there is nothing for it to refuse and this
// check must not invent a reason to stop the project.
test("fabrica doctor: a self-tested project is never failed for Inspector's config rules", async () => {
  const project = makeFixtureRepo("exit 0", { inspector: false, origin: false });
  execFileSync("git", ["remote", "add", "origin", "https://example.invalid/demo.git"], { cwd: project });
  const home = recordHome(`[caps]\nperDayUsd = 25\n\n[projects.selftested]\npath = "${project}"\ncheck = "./check.sh"\n`);

  const { code, lines } = await doctor(home, okProbes());
  assert.equal(code, 0, lines.join("\n"));
  assert.match(lines.join("\n"), /OK {3}project selftested: /);
});

// The OK line says what was actually looked at, rather than claiming
// Inspector would accept the project outright - the refusals checked are
// the ones Inspector documents, not the whole of its own validation.
test("fabrica doctor: a passing project line says the config was checked, and claims no more", async () => {
  const { lines } = await doctor(healthyHome(), okProbes());
  assert.match(lines.join("\n"), /OK {3}project demo: .*nothing Inspector is known to refuse/);
});

// Issue #314: which GitHub credential each project uses is reported on
// that project's own line, since that is the line a reader already looks
// at per project.
test("fabrica doctor: a project line says it reaches GitHub with the GitHub App", async () => {
  const { lines } = await doctor(healthyHome(), okProbes());
  assert.match(lines.join("\n"), /OK {3}project demo: .*reaches GitHub with the GitHub App/);
});

test("fabrica doctor: a project with its own token says so, naming the variable and never the token", async () => {
  const home = recordHome(
    `[caps]\nperDayUsd = 25\n\n[projects.dayjob]\npath = "${healthyProject()}"\n` +
      `check = "./check.sh"\ngithubTokenVar = "DAYJOB_GITHUB_TOKEN"\n`
  );
  writeFileSync(join(home, "brain.env"), "DAYJOB_GITHUB_TOKEN=github_pat_secret_value\n");
  chmodSync(join(home, "brain.env"), 0o600);

  const { code, lines } = await doctor(home, okProbes());
  const text = lines.join("\n");
  assert.equal(code, 0, text);
  assert.match(text, /OK {3}project dayjob: .*reaches GitHub with its own token \(DAYJOB_GITHUB_TOKEN\)/);
  assert.ok(!text.includes("github_pat_secret_value"), "doctor printed the token itself");
});

test("fabrica doctor: a named token that is set nowhere FAILs that project's line, with the line to add", async () => {
  const home = recordHome(
    `[caps]\nperDayUsd = 25\n\n[projects.dayjob]\npath = "${healthyProject()}"\n` +
      `check = "./check.sh"\ngithubTokenVar = "DAYJOB_GITHUB_TOKEN"\n`
  );

  const { code, lines } = await doctor(home, okProbes());
  const text = lines.join("\n");
  assert.equal(code, 1);
  assert.match(text, /FAIL project dayjob: .*DAYJOB_GITHUB_TOKEN is not set/);
  assert.match(text, /fix: add a line DAYJOB_GITHUB_TOKEN=<the token>/);
  // One line, as every doctor line is - the whole refusal's reasoning
  // belongs to the task that refuses, not beside a dozen checks.
  assert.equal(text.split("\n").filter((l) => l.includes("project dayjob")).length, 1);
});

test("fabrica doctor: a brain.env other users can read FAILs that project's line too", async () => {
  const home = recordHome(
    `[caps]\nperDayUsd = 25\n\n[projects.dayjob]\npath = "${healthyProject()}"\n` +
      `check = "./check.sh"\ngithubTokenVar = "DAYJOB_GITHUB_TOKEN"\n`
  );
  writeFileSync(join(home, "brain.env"), "DAYJOB_GITHUB_TOKEN=github_pat_fake\n");
  chmodSync(join(home, "brain.env"), 0o644);

  const { code, lines } = await doctor(home, okProbes());
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /FAIL project dayjob: .*can be read by other users.*fix: chmod 600/);
});

// Client ruling: doctor fails non-zero with the parse error as a FAIL
// line, and runs its other checks. "Other checks" means the machine
// checks above it - the per-project, caps and spend ones genuinely
// cannot be answered from a file nobody could parse, and reporting "no
// projects are registered" off one would be a second FAIL that is wrong
// about why.
test("fabrica doctor: an unparseable projects.toml is one FAIL line naming the file and the line, and every machine check still runs", async () => {
  const home = recordHome(`[caps]\nperDayUsd = 25\nthis is not [valid toml\n`);

  const { code, lines } = await doctor(home, okProbes());

  assert.equal(code, 1);
  const fail = lines.find((l) => l.startsWith("FAIL projects.toml"));
  assert.ok(fail, `no projects.toml FAIL line:\n${lines.join("\n")}`);
  assert.ok(fail.includes(join(home, "projects.toml")), fail);
  assert.match(fail, /:3:/, `the line the parser stopped on is missing: ${fail}`);
  assert.match(fail, /not valid TOML/);
  assert.match(fail, /fix: fix the TOML in .*projects\.toml at line 3/);
  // The 11 machine checks all ran and all printed; this is the only FAIL.
  assert.equal(lines.length, 12, lines.join("\n"));
  assert.equal(lines.filter((l) => l.startsWith("FAIL")).length, 1, lines.join("\n"));
});

test("fabrica doctor: no caps set fails, naming the [caps] table", async () => {
  const home = recordHome(`[projects.demo]\npath = "${healthyProject()}"\ncheck = "./check.sh"\n`);
  const { code, lines } = await doctor(home, okProbes());
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.startsWith("FAIL caps") && l.includes("[caps]")), lines.join("\n"));
});

test("fabrica doctor: a SPEND UNKNOWN block fails, naming the fabrica cost command", async () => {
  const home = healthyHome();
  const unmeasured = await createForeman({ recordHome: home, caps: { perDayUsd: 25 }, inspector: fakeInspector("green") }).do(
    "unmeasured",
    { project: makeFixtureRepo("exit 0"), brain: fakeBrain({ costUsd: null }) }
  );
  const { code, lines } = await doctor(home, okProbes());
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.startsWith("FAIL spend") && l.includes(`fabrica cost ${unmeasured.id} <usd>`)), lines.join("\n"));
});

test("fabrica doctor --live: makes the one live call, and a dead token fails", async () => {
  const alive = okProbes();
  assert.equal((await doctor(healthyHome(), alive, ["--live"])).code, 0);
  assert.equal(alive.liveCalls, 1);

  const dead = okProbes({
    async live() {
      return { ok: false, label: "worker token (live)", detail: "dead", fix: "get a new worker token" };
    },
  });
  const { code, lines } = await doctor(healthyHome(), dead, ["--live"]);
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.startsWith("FAIL worker token (live)")));
});

/** A failing image line, and a repair seam that records what it was
 * asked to run and flips that line's probe to passing - so these tests
 * are about doctor's own wiring (does --fix run it, in the right place,
 * and is the report afterwards the machine as it is now), not about the
 * repair step itself. That is proven against the real `docker` argv and
 * the fake docker in src/cli/image-repair.test.ts. */
function repairableProbes(which: "workerImage" | "relayImage") {
  const label = which === "workerImage" ? "worker image" : "relay image";
  const ran: string[] = [];
  let supplied = false;
  const line = (): DoctorCheck =>
    supplied
      ? { ok: true, label, detail: "supplied and current" }
      : { ok: false, label, detail: "is not here", fix: "run the command" };
  return {
    label,
    probes: okProbes(which === "workerImage" ? { workerImage: line } : { relayImage: line }),
    ran,
    runImageCommand: async (cmd: { shell: string }, onOutput: (line: string) => void) => {
      ran.push(cmd.shell);
      onOutput("#1 DONE 0.1s");
      supplied = true;
      return { ok: true, detail: "" };
    },
  };
}

test("fabrica doctor without --fix stays read-only: a missing image is reported with its fix and nothing is built", async () => {
  const { probes, ran } = repairableProbes("workerImage");
  const io = captureIo();
  const code = await runDoctorCommand([], { recordHome: healthyHome(), probes, ...io });

  assert.equal(code, 1);
  assert.deepEqual(ran, [], "plain doctor must build nothing");
  assert.ok(
    io.out.some((l) => l.startsWith("FAIL worker image:") && l.includes("run the command")),
    io.out.join("\n")
  );
});

test("fabrica doctor --fix: builds the missing image, says what it did, and the report that follows is the machine as it is now", async () => {
  const { probes, ran, runImageCommand } = repairableProbes("workerImage");
  const io = captureIo();
  const code = await runDoctorCommand(["--fix"], { recordHome: healthyHome(), probes, runImageCommand, ...io });

  assert.equal(code, 0, io.out.concat(io.err).join("\n"));
  assert.equal(ran.length, 1, "exactly one command ran");
  assert.match(ran[0], /docker build /, "and it is the real build command, not the check's wording");
  assert.ok(io.out.includes("  #1 DONE 0.1s"), "docker's own output has to reach the terminal");
  assert.ok(io.out.some((l) => l.startsWith("worker image: built ")), io.out.join("\n"));
  assert.ok(io.out.includes("OK   worker image: supplied and current"), io.out.join("\n"));
  assert.ok(
    !io.out.some((l) => l.startsWith("FAIL worker image:")),
    "the report prints once, after the repair - not the stale line as well"
  );
});

test("fabrica doctor --fix: a missing relay image is the other half, and both flags work together", async () => {
  const { probes, ran, runImageCommand } = repairableProbes("relayImage");
  const io = captureIo();
  const code = await runDoctorCommand(["--fix", "--live"], { recordHome: healthyHome(), probes, runImageCommand, ...io });

  assert.equal(code, 0, io.out.concat(io.err).join("\n"));
  assert.equal(ran.length, 1);
  assert.match(ran[0], /docker pull /);
  assert.ok(io.out.some((l) => l.startsWith("relay image: pulled ")), io.out.join("\n"));
  assert.ok(io.out.includes("OK   relay image: supplied and current"), io.out.join("\n"));
});

test("fabrica doctor --fix --live: the live call is made after the repair, never with an image about to be replaced", async () => {
  // The live probe runs a container from the worker image, so the one
  // ordering this must guarantee is repair-then-spend.
  const order: string[] = [];
  let supplied = false;
  const probes = okProbes({
    workerImage: () =>
      supplied
        ? { ok: true, label: "worker image", detail: "built and current" }
        : { ok: false, label: "worker image", detail: "is not built", fix: "run the command" },
    live: async () => {
      order.push("live");
      return ok("worker token (live)");
    },
  });
  const io = captureIo();
  const code = await runDoctorCommand(["--fix", "--live"], {
    recordHome: healthyHome(),
    probes,
    runImageCommand: async () => {
      order.push("build");
      supplied = true;
      return { ok: true, detail: "" };
    },
    ...io,
  });

  assert.equal(code, 0, io.out.concat(io.err).join("\n"));
  assert.deepEqual(order, ["build", "live"]);
});

test("collectDoctorChecks: the repair hook runs exactly once, after every other check and before the live one", async () => {
  // Both commands hand their repair step to this one hook rather than
  // wrapping this function themselves, so this is where "once, and
  // before anything spends money on the image it may replace" is
  // actually guaranteed - for every caller at once, present and future.
  const order: string[] = [];
  const probes = okProbes({
    live: async () => {
      order.push("live");
      return ok("worker token (live)");
    },
  });
  const seen: DoctorCheck[][] = [];
  const checks = await collectDoctorChecks({
    recordHome: healthyHome(),
    probes,
    live: true,
    repair: async (collected) => {
      order.push("repair");
      seen.push(collected);
      return collected.concat([{ ok: true, label: "repaired", detail: "this run's own line" }]);
    },
  });

  // One entry each, in this order: the hook ran once, and the probe
  // that spends against the worker image ran after it.
  assert.deepEqual(order, ["repair", "live"]);
  // What it was handed: every machine and config check already answered,
  // and no live line yet - a repair decides what to do from the same
  // findings doctor would have printed.
  assert.ok(seen[0].some((c) => c.label === "worker image"), "the image lines it reads");
  assert.ok(seen[0].some((c) => c.label === "caps"), "and the config checks, already run");
  assert.equal(seen[0].some((c) => c.label === "worker token (live)"), false);
  // And what it hands back is what the caller goes on to print and
  // judge, with the live line appended after it.
  assert.equal(checks.at(-1)?.label, "worker token (live)");
  assert.ok(checks.some((c) => c.label === "repaired"));
});

test("fabrica doctor --fix: a build that fails leaves the FAIL, its fix, and the non-zero exit exactly as before", async () => {
  const { probes } = repairableProbes("workerImage");
  const io = captureIo();
  const code = await runDoctorCommand(["--fix"], {
    recordHome: healthyHome(),
    probes,
    runImageCommand: async () => ({ ok: false, detail: "no space left on device" }),
    ...io,
  });

  assert.equal(code, 1);
  assert.ok(io.err.some((l) => l.includes("no space left on device")), io.err.join("\n"));
  assert.ok(
    io.out.some((l) => l.startsWith("FAIL worker image:") && l.includes("run the command")),
    io.out.join("\n")
  );
});

test("fabrica doctor refuses an unknown argument rather than ignoring it", async () => {
  const { code } = await doctor(healthyHome(), okProbes(), ["--json"]);
  assert.equal(code, 1);
});

test("fabrica doctor is dispatched by main", async () => {
  const io = captureIo();
  assert.equal(await main(["doctor", "--help"], io), 0);
  assert.match(io.out.join("\n"), /fabrica doctor \[--fix\] \[--live\]/);
});

test("node check: the version the check box runs (from .inspector.json's image) is OK; any other fails with that version", async () => {
  const { nodeCheck } = await import("./doctor-command.ts");
  assert.equal(nodeCheck("v24.18.0", "24.18.0").ok, true);
  const wrong = nodeCheck("v22.11.0", "24.18.0");
  assert.equal(wrong.ok, false);
  assert.match(wrong.fix ?? "", /24\.18\.0/);
});

test("checkout check: a dev checkout on master, up to date with origin/master", async () => {
  const { checkoutCheck } = await import("./doctor-command.ts");
  const copy = { kind: "dev-checkout" as const, root: "/src/fabrica", branch: "master", commit: "aaa111", version: "0.0.0" };
  const check = checkoutCheck(copy, "aaa111");
  assert.equal(check.ok, true);
  assert.match(check.detail, /\/src\/fabrica on master, commit aaa111/);
  assert.match(check.detail, /up to date with origin\/master/);
});

test("checkout check: a dev checkout behind origin/master is reported but still OK", async () => {
  const { checkoutCheck } = await import("./doctor-command.ts");
  const copy = { kind: "dev-checkout" as const, root: "/src/fabrica", branch: "master", commit: "aaa111", version: "0.0.0" };
  const check = checkoutCheck(copy, "zzz999");
  assert.equal(check.ok, true);
  assert.match(check.detail, /behind origin\/master, latest is zzz999/);
});

test("checkout check: a branch other than master fails, naming the checkout and fix", async () => {
  const { checkoutCheck } = await import("./doctor-command.ts");
  const onBranch = checkoutCheck({ kind: "dev-checkout" as const, root: "/src/fabrica", branch: "fm/some-feature", commit: "aaa111", version: "0.0.0" }, "aaa111");
  assert.equal(onBranch.ok, false);
  assert.match(onBranch.detail, /not master/);
  assert.match(onBranch.fix ?? "", /git -C \/src\/fabrica checkout master/);
});

test("checkout check: when origin/master can't be reached, that's reported but not fatal", async () => {
  const { checkoutCheck } = await import("./doctor-command.ts");
  const check = checkoutCheck({ kind: "dev-checkout" as const, root: "/src/fabrica", branch: "master", commit: "aaa111", version: "0.0.0" }, null);
  assert.equal(check.ok, true);
  assert.match(check.detail, /can't check against origin\/master/);
});

test("checkout check: an installed copy reports its version and commit against origin/master", async () => {
  const { checkoutCheck } = await import("./doctor-command.ts");
  const copy = { kind: "installed" as const, root: "/usr/local/lib/node_modules/fabrica", branch: null, commit: "aaa111", version: "1.2.3" };
  const upToDate = checkoutCheck(copy, "aaa111");
  assert.equal(upToDate.ok, true);
  assert.match(upToDate.detail, /installed copy v1\.2\.3, commit aaa111/);
  assert.match(upToDate.detail, /up to date with origin\/master/);

  const behind = checkoutCheck(copy, "zzz999");
  assert.equal(behind.ok, true);
  assert.match(behind.detail, /behind origin\/master, latest is zzz999/);
});

test("checkout check: an installed copy whose commit is unknown fails, saying so and why", async () => {
  const { checkoutCheck } = await import("./doctor-command.ts");
  const copy = {
    kind: "installed" as const,
    root: "/usr/local/lib/node_modules/fabrica",
    branch: null,
    commit: null,
    version: "1.2.3",
    commitUnknownReason: "there is no .git at /tmp/x, and no field npm set for the prepare step named one",
  };
  const check = checkoutCheck(copy, "aaa111");
  assert.equal(check.ok, false);
  assert.match(check.detail, /commit unknown/);
  // Whatever could not produce a commit gets to say why, verbatim -
  // "unknown" with no reason is what sent the Client looking in the
  // first place.
  assert.match(check.detail, /no field npm set for the prepare step named one/);
  // The clone-then-pack procedure, into the prefix this copy lives
  // under rather than npm's default - which is read-only on a
  // Nix-managed host (issue #171).
  assert.match(check.fix ?? "", /^fabrica update, or by hand: /);
  assert.match(check.fix ?? "", /git clone --depth 1 --branch master https:\/\/github\.com\/inactdev\/fabrica\.git/);
  assert.match(check.fix ?? "", /npm install -g --prefix \/usr\/local "\$d"\/fabrica-\*\.tgz/);
  // Never the one-step install of the GitHub spec: that is the install
  // whose packed tree has no .git, so advising it here would advise the
  // very install that produced this line.
  assert.equal((check.fix ?? "").includes("install -g github:"), false);
});

test("checkout check: an installed copy with no build-info.json at all fails the same way, saying that instead", async () => {
  const { checkoutCheck } = await import("./doctor-command.ts");
  const copy = {
    kind: "installed" as const,
    root: "/usr/local/lib/node_modules/fabrica",
    branch: null,
    commit: null,
    version: "1.2.3",
    commitUnknownReason: "there is no build-info.json in it to record one",
  };
  const check = checkoutCheck(copy, "aaa111");
  assert.equal(check.ok, false);
  assert.match(check.detail, /commit unknown - there is no build-info\.json/);
});

test("checkout check: an installed copy under no npm prefix at all still names the procedure, unprefixed", async () => {
  const { checkoutCheck } = await import("./doctor-command.ts");
  const copy = { kind: "installed" as const, root: "/home/me/.npm/_npx/0a1b2c3d/node_modules/fabrica", branch: null, commit: null, version: "1.2.3" };
  const check = checkoutCheck(copy, "aaa111");
  assert.equal(check.ok, false);
  // Nothing recorded a reason - the line still has to say what it knows.
  assert.match(check.detail, /commit unknown - nothing in it records one/);
  assert.match(check.fix ?? "", /npm install -g "\$d"\/fabrica-\*\.tgz/);
  assert.equal((check.fix ?? "").includes("--prefix"), false);
});

// Client ruling 2026-10-23: which copy of fabrica is on this disk, and
// whether it is the newest one, makes no task impossible - so none of
// this check's failures may stop `fabrica up` from starting a session.
// They are all still FAIL lines in `fabrica doctor` itself, which is
// what the exit-code assertions below are for: this is a severity, not
// a downgrade to OK.
test("checkout check: no failure here stops a task - still a doctor FAIL, never a refused session", async () => {
  const { checkoutCheck, stopsATask } = await import("./doctor-command.ts");
  const noBuildInfo = checkoutCheck(
    { kind: "installed" as const, root: "/usr/local/lib/node_modules/fabrica", branch: null, commit: null, version: "1.2.3" },
    "aaa111"
  );
  const offMaster = checkoutCheck(
    { kind: "dev-checkout" as const, root: "/src/fabrica", branch: "fm/some-feature", commit: "aaa111", version: "0.0.0" },
    "aaa111"
  );

  for (const check of [noBuildInfo, offMaster]) {
    assert.equal(check.ok, false, check.detail);
    assert.equal(check.blocking, false, check.detail);
    assert.equal(stopsATask(check), false, check.detail);
  }

  const { code, lines } = await doctor(healthyHome(), okProbes({ checkout: () => noBuildInfo }));
  assert.equal(code, 1, "fabrica doctor itself must still fail on it");
  assert.ok(lines.some((l) => l.startsWith("FAIL checkout")), lines.join("\n"));
});

test("checkout check: being behind origin/master is a note for the session to print, naming fabrica update", async () => {
  const { checkoutCheck } = await import("./doctor-command.ts");
  const installed = { kind: "installed" as const, root: "/usr/local/lib/node_modules/fabrica", branch: null, commit: "aaa111", version: "1.2.3" };
  const dev = { kind: "dev-checkout" as const, root: "/src/fabrica", branch: "master", commit: "aaa111", version: "0.0.0" };

  for (const copy of [installed, dev]) {
    const behind = checkoutCheck(copy, "zzz999");
    assert.equal(behind.ok, true);
    assert.match(behind.note ?? "", /behind origin\/master, latest is zzz999/);
    assert.match(behind.note ?? "", /fabrica update/);

    assert.equal(checkoutCheck(copy, "aaa111").note, undefined, "up to date has nothing to warn about");
    assert.equal(checkoutCheck(copy, null).note, undefined, "a comparison nobody could make is not a warning either");
  }
});

test("npm link check: a leftover symlink stops no task either - it breaks the next install, nothing else", async () => {
  const { npmLinkCheck, stopsATask } = await import("./doctor-command.ts");
  const leftover = npmLinkCheck([{ prefix: "/usr/local", linkTarget: "/src/fabrica", dangling: false, npmDefault: true }], {
    kind: "installed",
    root: "/home/me/.npm-global/lib/node_modules/fabrica",
    branch: null,
    commit: "aaa111",
    version: "1.2.3",
  });

  assert.equal(leftover.ok, false);
  assert.equal(stopsATask(leftover), false);
  assert.equal((await doctor(healthyHome(), okProbes({ npmLink: () => leftover }))).code, 1);
});

test("stopsATask: absent blocking means a failure stops a task - a new check is never advisory by accident", async () => {
  const { stopsATask } = await import("./doctor-command.ts");
  assert.equal(stopsATask({ ok: false, label: "brand new check", detail: "broken" }), true);
  assert.equal(stopsATask({ ok: false, label: "x", detail: "broken", blocking: true }), true);
  assert.equal(stopsATask({ ok: false, label: "x", detail: "broken", blocking: false }), false);
  assert.equal(stopsATask({ ok: true, label: "x", detail: "fine" }), false);
});

test("advisoryLine: one warning line for a non-blocking failure or a note, and nothing for anything else", async () => {
  const { advisoryLine } = await import("./doctor-command.ts");

  assert.equal(
    advisoryLine({ ok: false, blocking: false, label: "checkout", detail: "no build-info.json", fix: "reinstall it" }),
    "WARN checkout: no build-info.json - fix: reinstall it"
  );
  assert.equal(advisoryLine({ ok: true, label: "checkout", detail: "fine", note: "behind origin/master" }), "WARN checkout: behind origin/master");
  assert.equal(advisoryLine({ ok: true, label: "docker", detail: "reachable" }), null);
  assert.equal(advisoryLine({ ok: false, label: "docker", detail: "not reachable" }), null, "a blocking failure is never a warning");
});

test("formatDoctorLine: exactly the lines fabrica doctor prints, so one renderer serves both commands", async () => {
  const { formatDoctorLine } = await import("./doctor-command.ts");
  assert.equal(formatDoctorLine({ ok: true, label: "docker", detail: "reachable" }), "OK   docker: reachable");
  assert.equal(formatDoctorLine({ ok: false, label: "docker", detail: "not reachable", fix: "start it" }), "FAIL docker: not reachable - fix: start it");

  const { lines } = await doctor(healthyHome(), okProbes());
  assert.ok(lines.includes("OK   docker: fine"), lines.join("\n"));
});

// Issue #171: a leftover `npm link` symlink standing where an installed
// copy belongs. The wording/pass-fail cases are pure; the three below
// them build real symlinks, since the point of that half is reading a
// real filesystem correctly.
const devCopy = (root: string): CopyInfo => ({ kind: "dev-checkout", root, branch: "master", commit: "aaa111", version: "0.0.0" });
const installedCopy = (root: string): CopyInfo => ({ kind: "installed", root, branch: null, commit: "aaa111", version: "1.2.3" });

test("npm link check: no symlink at any prefix checked is OK, and says where it looked", async () => {
  const { npmLinkCheck } = await import("./doctor-command.ts");
  const check = npmLinkCheck(
    [{ prefix: "/usr/local", linkTarget: null, dangling: false, npmDefault: true }],
    installedCopy("/usr/local/lib/node_modules/fabrica")
  );
  assert.equal(check.ok, true);
  assert.match(check.detail, /\/usr\/local\/lib\/node_modules\/fabrica/);
});

test("npm link check: no prefix to check at all is OK, not a failure", async () => {
  const { npmLinkCheck } = await import("./doctor-command.ts");
  const check = npmLinkCheck([], devCopy("/src/fabrica"));
  assert.equal(check.ok, true);
  assert.match(check.detail, /no npm prefix to check/);
});

test("npm link check: a link to the dev checkout running right now is the developer install, not a leftover", async () => {
  const { npmLinkCheck } = await import("./doctor-command.ts");
  const check = npmLinkCheck(
    [{ prefix: "/usr/local", linkTarget: "/src/fabrica", dangling: false, npmDefault: true }],
    devCopy("/src/fabrica")
  );
  assert.equal(check.ok, true, check.detail);
  assert.match(check.detail, /developer install/);
});

test("npm link check: a leftover link while an installed copy runs fails, printing npm unlink -g fabrica", async () => {
  const { npmLinkCheck } = await import("./doctor-command.ts");
  const check = npmLinkCheck(
    [{ prefix: "/usr/local", linkTarget: "/src/fabrica", dangling: false, npmDefault: true }],
    installedCopy("/home/me/.npm-global/lib/node_modules/fabrica")
  );
  assert.equal(check.ok, false);
  assert.match(check.detail, /\/usr\/local\/lib\/node_modules\/fabrica is an npm link symlink/);
  assert.match(check.detail, /ENOTDIR/);
  assert.equal(check.fix, "npm unlink -g fabrica");
});

test("npm link check: a leftover link at a prefix that is not npm's own names that prefix in the fix", async () => {
  const { npmLinkCheck } = await import("./doctor-command.ts");
  const check = npmLinkCheck(
    [{ prefix: "/home/me/.npm-global", linkTarget: "/src/fabrica", dangling: false, npmDefault: false }],
    installedCopy("/usr/local/lib/node_modules/fabrica")
  );
  assert.equal(check.ok, false);
  assert.equal(check.fix, "npm unlink -g --prefix /home/me/.npm-global fabrica");
});

test("npm link check: a link whose target is gone fails even on the dev checkout that is running", async () => {
  const { npmLinkCheck } = await import("./doctor-command.ts");
  const check = npmLinkCheck(
    [{ prefix: "/usr/local", linkTarget: "/src/gone", dangling: true, npmDefault: true }],
    devCopy("/src/gone")
  );
  assert.equal(check.ok, false);
  assert.match(check.detail, /no longer exists/);
  assert.equal(check.fix, "npm unlink -g fabrica");
});

test("npm link check: the fix it prints is the one the install documentation tells a Client to run", async () => {
  // Issue #171 asks for both halves, and they are only useful as one
  // answer: the install section's note and this check's fix have to be
  // the same command, so a reader who hits the ENOTDIR and a reader who
  // runs doctor are told the same thing.
  const { npmLinkCheck } = await import("./doctor-command.ts");
  const check = npmLinkCheck(
    [{ prefix: "/usr/local", linkTarget: "/src/fabrica", dangling: false, npmDefault: true }],
    installedCopy("/home/me/.npm-global/lib/node_modules/fabrica")
  );
  const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "README.md"), "utf8");

  assert.equal(check.fix, "npm unlink -g fabrica");
  assert.ok(readme.includes("`npm unlink -g fabrica`"), "README.md must name the same fix doctor prints");
});

test("npmLinkPrefixes: the running executable's prefix, the running copy's own, and npm's - deduplicated", async () => {
  const { npmLinkPrefixes } = await import("./doctor-command.ts");

  // An installed copy run through its own prefix's bin, with npm's
  // default prefix elsewhere: two sites, npm's marked as its own.
  assert.deepEqual(
    npmLinkPrefixes(installedCopy("/home/me/.npm-global/lib/node_modules/fabrica"), "/home/me/.npm-global/bin/fabrica", "/usr/local"),
    [
      { prefix: "/home/me/.npm-global", npmDefault: false },
      { prefix: "/usr/local", npmDefault: true },
    ]
  );

  // The same prefix reached two ways is one site, and it is npm's own.
  assert.deepEqual(npmLinkPrefixes(installedCopy("/usr/local/lib/node_modules/fabrica"), "/usr/local/bin/fabrica", "/usr/local"), [
    { prefix: "/usr/local", npmDefault: true },
  ]);

  // A linked dev checkout: its root names no prefix, the bin it was
  // reached through does.
  assert.deepEqual(npmLinkPrefixes(devCopy("/src/fabrica"), "/usr/local/bin/fabrica", null), [
    { prefix: "/usr/local", npmDefault: false },
  ]);

  // Nothing derivable (run straight out of a checkout, no npm on PATH):
  // nothing is searched, rather than a guessed prefix.
  assert.deepEqual(npmLinkPrefixes(devCopy("/src/fabrica"), "/src/fabrica/src/cli/bin.mjs", null), []);
});

test("inspectNpmLinkSite: a real installed directory is not a link", async () => {
  const { inspectNpmLinkSite } = await import("./doctor-command.ts");
  const prefix = mkdtempSync(join(tmpdir(), "fabrica-doctor-prefix-"));
  mkdirSync(join(prefix, "lib", "node_modules", "fabrica"), { recursive: true });

  assert.deepEqual(inspectNpmLinkSite({ prefix, npmDefault: true }), { prefix, npmDefault: true, linkTarget: null, dangling: false });
});

test("inspectNpmLinkSite: npm link's own relative symlink is read, resolved against its own folder", async () => {
  const { inspectNpmLinkSite } = await import("./doctor-command.ts");
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fabrica-doctor-linked-")));
  const checkout = join(base, "checkout");
  mkdirSync(checkout);
  const nodeModules = join(base, "prefix", "lib", "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  // Exactly what `npm link` writes - a path relative to the link, not
  // an absolute one.
  symlinkSync(join("..", "..", "..", "checkout"), join(nodeModules, "fabrica"));

  assert.deepEqual(inspectNpmLinkSite({ prefix: join(base, "prefix"), npmDefault: false }), {
    prefix: join(base, "prefix"),
    npmDefault: false,
    linkTarget: checkout,
    dangling: false,
  });
});

test("inspectNpmLinkSite: a symlink whose target is gone is reported as dangling, not as nothing", async () => {
  const { inspectNpmLinkSite } = await import("./doctor-command.ts");
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fabrica-doctor-dangling-")));
  const nodeModules = join(base, "prefix", "lib", "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  symlinkSync(join(base, "gone"), join(nodeModules, "fabrica"));

  const site = inspectNpmLinkSite({ prefix: join(base, "prefix"), npmDefault: true });
  assert.equal(site.dangling, true);
  assert.equal(site.linkTarget, join(base, "gone"));
});

test("inspectNpmLinkSite: a prefix with nothing installed under it is not a link either", async () => {
  const { inspectNpmLinkSite } = await import("./doctor-command.ts");
  const prefix = mkdtempSync(join(tmpdir(), "fabrica-doctor-empty-prefix-"));

  assert.deepEqual(inspectNpmLinkSite({ prefix, npmDefault: false }), { prefix, npmDefault: false, linkTarget: null, dangling: false });
});

test("detectCopy: a directory with .git is a dev checkout, read live through the injected git function", async () => {
  const { detectCopy } = await import("./doctor-command.ts");
  const dir = mkdtempSync(join(tmpdir(), "fabrica-doctor-devcheckout-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.0.0" }));
  const copy = detectCopy(dir, (args) => (args[0] === "branch" ? "master" : "deadbeef"));
  assert.deepEqual(copy, { kind: "dev-checkout", root: dir, branch: "master", commit: "deadbeef", version: "0.0.0" });
});

test("detectCopy: a directory with no .git reads build-info.json as an installed copy", async () => {
  const { detectCopy } = await import("./doctor-command.ts");
  const dir = mkdtempSync(join(tmpdir(), "fabrica-doctor-installed-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(join(dir, "build-info.json"), JSON.stringify({ commit: "abc123", source: "git rev-parse HEAD" }));
  const copy = detectCopy(dir, () => {
    throw new Error("an installed copy must never shell out to git");
  });
  assert.deepEqual(copy, { kind: "installed", root: dir, branch: null, commit: "abc123", version: "1.2.3" });
});

// The state `scripts/write-build-info.mjs` records when it had no source
// for the commit: an empty string, never a null, plus the named failure -
// which is carried through to the Client verbatim rather than flattened
// into "unknown".
test("detectCopy: a build-info.json with an empty commit carries its own named failure out", async () => {
  const { detectCopy } = await import("./doctor-command.ts");
  const dir = mkdtempSync(join(tmpdir(), "fabrica-doctor-empty-commit-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(
    join(dir, "build-info.json"),
    JSON.stringify({ commit: "", source: "none", error: "there is no .git at /x, and no field npm set named one" })
  );
  const copy = detectCopy(dir, () => null);
  assert.deepEqual(copy, {
    kind: "installed",
    root: dir,
    branch: null,
    commit: null,
    version: "1.2.3",
    commitUnknownReason: "there is no .git at /x, and no field npm set named one",
  });
});

// A copy built before the script said why - its `{"commit":null}` - is
// the same state, and still gets a reason rather than a bare unknown.
test("detectCopy: a build-info.json with a null commit and no reason is reported as recording none", async () => {
  const { detectCopy } = await import("./doctor-command.ts");
  const dir = mkdtempSync(join(tmpdir(), "fabrica-doctor-null-commit-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(join(dir, "build-info.json"), JSON.stringify({ commit: null }));
  const copy = detectCopy(dir, () => null);
  assert.equal(copy.commit, null);
  assert.match(copy.commitUnknownReason ?? "", /records no commit, and does not say why/);
});

test("detectCopy: a directory with neither .git nor build-info.json is installed with an unknown commit", async () => {
  const { detectCopy } = await import("./doctor-command.ts");
  const dir = mkdtempSync(join(tmpdir(), "fabrica-doctor-bare-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  const copy = detectCopy(dir, () => null);
  assert.deepEqual(copy, {
    kind: "installed",
    root: dir,
    branch: null,
    commit: null,
    version: "1.2.3",
    commitUnknownReason: "there is no build-info.json in it to record one",
  });
});

test("runningCopyCommit: exactly the commit detectCopy would compute for this root - the same question /api/version and fabrica up's stale-live-view check both ask", async () => {
  const { runningCopyCommit } = await import("./doctor-command.ts");
  const dir = mkdtempSync(join(tmpdir(), "fabrica-doctor-running-commit-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-m", "x", "--no-gpg-sign"], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

  assert.equal(runningCopyCommit(dir), head);
});

test("runningCopyCommit: null for an installed copy with no build-info.json, same as detectCopy", async () => {
  const { runningCopyCommit } = await import("./doctor-command.ts");
  const dir = mkdtempSync(join(tmpdir(), "fabrica-doctor-running-commit-bare-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  assert.equal(runningCopyCommit(dir), null);
});

// Leftover Docker networks (Client ruling 2026-10-25): every task runs
// on its own throwaway networks, each holding one of Docker's finite
// address pools until it is removed, so doctor counts the ones no task
// is using and names the one command that clears them. The wording and
// the pass/fail are pure functions, testable with no Docker anywhere.

test("fabrica doctor: leftover worker networks are a warning, counted, with the prune command as the fix", async () => {
  const { leftoverWorkerNetworks, workerNetworksCheck } = await import("./doctor-command.ts");
  const networks = [
    { name: "fabrica-worker-aaa", taskId: "gone-1", attachedContainers: 0 },
    { name: "fabrica-worker-bbb", taskId: null, attachedContainers: 0 },
  ];

  const check = workerNetworksCheck(networks, leftoverWorkerNetworks(networks, new Set<string>()));

  assert.equal(check.ok, false);
  assert.equal(check.blocking, false, "a few leftovers warn - they stop no task until the pools run out");
  assert.match(check.detail, /2 leftover fabrica-worker-\* networks/);
  assert.match(check.detail, /fabrica-worker-aaa, fabrica-worker-bbb/);
  assert.equal(check.fix, "docker network prune -f");
});

test("fabrica doctor: a running task's network is never a leftover - by the record, or by a container on it", async () => {
  const { leftoverWorkerNetworks, workerNetworksCheck } = await import("./doctor-command.ts");
  const networks = [
    // Its task is still running: the box may not have attached yet.
    { name: "fabrica-worker-running", taskId: "live-1", attachedContainers: 0 },
    // Nothing in this record home knows it, but Docker says a container
    // is on it right now.
    { name: "fabrica-worker-busy", taskId: null, attachedContainers: 1 },
  ];

  const leftovers = leftoverWorkerNetworks(networks, new Set(["live-1"]));

  assert.deepEqual(leftovers, []);
  const check = workerNetworksCheck(networks, leftovers);
  assert.equal(check.ok, true);
  assert.match(check.detail, /2 in use by running tasks/);
});

test("fabrica doctor: Docker that cannot be asked is reported as that, not as a clean machine", async () => {
  const { workerNetworksCheck } = await import("./doctor-command.ts");

  const check = workerNetworksCheck(null, []);

  assert.equal(check.ok, true);
  assert.match(check.detail, /not checked/);
});

test("fabrica doctor: the leftover-network warning is printed and exits 1, without stopping anything else", async () => {
  const failing: DoctorCheck = {
    ok: false,
    blocking: false,
    label: "worker networks",
    detail: "3 leftover fabrica-worker-* networks",
    fix: "docker network prune -f",
  };
  const { code, lines } = await doctor(healthyHome(), okProbes({ workerNetworks: async () => failing }));

  assert.equal(code, 1);
  assert.ok(
    lines.some((l) => l.startsWith("FAIL worker networks:") && l.includes("docker network prune -f")),
    lines.join("\n")
  );
});

test("fabrica doctor: liveTaskIds counts a task that is working, and not one that has delivered", async () => {
  const { liveTaskIds } = await import("./doctor-command.ts");
  const home = mkdtempSync(join(tmpdir(), "fabrica-doctor-live-tasks-"));
  const { appendEvent } = await import("../record/index.ts");
  appendEvent(home, { taskId: "running-1", name: "task-received", details: {} });
  appendEvent(home, { taskId: "running-1", name: "work-started", details: {} });
  appendEvent(home, { taskId: "done-1", name: "task-received", details: {} });
  appendEvent(home, { taskId: "done-1", name: "delivered", details: {} });

  const live = liveTaskIds(home);

  assert.ok(live.has("running-1"));
  assert.ok(!live.has("done-1"));
});
