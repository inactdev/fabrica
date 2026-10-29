// Issue #306. Two layers, on purpose: the refusal list itself, judged
// from facts handed in so every case is covered without a repository,
// and the reader, judged against real `git` in real throwaway
// repositories so the two read modes (a commit's tree, the working
// tree) are not just asserted to differ.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectorConfigProblem,
  inspectorConfigProblemIn,
  readInspectorConfigFacts,
  INSPECTOR_DOCKERFILE,
} from "./config-check.ts";

const GOOD_CONFIG = '{"check":"./check.sh"}\n';

test("a project with no .inspector.json has nothing to refuse", () => {
  assert.equal(inspectorConfigProblemIn({ config: null, dockerfile: "absent" }), null);
});

test("a config with no retired key and a committed Dockerfile passes", () => {
  assert.equal(inspectorConfigProblemIn({ config: GOOD_CONFIG, dockerfile: "committed" }), null);
});

test('a retired "image" key is refused in Inspector\'s own words, with the hand fix', () => {
  const problem = inspectorConfigProblemIn({
    config: '{"check":"./check.sh","image":"alpine"}',
    dockerfile: "committed",
  });
  assert.equal(problem?.refusal, "retired-image-key");
  assert.match(problem!.detail, /still names an "image"/);
  assert.match(problem!.detail, /has been retired/);
  assert.match(problem!.fix, /remove the "image" field/);
  // The fix is the Client's hand change and names the file to add, since
  // Fabrica never writes either one.
  assert.match(problem!.fix, new RegExp(INSPECTOR_DOCKERFILE));
});

test('a retired "network" key is refused, and names where the install moves to', () => {
  const problem = inspectorConfigProblemIn({
    config: '{"check":"./check.sh","network":true}',
    dockerfile: "committed",
  });
  assert.equal(problem?.refusal, "retired-network-key");
  assert.match(problem!.detail, /still carries the "network" opt-in/);
  assert.match(problem!.fix, /the build may use the network, the check may not/);
});

// Inspector decodes both retired fields into a json.RawMessage for
// exactly this reason: what is refused is the key's presence, because a
// `"network": false` it accepted would read as a setting that still does
// something.
for (const value of ["false", "null", "0", '""']) {
  test(`a "network" key set to ${value} is still a refusal`, () => {
    const problem = inspectorConfigProblemIn({
      config: `{"check":"./check.sh","network":${value}}`,
      dockerfile: "committed",
    });
    assert.equal(problem?.refusal, "retired-network-key");
  });
}

test('an "image" key set to null is still a refusal', () => {
  const problem = inspectorConfigProblemIn({ config: '{"check":"./check.sh","image":null}', dockerfile: "committed" });
  assert.equal(problem?.refusal, "retired-image-key");
});

// Inspector loads the config before it resolves the Dockerfile, so the
// first problem Fabrica names is the first one Inspector would.
test("a config with both problems names the retired key, the way Inspector would", () => {
  const problem = inspectorConfigProblemIn({ config: '{"check":"./check.sh","image":"alpine"}', dockerfile: "absent" });
  assert.equal(problem?.refusal, "retired-image-key");
});

test('"image" is named before "network", the order Inspector checks them in', () => {
  const problem = inspectorConfigProblemIn({
    config: '{"check":"./check.sh","image":"alpine","network":true}',
    dockerfile: "committed",
  });
  assert.equal(problem?.refusal, "retired-image-key");
});

test("no committed Dockerfile.inspector is refused, naming the file to add", () => {
  const problem = inspectorConfigProblemIn({ config: GOOD_CONFIG, dockerfile: "absent" });
  assert.equal(problem?.refusal, "no-dockerfile");
  assert.match(problem!.detail, /commits no Dockerfile\.inspector/);
  assert.match(problem!.detail, /no image to run its check in/);
  assert.match(problem!.fix, /commit it/);
});

test("a Dockerfile.inspector git does not track is its own refusal", () => {
  const problem = inspectorConfigProblemIn({ config: GOOD_CONFIG, dockerfile: "untracked" });
  assert.equal(problem?.refusal, "uncommitted-dockerfile");
  assert.match(problem!.detail, /git does not track it/);
  assert.equal(problem!.fix, `commit ${INSPECTOR_DOCKERFILE}`);
});

// The settled precedent (run.ts's `declaresTestPaths`): an unparseable
// config is Inspector's own refusal to make, and a key question cannot
// be answered about a file that is not JSON. What CAN still be answered
// about it - whether the Dockerfile is committed - still is.
test("a config that will not parse has its key checks skipped, not guessed at", () => {
  assert.equal(inspectorConfigProblemIn({ config: "{not json", dockerfile: "committed" }), null);
});

test("a config that will not parse is still checked for the committed Dockerfile", () => {
  const problem = inspectorConfigProblemIn({ config: "{not json", dockerfile: "absent" });
  assert.equal(problem?.refusal, "no-dockerfile");
});

