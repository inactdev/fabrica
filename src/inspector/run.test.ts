import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  declaresTestPaths,
  extractPrUrl,
  inspectorAdapter,
  inspectorIsConfigured,
  reportForRecord,
  MAX_INSPECTION_REPORT_BYTES,
} from "./run.ts";

/** A stand-in for the GitHub App (issue #187), so no test here needs a
 * registered App, a private key, or the network. `check()` passes and
 * `mint()` hands back a fixed fake token. */
function fakeToken(token = "fake-test-token") {
  return { check() {}, async mint() { return mintedFake(token); } };
}

function mintedFake(token: string) {
  return {
    token,
    expiresAt: "2026-01-01T01:00:00Z",
    owner: "o",
    repo: "r",
    permissions: { contents: "write", pull_requests: "write", statuses: "write" },
    installationId: 1,
    repositorySelection: "selected",
  };
}

function testAdapter(command: string) {
  return inspectorAdapter(command, { env: { ...process.env }, token: fakeToken() });
}

/** The ratified consumer contract (issue #109): the one copy of the call's
 * flags and exit-code mapping Fabrica commits, mirrored byte-for-byte into
 * Inspector's own repo by a CI job that reads this file, never hand-copied.
 * Tests below derive their expectations from here so a flag or exit code
 * changed in run.ts without a matching edit here fails this suite. */
interface ConsumerContract {
  flags: { name: string; description: string; required?: boolean }[];
  exitCodes: Record<string, number>;
  stdout: { pullRequestLine: string };
  env: { githubToken: string };
}

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT: ConsumerContract = JSON.parse(readFileSync(join(here, "consumer-contract.json"), "utf8"));

/** The `-<name>` argv flag for a contract-declared flag, failing loudly if
 * run.ts and consumer-contract.json ever name it differently. */
function flag(name: string): string {
  const declared = CONTRACT.flags.find((f) => f.name === name);
  assert.ok(declared, `consumer-contract.json declares no "${name}" flag`);
  return `-${declared.name}`;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-inspector-"));
}

function command(dir: string, exitCode: number, output: string): string {
  const path = join(dir, `inspector-${exitCode}.sh`);
  writeFileSync(path, `#!/bin/sh\nprintf '%s' ${JSON.stringify(output)}\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
  return path;
}

function commandStreams(dir: string, exitCode: number, stdout: string, stderr: string): string {
  const path = join(dir, `inspector-streams-${exitCode}.sh`);
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s' ${JSON.stringify(stdout)}\nprintf '%s' ${JSON.stringify(stderr)} >&2\nexit ${exitCode}\n`
  );
  chmodSync(path, 0o755);
  return path;
}

test("inspectorAdapter maps Inspector's three verdict exit codes without the real binary or GitHub", async () => {
  const workdir = tempDir();

  for (const [verdict, exitCode] of Object.entries(CONTRACT.exitCodes)) {
    const inspection = await testAdapter(command(workdir, exitCode, `${verdict} report`)).inspect({
      branch: "fabrica/task",
      workdir,
    });
    assert.deepEqual(inspection, { verdict, report: `${verdict} report` });
  }
});

test("inspectorAdapter treats every other exit as refused rather than red", async () => {
  const workdir = tempDir();
  const inspection = await testAdapter(command(workdir, 64, "bad invocation")).inspect({
    branch: "fabrica/task",
    workdir,
  });

  assert.deepEqual(inspection, { verdict: "refused", report: "bad invocation" });
});

test("inspectorIsConfigured only accepts a project-local Inspector config", () => {
  const workdir = tempDir();
  assert.equal(inspectorIsConfigured(workdir), false);
  writeFileSync(join(workdir, ".inspector.json"), "{}\n");
  assert.equal(inspectorIsConfigured(workdir), true);
});

test("inspectorAdapter bounds streamed output and reports its true byte count", async () => {
  const workdir = tempDir();
  const stdout = "x".repeat(MAX_INSPECTION_REPORT_BYTES * 4);
  const stderr = "reason at end";
  const total = Buffer.byteLength(stdout) + 1 + Buffer.byteLength(stderr);
  const inspection = await testAdapter(commandStreams(workdir, 2, stdout, stderr)).inspect({
    branch: "fabrica/task",
    workdir,
  });

  assert.equal(inspection.verdict, "refused");
  assert.match(inspection.report, new RegExp(`^\\[truncated, showing last \\d+ of ${total} bytes\\]\\n`));
  assert.match(inspection.report, /reason at end$/);
  assert.ok(Buffer.byteLength(inspection.report) <= MAX_INSPECTION_REPORT_BYTES);
});

