// Issue #267 at the round level: a green Inspector verdict is no longer
// the last word. After Inspector has published and opened the pull
// request, the checks the repository itself runs on it are read, and a
// red one turns the round into a red delivery carrying their output -
// which the next counted attempt, and a later `fix` round, then get as
// their correction. The GitHub read itself is faked here (its own tests
// are in src/ci/); what these prove is the wiring and the wording.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { retryOnRedChecksFor } from "./ci-checks.ts";
import type { ChecksReader, CiCheckConcludedDetails, CiChecksFinishedDetails } from "./ci-checks.ts";
import type { Brain } from "../brain/index.ts";
import type { Inspector } from "../inspector/index.ts";
import type { ChecksReport, ConcludedCheck } from "../ci/index.ts";
import { summarizeChecks } from "../ci/index.ts";
import type { WorkerWriteup } from "../../contract/surface.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";

const WRITEUP: WorkerWriteup = {
  title: "Format the nix files",
  why: "The tree was unformatted.",
  what: "Ran the formatter.",
  how: "Reformatted two files.",
  outsideChanges: "None.",
  confidence: 90,
  assumptions: "None.",
  expectedOutcomes: "The formatter check passes.",
  deviations: "None.",
  quiz: [
    { question: "What changed?", answer: "Formatting." },
    { question: "Why?", answer: "The check wanted it." },
    { question: "What should the owner watch?", answer: "Nothing." },
  ],
};

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-ci-round-"));
}

function inspectedProject(): string {
  const project = makeFixtureRepo("exit 0");
  writeFileSync(join(project, ".inspector.json"), '{"check":"./check.sh","image":"test"}\n');
  execSync("git add .inspector.json && git -c user.email=t@t -c user.name=t commit -qm inspector-config", {
    cwd: project,
    shell: "/bin/bash",
  });
  return project;
}

/** An Inspector that always says green and always reports a pull request
 * - the only shape that reaches the checks read at all. */
function greenInspector(opts: { prUrl?: string | null } = {}): Inspector & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async inspect() {
      calls += 1;
      const prUrl = opts.prUrl === undefined ? "https://github.com/o/r/pull/7" : opts.prUrl;
      return { verdict: "green" as const, report: "ok", ...(prUrl === null ? {} : { prUrl }) };
    },
  };
}

function redInspector(): Inspector & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async inspect() {
      calls += 1;
      return { verdict: "red" as const, report: "inspector says red" };
    },
  };
}

/** A brain that writes one file per call and records every brief it got. */
function recordingBrain(): Brain & { readonly briefs: readonly string[] } {
  const briefs: string[] = [];
  let calls = 0;
  return {
    name: "fake",
    model: "fake-1",
    briefs,
    async ask() {
      return {};
    },
    async work(brief, workdir) {
      briefs.push(brief);
      calls += 1;
      writeFileSync(join(workdir, `change-${calls}.txt`), `change ${calls}\n`);
      return { transcript: [], writeup: WRITEUP };
    },
  };
}

function concluded(name: string, red: boolean, logTail?: string): ConcludedCheck {
  return {
    name,
    source: "check-run",
    conclusion: red ? "failure" : "success",
    red,
    url: `https://github.com/o/r/runs/${name}`,
    ...(logTail === undefined ? {} : { logTail }),
  };
}

function report(over: Partial<ChecksReport>): ChecksReport {
  const base: ChecksReport = {
    prUrl: "https://github.com/o/r/pull/7",
    sha: "abc123",
    verdict: "green",
    concluded: [],
    unresolved: [],
    summary: "",
    ...over,
  };
  return { ...base, summary: summarizeChecks(base) };
}

/** A fake reader answering the scripted reports in order (the last one
 * repeats), recording every pull request url it was asked about. It does
 * NOT write to the record - that is `handToPullRequestChecks`' job, which
 * is exactly why these tests can assert the events landed. */
function fakeReader(reports: (ChecksReport | undefined)[]): ChecksReader & { readonly asked: readonly string[] } {
  const asked: string[] = [];
  const reader = async (prUrl: string) => {
    asked.push(prUrl);
    return reports[Math.min(asked.length, reports.length) - 1];
  };
  return Object.assign(reader, {
    get asked() {
      return asked;
    },
  });
}

const RED_REPORT = report({
  verdict: "red",
  concluded: [concluded("tests", false), concluded("nixfmt", true, "Error: file.nix is not formatted")],
});