test("a config that is valid JSON but not an object has its key checks skipped", () => {
  assert.equal(inspectorConfigProblemIn({ config: "[1,2,3]", dockerfile: "committed" }), null);
  assert.equal(inspectorConfigProblemIn({ config: "null", dockerfile: "committed" }), null);
});

// ---------------------------------------------------------------- the reader

const made: string[] = [];

function repo(files: Record<string, string>, opts: { commit?: boolean; ignore?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-config-check-"));
  made.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  if (opts.ignore !== undefined) writeFileSync(join(dir, ".gitignore"), `${opts.ignore}\n`);
  if (opts.commit !== false) {
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  }
  return dir;
}

function head(dir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

test.after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

test("the working-tree read sees a retired key and a committed Dockerfile", () => {
  const dir = repo({
    ".inspector.json": '{"check":"./check.sh","image":"alpine"}\n',
    [INSPECTOR_DOCKERFILE]: "FROM alpine\n",
  });
  assert.deepEqual(readInspectorConfigFacts(dir), {
    config: '{"check":"./check.sh","image":"alpine"}\n',
    dockerfile: "committed",
  });
  assert.equal(inspectorConfigProblem(dir)?.refusal, "retired-image-key");
});

test("a gitignored Dockerfile.inspector reads as untracked, not as committed", () => {
  const dir = repo(
    { ".inspector.json": GOOD_CONFIG, [INSPECTOR_DOCKERFILE]: "FROM alpine\n" },
    { ignore: INSPECTOR_DOCKERFILE }
  );
  assert.equal(readInspectorConfigFacts(dir).dockerfile, "untracked");
  assert.equal(inspectorConfigProblem(dir)?.refusal, "uncommitted-dockerfile");
});

test("a directory of that name is not a Dockerfile", () => {
  const dir = repo({ ".inspector.json": GOOD_CONFIG });
  mkdirSync(join(dir, INSPECTOR_DOCKERFILE));
  assert.equal(readInspectorConfigFacts(dir).dockerfile, "absent");
});

test("a project with no .inspector.json is never refused, Dockerfile or not", () => {
  const dir = repo({ "check.sh": "exit 0\n" });
  assert.equal(readInspectorConfigFacts(dir).config, null);
  assert.equal(inspectorConfigProblem(dir), null);
  assert.equal(inspectorConfigProblem(dir, head(dir)), null);
});

test("the revision read answers about that commit, not about the working tree", () => {
  const dir = repo({
    ".inspector.json": '{"check":"./check.sh","image":"alpine"}\n',
    [INSPECTOR_DOCKERFILE]: "FROM alpine\n",
  });
  const base = head(dir);
  // The config fixed in the working tree, uncommitted: the commit the
  // task would be cut from still carries the retired key, and that is
  // what a round is judged at.
  writeFileSync(join(dir, ".inspector.json"), GOOD_CONFIG);
  assert.equal(inspectorConfigProblem(dir), null, "the working tree is clean of it");
  assert.equal(inspectorConfigProblem(dir, base)?.refusal, "retired-image-key");
});

test("a commit with no Dockerfile.inspector is refused even once one is added later", () => {
  const dir = repo({ ".inspector.json": GOOD_CONFIG });
  const base = head(dir);
  writeFileSync(join(dir, INSPECTOR_DOCKERFILE), "FROM alpine\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "box"], { cwd: dir });
  assert.equal(inspectorConfigProblem(dir), null, "HEAD now commits one");
  assert.equal(inspectorConfigProblem(dir, base)?.refusal, "no-dockerfile");
});

// A commit cannot hold an untracked file, so there is no "untracked"
// answer to give about one - `no-dockerfile` is what Inspector itself
// would say about that commit.
test("the revision read never answers untracked", () => {
  const dir = repo(
    { ".inspector.json": GOOD_CONFIG, [INSPECTOR_DOCKERFILE]: "FROM alpine\n" },
    { ignore: INSPECTOR_DOCKERFILE }
  );
  assert.equal(readInspectorConfigFacts(dir, head(dir)).dockerfile, "absent");
});

test("a revision git cannot resolve is not a refusal about the config", () => {
  const dir = repo({ ".inspector.json": GOOD_CONFIG, [INSPECTOR_DOCKERFILE]: "FROM alpine\n" });
  // Nothing is read, so nothing is claimed about the keys; the missing
  // Dockerfile in a tree that does not exist is all this can report, and
  // it is reported rather than thrown.
  const facts = readInspectorConfigFacts(dir, "0000000000000000000000000000000000000000");
  assert.equal(facts.config, null);
  assert.equal(inspectorConfigProblemIn(facts), null);
});

test("a path that is not a git repository at all does not throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-config-check-bare-"));
  made.push(dir);
  writeFileSync(join(dir, ".inspector.json"), GOOD_CONFIG);
  // No git to ask whether the file is committed, and nothing is invented
  // about it: the one answerable question - the retired keys - is
  // answered, and this config carries none.
  assert.equal(inspectorConfigProblem(dir)?.refusal, "no-dockerfile");
  writeFileSync(join(dir, INSPECTOR_DOCKERFILE), "FROM alpine\n");
  assert.equal(inspectorConfigProblem(dir), null);
});