test("reportForRecord keeps Inspector's final diagnosis within the record limit", () => {
  const report = `start\n${"x".repeat(MAX_INSPECTION_REPORT_BYTES)}\nreason at end`;
  const saved = reportForRecord(report);

  assert.match(saved, /^\[truncated, showing last/);
  assert.match(saved, /reason at end$/);
  assert.ok(Buffer.byteLength(saved, "utf8") < Buffer.byteLength(report, "utf8"));
});

test("inspectorAdapter names the branch Inspector may publish: -branch fabrica/<taskId>", async () => {
  const workdir = tempDir();
  const path = join(workdir, "inspector-args.sh");
  writeFileSync(path, '#!/bin/sh\nprintf \'%s \' "$@"\nexit 0\n');
  chmodSync(path, 0o755);

  const inspection = await testAdapter(path).inspect({ branch: "fabrica/task-1", workdir });

  assert.equal(inspection.report, `${flag("repo")} ${workdir} ${flag("branch")} fabrica/task-1`);
});

// Negative first: a green run that never printed the line gets no prUrl -
// the only thing a "pr-opened" event is ever allowed to key on.
test("inspectorAdapter reports no prUrl when Inspector's stdout never prints the pull request line", async () => {
  const workdir = tempDir();
  const inspection = await testAdapter(command(workdir, 0, "all good, nothing more to say")).inspect({
    branch: "fabrica/task",
    workdir,
  });

  assert.equal(inspection.verdict, "green");
  assert.equal(inspection.prUrl, undefined);
});

test("inspectorAdapter reads the pull request url from Inspector's own stdout line", async () => {
  const workdir = tempDir();
  // command()'s printf '%s' <json-string> never turns an embedded "\n"
  // into a real newline (printf's %s never interprets its argument) - two
  // separate printf calls, each with a real newline in its own format
  // string, are used here instead.
  const path = join(workdir, "inspector-pr-url.sh");
  writeFileSync(path, "#!/bin/sh\nprintf 'checks passed\\n'\nprintf 'pull request: https://example.test/pulls/9\\n'\nexit 0\n");
  chmodSync(path, 0o755);

  const inspection = await testAdapter(path).inspect({ branch: "fabrica/task", workdir });

  assert.equal(inspection.verdict, "green");
  assert.equal(inspection.prUrl, "https://example.test/pulls/9");
});

test("extractPrUrl takes the last pull request line when more than one appears", () => {
  assert.equal(extractPrUrl("pull request: https://x/1\nnoise\npull request: https://x/2\n"), "https://x/2");
  assert.equal(extractPrUrl("nothing relevant here"), undefined);
});

// $1=-repo $2=workdir $3=-branch $4=branch $5=-pr-title $6=<title>
// $7=-pr-body-file $8=<path to the body file>
test("inspectorAdapter passes -pr-title and -pr-body-file, and the body file holds the given text", async () => {
  const workdir = tempDir();
  const path = join(workdir, "inspector-pr-args.sh");
  writeFileSync(path, '#!/bin/sh\nprintf \'%s|%s|%s|%s|%s|%s|%s|\' "$1" "$2" "$3" "$4" "$5" "$6" "$7"\ncat "$8"\nexit 0\n');
  chmodSync(path, 0o755);

  const inspection = await testAdapter(path).inspect({
    branch: "fabrica/task-1",
    workdir,
    prTitle: "Fix the login bug",
    prBody: "Completed: Fix the login bug\n\nDeviations:\nNone.\n",
  });

  assert.equal(
    inspection.report,
    [flag("repo"), workdir, flag("branch"), "fabrica/task-1", flag("pr-title"), "Fix the login bug", flag("pr-body-file")].join(
      "|"
    ) +
      "|" +
      "Completed: Fix the login bug\n\nDeviations:\nNone."
  );
});

test("inspectorAdapter passes the expected tip only when the caller has one (inspector#53)", async () => {
  const workdir = tempDir();
  const path = join(workdir, "inspector-args.sh");
  writeFileSync(path, '#!/bin/sh\nprintf \'%s \' "$@"\nexit 0\n');
  chmodSync(path, 0o755);
  const adapter = testAdapter(path);
  const tip = "0123456789abcdef0123456789abcdef01234567";

  const leased = await adapter.inspect({ branch: "fabrica/task-1", workdir, expectedTip: tip });
  assert.equal(
    leased.report,
    `${flag("repo")} ${workdir} ${flag("branch")} fabrica/task-1 ${flag("expected-tip")} ${tip}`
  );

  // Omitted, not passed empty: Inspector publishes exactly as it did
  // before this flag existed.
  const unleased = await adapter.inspect({ branch: "fabrica/task-1", workdir });
  assert.equal(unleased.report, `${flag("repo")} ${workdir} ${flag("branch")} fabrica/task-1`);
});

test("inspectorAdapter cleans up the pr-body temp file after Inspector exits", async () => {
  const workdir = tempDir();
  const path = join(workdir, "inspector-echo-path.sh");
  writeFileSync(path, '#!/bin/sh\necho "$6" > "' + join(workdir, "captured-path.txt") + '"\nexit 0\n');
  chmodSync(path, 0o755);

  await testAdapter(path).inspect({ branch: "fabrica/task", workdir, prBody: "body text" });

  const { readFileSync, existsSync } = await import("node:fs");
  const capturedPath = readFileSync(join(workdir, "captured-path.txt"), "utf8").trim();
  assert.ok(capturedPath.length > 0);
  assert.equal(existsSync(capturedPath), false, "the temp pr-body file must not survive the call");
});

test("inspectorAdapter reports whether its command is installed", () => {
  const workdir = tempDir();
  assert.equal(inspectorAdapter(command(workdir, 0, "ok")).installed?.(), true);
  assert.equal(inspectorAdapter(join(workdir, "missing-inspector")).installed?.(), false);
  assert.equal(inspectorAdapter("sh").installed?.(), true, "a bare name is looked up on PATH");
});

// The reviewer (src/reviewer/): Inspector judges a change's test edits
// with a model of its own, and Fabrica is the side that names it. The
// flag spellings are derived from consumer-contract.json, like every
// other flag above, so renaming one in run.ts without carrying it to
// the file Inspector's own side is synced from fails here.
const REVIEWER = {
  vendor: "second-opinion",
  model: "careful-reader",
  apiKeyVar: "SECOND_OPINION_API_KEY",
  apiKey: "secret-review-key",
  baseUrlVar: "SECOND_OPINION_BASE_URL",
};

function argsEcho(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nprintf '%s ' \"$@\"\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

test("inspectorAdapter names the reviewer with -vendor and -model when one is configured", async () => {
  const workdir = tempDir();
  const path = argsEcho(workdir, "inspector-reviewer-args.sh");

  const inspection = await inspectorAdapter(path, {
    env: {},
    token: fakeToken(),
    reviewer: REVIEWER,
  }).inspect({ branch: "fabrica/task-1", workdir });

  assert.equal(
    inspection.report,
    [flag("repo"), workdir, flag("branch"), "fabrica/task-1", flag("vendor"), REVIEWER.vendor, flag("model"), REVIEWER.model].join(
      " "
    )
  );
});

test("inspectorAdapter passes no reviewer flags at all when none is configured", async () => {
  const workdir = tempDir();
  const path = argsEcho(workdir, "inspector-no-reviewer-args.sh");

  const inspection = await testAdapter(path).inspect({ branch: "fabrica/task-1", workdir });

  assert.doesNotMatch(inspection.report, new RegExp(flag("vendor")));
  assert.doesNotMatch(inspection.report, new RegExp(flag("model")));
});

// The key is a credential: it rides the child's environment, where only
// that child can read it, never argv, which every process on the machine
// can read out of the process table.
test("inspectorAdapter hands the reviewer's key to the child's environment and never to its arguments", async () => {
  const workdir = tempDir();
  const path = join(workdir, "inspector-reviewer-env.sh");
  writeFileSync(
    path,
    `#!/bin/sh\nprintf 'args=%s ' "$@"\nprintf 'key=%s base=%s' "$${REVIEWER.apiKeyVar}" "$${REVIEWER.baseUrlVar}"\nexit 0\n`
  );
  chmodSync(path, 0o755);

  const inspection = await inspectorAdapter(path, {
    env: {},
    token: fakeToken(),
    reviewer: { ...REVIEWER, baseUrl: "https://review.test/v1" },
  }).inspect({ branch: "fabrica/task-1", workdir });

  assert.match(inspection.report, /key=secret-review-key/, "the child must be able to read the key");
  assert.match(inspection.report, /base=https:\/\/review\.test\/v1/, "a configured base url is forwarded too");
  assert.doesNotMatch(inspection.report.split("key=")[0], /secret-review-key/, "the key must never be an argument");
});

test("declaresTestPaths reads the config at a commit, not the worktree a worker has touched", () => {
  const workdir = tempDir();
  writeFileSync(join(workdir, ".inspector.json"), '{"check":"./check.sh","image":"alpine"}\n');
  assert.equal(declaresTestPaths(workdir), false);

  writeFileSync(join(workdir, ".inspector.json"), '{"check":"./check.sh","testPaths":"*.test.ts"}\n');
  assert.equal(declaresTestPaths(workdir), true);

  writeFileSync(join(workdir, ".inspector.json"), '{"testPaths":["*.test.ts","spec/**"]}\n');
  assert.equal(declaresTestPaths(workdir), true);

  writeFileSync(join(workdir, ".inspector.json"), '{"testPaths":[]}\n');
  assert.equal(declaresTestPaths(workdir), false, "an empty list asks for nothing to be judged");

  writeFileSync(join(workdir, ".inspector.json"), "not json at all\n");
  assert.equal(declaresTestPaths(workdir), false, "an unparseable config is Inspector's refusal to make, not a demand for a reviewer");
});

// Work mode (issue #316): a repository none of Inspector's three files
// may be committed to, and whose CI must not be touched. Both flags are
// Inspector's own (`-terms`, `-no-stamp`), declared in
// consumer-contract.json like every other flag above, so renaming one
// here without carrying it to the file Inspector's side is synced from
// fails this suite.

test("inspectorAdapter hands Inspector the terms folder for a project whose terms live outside its repository", async () => {
  const workdir = tempDir();
  const terms = tempDir();
  const path = argsEcho(workdir, "inspector-terms-args.sh");

  const inspection = await inspectorAdapter(path, { env: {}, token: fakeToken(), terms }).inspect({
    branch: "fabrica/task-1",
    workdir,
  });

  assert.equal(
    inspection.report,
    [flag("repo"), workdir, flag("branch"), "fabrica/task-1", flag("terms"), terms].join(" ")
  );
});

test("inspectorAdapter asks for no stamp with a bare flag, taking no value", async () => {
  const workdir = tempDir();
  const path = argsEcho(workdir, "inspector-no-stamp-args.sh");

  const inspection = await inspectorAdapter(path, { env: {}, token: fakeToken(), noStamp: true }).inspect({
    branch: "fabrica/task-1",
    workdir,
  });

  assert.equal(inspection.report, [flag("repo"), workdir, flag("branch"), "fabrica/task-1", flag("no-stamp")].join(" "));
});

test("inspectorAdapter passes neither work-mode flag for a project that carries neither setting", async () => {
  const workdir = tempDir();
  const path = argsEcho(workdir, "inspector-no-work-mode-args.sh");

  const inspection = await inspectorAdapter(path, { env: {}, token: fakeToken(), noStamp: false }).inspect({
    branch: "fabrica/task-1",
    workdir,
  });

  assert.equal(inspection.report, [flag("repo"), workdir, flag("branch"), "fabrica/task-1"].join(" "));
});

test("inspectorAdapter carries both work-mode flags together, with everything else it was given", async () => {
  const workdir = tempDir();
  const terms = tempDir();
  const path = argsEcho(workdir, "inspector-work-mode-args.sh");

  const inspection = await inspectorAdapter(path, {
    env: {},
    token: fakeToken(),
    terms,
    noStamp: true,
    reviewer: REVIEWER,
  }).inspect({ branch: "fabrica/task-1", workdir, expectedTip: "f".repeat(40) });

  assert.equal(
    inspection.report,
    [
      flag("repo"),
      workdir,
      flag("branch"),
      "fabrica/task-1",
      flag("terms"),
      terms,
      flag("no-stamp"),
      flag("expected-tip"),
      "f".repeat(40),
      flag("vendor"),
      REVIEWER.vendor,
      flag("model"),
      REVIEWER.model,
    ].join(" ")
  );
});