test("a red pull request check turns a green inspection into a red delivery with the checks' output", async () => {
  const recordHome = freshHome();
  const reader = fakeReader([RED_REPORT]);
  const foreman = createForeman({ recordHome, inspector: greenInspector(), checksReader: reader });

  const task = await foreman.do("Format the nix files", {
    project: inspectedProject(),
    brain: recordingBrain(),
    attempts: 1,
  });

  assert.equal(task.state, "delivered");
  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "inspection-red");
  // The wording names what actually went red. Inspector said green, and
  // a report blaming it would send the Client to the wrong log.
  assert.match(delivery!.summary, /The pull request's own checks went red/);
  assert.match(delivery!.summary, /nixfmt red/);
  assert.doesNotMatch(delivery!.summary, /Inspector reported the committed branch red/);
  // The output is attached, log tail and all.
  assert.match(delivery!.evidence, /--- nixfmt \(check-run\): failure/);
  assert.match(delivery!.evidence, /Error: file\.nix is not formatted/);
  assert.match(delivery!.gaps, /Inspector called this branch green and published it/);
  assert.deepEqual(reader.asked, ["https://github.com/o/r/pull/7"]);
});

test("the next counted attempt is told exactly which pull request check failed", async () => {
  const recordHome = freshHome();
  const brain = recordingBrain();
  const foreman = createForeman({
    recordHome,
    inspector: greenInspector(),
    // Red first, green once the worker has had its correction.
    checksReader: fakeReader([RED_REPORT, report({ verdict: "green", concluded: [concluded("nixfmt", false)] })]),
  });

  const task = await foreman.do("Format the nix files", {
    project: inspectedProject(),
    brain,
    // SPEC.md's default: one attempt, then one correction pass on red.
  });

  assert.equal(brain.briefs.length, 2, "the red checks did not trigger the counted retry");
  assert.match(brain.briefs[1], /--- nixfmt \(check-run\): failure/);
  assert.match(brain.briefs[1], /Error: file\.nix is not formatted/);
  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "done");
});

test("checks still running when the wait expires leave the delivery green, and say so", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({
    recordHome,
    inspector: greenInspector(),
    checksReader: fakeReader([
      report({
        verdict: "unknown",
        concluded: [concluded("tests", false)],
        unresolved: [{ name: "rehearsal", source: "check-run", status: "in_progress", url: null }],
      }),
    ]),
  });

  const task = await foreman.do("Format the nix files", {
    project: inspectedProject(),
    brain: recordingBrain(),
    attempts: 1,
  });

  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "done");
  // Never silently green: the delivery's own evidence says one check
  // never answered.
  assert.match(delivery!.evidence, /the pull request's own checks: 1 green, 1 unknown \(rehearsal\)/);
});

test("an unreadable API leaves the delivery on Inspector's verdict and records why", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({
    recordHome,
    inspector: greenInspector(),
    checksReader: fakeReader([report({ verdict: "unreadable", problem: "GitHub answered 403 for GET /x" })]),
  });

  const task = await foreman.do("Format the nix files", {
    project: inspectedProject(),
    brain: recordingBrain(),
    attempts: 1,
  });

  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "done");
  assert.match(delivery!.evidence, /could not be read: GitHub answered 403/);
});

test("a red inspection is never asked about a pull request - nothing was published", async () => {
  const recordHome = freshHome();
  const reader = fakeReader([RED_REPORT]);
  const foreman = createForeman({ recordHome, inspector: redInspector(), checksReader: reader });

  await foreman.do("Format the nix files", { project: inspectedProject(), brain: recordingBrain(), attempts: 1 });

  assert.deepEqual(reader.asked, []);
});

test("a green inspection that opened no pull request is never asked about one either", async () => {
  const recordHome = freshHome();
  const reader = fakeReader([RED_REPORT]);
  const foreman = createForeman({ recordHome, inspector: greenInspector({ prUrl: null }), checksReader: reader });

  const task = await foreman.do("Format the nix files", {
    project: inspectedProject(),
    brain: recordingBrain(),
    attempts: 1,
  });

  assert.deepEqual(reader.asked, []);
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "done");
});

test("a reader that finds nothing to read leaves the delivery exactly as it was", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({
    recordHome,
    inspector: greenInspector(),
    // What the real watcher answers for a pull request url with no
    // GitHub API behind it.
    checksReader: fakeReader([undefined]),
  });

  const task = await foreman.do("Format the nix files", {
    project: inspectedProject(),
    brain: recordingBrain(),
    attempts: 1,
  });

  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "done");
  assert.doesNotMatch(delivery!.evidence, /pull request's own checks/);
});

test("a fix round on a CI-red delivery hands the worker the Client's note AND the red checks", async () => {
  const recordHome = freshHome();
  const brain = recordingBrain();
  const foreman = createForeman({
    recordHome,
    inspector: greenInspector(),
    checksReader: fakeReader([RED_REPORT, report({ verdict: "green", concluded: [concluded("nixfmt", false)] })]),
    brain,
  });

  const task = await foreman.do("Format the nix files", {
    project: inspectedProject(),
    brain,
    attempts: 1,
  });
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "inspection-red");

  await foreman.verdict(task.id, "fix", "use the project's own formatter settings");

  const fixBrief = brain.briefs.at(-1)!;
  assert.match(fixBrief, /use the project's own formatter settings/);
  assert.match(fixBrief, /--- nixfmt \(check-run\): failure/);
  assert.match(fixBrief, /after Inspector had already called this branch green/);
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "done");
});

