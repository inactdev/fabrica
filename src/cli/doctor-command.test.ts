// `fabrica doctor` (Client ruling 2026-10-10): a preflight that spends
// nothing, one line per check - OK, or FAIL with the exact fix - and a
// non-zero exit on any FAIL. Machine-level probes are injected here, so
// no test depends on this machine's Docker, tokens, or PATH; the
// per-project, caps and SPEND UNKNOWN checks read a real temp record home.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "../index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { fakeInspector } from "../../contract/helpers/fake-inspector.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { main } from "./main.ts";
import { runDoctorCommand, type DoctorCheck, type DoctorProbes } from "./doctor-command.ts";

const ok = (label: string): DoctorCheck => ({ ok: true, label, detail: "fine" });

function okProbes(overrides: Partial<DoctorProbes> = {}): DoctorProbes & { liveCalls: number } {
  const probes = {
    liveCalls: 0,
    node: () => ok("node"),
    checkout: () => ok("checkout"),
    docker: () => ok("docker"),
    workerImage: () => ok("worker image"),
    workerToken: () => ok("worker token"),
    githubToken: () => ok("GitHub token"),
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
  const project = makeFixtureRepo("exit 0");
  execFileSync("git", ["remote", "add", "origin", "https://example.invalid/demo.git"], { cwd: project });
  return project;
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
  // 7 machine checks, 1 project, caps, spend.
  assert.equal(lines.length, 10, lines.join("\n"));
  assert.ok(lines.every((l) => l.startsWith("OK ")), lines.join("\n"));
  assert.equal(probes.liveCalls, 0, "the live call ran without --live - doctor must spend nothing by default");
});

for (const name of ["node", "checkout", "docker", "workerImage", "workerToken", "githubToken", "inspector"] as const) {
  test(`fabrica doctor: a failing ${name} check prints FAIL with its fix, and exits 1`, async () => {
    const failing: DoctorCheck = { ok: false, label: name, detail: "broken", fix: `the exact fix for ${name}` };
    const { code, lines } = await doctor(healthyHome(), okProbes({ [name]: () => failing }));
    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.startsWith("FAIL ") && l.includes(`the exact fix for ${name}`)), lines.join("\n"));
  });
}

test("fabrica doctor: each registered project is checked - path, git root, a check, and an origin remote", async () => {
  const missing = join(mkdtempSync(join(tmpdir(), "fabrica-doctor-gone-")), "nowhere");
  const notGit = mkdtempSync(join(tmpdir(), "fabrica-doctor-notgit-"));
  const noCheck = makeFixtureRepo("exit 0", { inspector: false });
  rmSync(join(noCheck, "check.sh"));
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "drop check"], { cwd: noCheck });
  execFileSync("git", ["remote", "add", "origin", "https://example.invalid/x.git"], { cwd: noCheck });
  const noOrigin = makeFixtureRepo("exit 0");
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

test("fabrica doctor refuses an unknown argument rather than ignoring it", async () => {
  const { code } = await doctor(healthyHome(), okProbes(), ["--json"]);
  assert.equal(code, 1);
});

test("fabrica doctor is dispatched by main", async () => {
  const io = captureIo();
  assert.equal(await main(["doctor", "--help"], io), 0);
  assert.match(io.out.join("\n"), /fabrica doctor \[--live\]/);
});

test("node check: the version the check box runs (from .inspector.json's image) is OK; any other fails with that version", async () => {
  const { nodeCheck } = await import("./doctor-command.ts");
  assert.equal(nodeCheck("v24.18.0", "24.18.0").ok, true);
  const wrong = nodeCheck("v22.11.0", "24.18.0");
  assert.equal(wrong.ok, false);
  assert.match(wrong.fix ?? "", /24\.18\.0/);
});

test("checkout check: names the checkout and branch; a branch other than master fails", async () => {
  const { checkoutCheck } = await import("./doctor-command.ts");
  const onMaster = checkoutCheck("/src/fabrica", "master");
  assert.equal(onMaster.ok, true);
  assert.match(onMaster.detail, /\/src\/fabrica on master/);
  const onBranch = checkoutCheck("/src/fabrica", "fm/some-feature");
  assert.equal(onBranch.ok, false);
  assert.match(onBranch.fix ?? "", /git -C \/src\/fabrica checkout master/);
});