test("a fix round on a delivery that was NOT red on the pull request's checks carries no such correction", async () => {
  const recordHome = freshHome();
  const brain = recordingBrain();
  const foreman = createForeman({
    recordHome,
    inspector: redInspector(),
    checksReader: fakeReader([RED_REPORT]),
    brain,
  });

  const task = await foreman.do("Format the nix files", { project: inspectedProject(), brain, attempts: 1 });
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "inspection-red");

  await foreman.verdict(task.id, "fix", "try the other formatter");

  const fixBrief = brain.briefs.at(-1)!;
  assert.match(fixBrief, /try the other formatter/);
  assert.doesNotMatch(fixBrief, /after Inspector had already called this branch green/);
});

test("every concluded check lands on the record, with a summary event behind it", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({
    recordHome,
    inspector: greenInspector(),
    checksReader: fakeReader([RED_REPORT]),
  });

  const task = await foreman.do("Format the nix files", {
    project: inspectedProject(),
    brain: recordingBrain(),
    attempts: 1,
  });

  const events = await foreman.events(task.id);
  const concludedEvents = events
    .filter((event) => event.name === "ci-check-concluded")
    .map((event) => event.details as CiCheckConcludedDetails);
  assert.deepEqual(
    concludedEvents.map((details) => [details.name, details.red]),
    [
      ["tests", false],
      ["nixfmt", true],
    ]
  );
  assert.match(concludedEvents[1].logTail ?? "", /not formatted/);

  const finished = events.find((event) => event.name === "ci-checks-finished")!.details as CiChecksFinishedDetails;
  assert.equal(finished.verdict, "red");
  assert.deepEqual(finished.red, ["nixfmt"]);
  assert.equal(finished.summary, "1 green, nixfmt red");

  // Ordering matters: the summary is what every task line reads, and it
  // must not land before the per-check detail behind it.
  const names = events.map((event) => event.name);
  assert.ok(
    names.lastIndexOf("ci-check-concluded") < names.lastIndexOf("ci-checks-finished"),
    "the summary landed before the checks it summarizes"
  );
  assert.ok(
    names.lastIndexOf("ci-checks-finished") < names.lastIndexOf("delivered"),
    "the checks were read after the delivery was already written"
  );
});

test("a check that never concluded is recorded as unknown and never gets a concluded event", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({
    recordHome,
    inspector: greenInspector(),
    checksReader: fakeReader([
      report({
        verdict: "unknown",
        unresolved: [{ name: "rehearsal", source: "check-run", status: "queued", url: null }],
      }),
    ]),
  });

  const task = await foreman.do("Format the nix files", {
    project: inspectedProject(),
    brain: recordingBrain(),
    attempts: 1,
  });

  const events = await foreman.events(task.id);
  assert.equal(events.some((event) => event.name === "ci-check-concluded"), false);
  const finished = events.find((event) => event.name === "ci-checks-finished")!.details as CiChecksFinishedDetails;
  assert.equal(finished.verdict, "unknown");
  assert.deepEqual(finished.unknown, [{ name: "rehearsal", source: "check-run", status: "queued", url: null }]);
  assert.equal(finished.green, 0);
});

test("nothing is recorded when there was nothing to read", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({
    recordHome,
    inspector: greenInspector(),
    checksReader: fakeReader([undefined]),
  });

  const task = await foreman.do("Format the nix files", {
    project: inspectedProject(),
    brain: recordingBrain(),
    attempts: 1,
  });

  const names = (await foreman.events(task.id)).map((event) => event.name);
  assert.equal(names.includes("ci-checks-finished"), false);
  assert.equal(names.includes("ci-check-concluded"), false);
});

test("a heartbeat the read asks for lands on the record, so a long wait never reads as quiet", async () => {
  const recordHome = freshHome();
  const ticking: ChecksReader = async (_prUrl, onTick) => {
    onTick();
    onTick();
    return report({ verdict: "green", concluded: [concluded("tests", false)] });
  };
  const foreman = createForeman({ recordHome, inspector: greenInspector(), checksReader: ticking });

  const task = await foreman.do("Format the nix files", {
    project: inspectedProject(),
    brain: recordingBrain(),
    attempts: 1,
  });

  const ciHeartbeats = (await foreman.events(task.id)).filter(
    (event) => event.name === "heartbeat" && (event.details as { phase?: string } | undefined)?.phase === "ci-checks"
  );
  assert.equal(ciHeartbeats.length, 2);
});

// Issue #348's second half: whether a red check on the pull request may
// start a correcting attempt by itself is this project's own setting,
// `projects.toml`'s `retryOnRedChecks`. On unless the project says
// otherwise, which is what every project did before it existed.

/** Registers `project` in a record home's projects.toml, optionally
 * naming the setting. */
function register(recordHome: string, project: string, line = ""): void {
  writeFileSync(
    join(recordHome, "projects.toml"),
    `[projects.fixture]\npath = ${JSON.stringify(project)}\ncheck = "./check.sh"\n${line}`
  );
}

test("retryOnRedChecksFor: on by default, and for a project nobody registered", () => {
  const recordHome = freshHome();
  const project = inspectedProject();
  assert.equal(retryOnRedChecksFor(recordHome, project), true, "no projects.toml at all");

  register(recordHome, project);
  assert.equal(retryOnRedChecksFor(recordHome, project), true, "an entry that says nothing");
  assert.equal(retryOnRedChecksFor(recordHome, inspectedProject()), true, "a path with no entry");
});

test("retryOnRedChecksFor: the project's own answer, either way", () => {
  const recordHome = freshHome();
  const project = inspectedProject();

  register(recordHome, project, "retryOnRedChecks = false\n");
  assert.equal(retryOnRedChecksFor(recordHome, project), false);

  register(recordHome, project, "retryOnRedChecks = true\n");
  assert.equal(retryOnRedChecksFor(recordHome, project), true);
});

test("retryOnRedChecksFor: a registry too broken to read is not what reports it - the default stands", () => {
  const recordHome = freshHome();
  writeFileSync(join(recordHome, "projects.toml"), "this is not toml = = =\n");
  assert.equal(retryOnRedChecksFor(recordHome, inspectedProject()), true);
});

test("retryOnRedChecks = false: a red check delivers red without spending another attempt", async () => {
  const recordHome = freshHome();
  const project = inspectedProject();
  register(recordHome, project, "retryOnRedChecks = false\n");
  const brain = recordingBrain();
  const foreman = createForeman({
    recordHome,
    inspector: greenInspector(),
    checksReader: fakeReader([RED_REPORT]),
  });

  const task = await foreman.do("Format the nix files", { project, brain });

  assert.equal(brain.briefs.length, 1, "the red checks started an attempt this project asked not to have");
  const delivery = await foreman.deliveryOf(task.id);
  // Still red, and still carrying the checks' own output: the Client
  // rules on it, which is the whole point of not retrying it here.
  assert.equal(delivery?.outcome, "inspection-red");
  assert.match(delivery!.summary, /The pull request's own checks went red/);
  assert.match(delivery!.evidence, /--- nixfmt \(check-run\): failure/);
  assert.equal(task.state, "delivered");
});

test("retryOnRedChecks = true, written out: the correcting attempt happens exactly as before", async () => {
  const recordHome = freshHome();
  const project = inspectedProject();
  register(recordHome, project, "retryOnRedChecks = true\n");
  const brain = recordingBrain();
  const foreman = createForeman({
    recordHome,
    inspector: greenInspector(),
    checksReader: fakeReader([RED_REPORT, report({ verdict: "green", concluded: [concluded("nixfmt", false)] })]),
  });

  await foreman.do("Format the nix files", { project, brain });

  assert.equal(brain.briefs.length, 2);
  assert.match(brain.briefs[1], /--- nixfmt \(check-run\): failure/);
});

test("retryOnRedChecks = false is about the pull request's checks, and nothing else that goes red", async () => {
  const recordHome = freshHome();
  const project = inspectedProject();
  register(recordHome, project, "retryOnRedChecks = false\n");
  const brain = recordingBrain();
  const foreman = createForeman({
    recordHome,
    // Inspector itself says red, so no pull request is opened and no
    // check on one is ever read. This setting waives a red that arrived
    // after Inspector had already passed the branch - it is not a
    // licence to stop correcting an ordinary failed check.
    inspector: redInspector(),
    checksReader: fakeReader([undefined]),
  });

  await foreman.do("Format the nix files", { project, brain });

  assert.equal(brain.briefs.length, 2, "an Inspector red still gets its correcting attempt");
  assert.match(brain.briefs[1], /Inspector reported red/);
});

test("retryOnRedChecks = false never shortens a count the Client asked for", async () => {
  const recordHome = freshHome();
  const project = inspectedProject();
  register(recordHome, project, "retryOnRedChecks = false\n");
  const brain = recordingBrain();
  const foreman = createForeman({
    recordHome,
    inspector: greenInspector(),
    checksReader: fakeReader([RED_REPORT]),
  });

  // Every one of these attempts was going to run whatever this round's
  // checks said, so the red is not what caused the second one - and
  // rule 3 says a count given is a count honored.
  await foreman.do("Format the nix files", { project, brain, attempts: 2 });

  assert.equal(brain.briefs.length, 2);
});
