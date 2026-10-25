import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadSkipRules, parseSkipRules, SKIP_RULES_PATH } from "./load.ts";
import { SkipRuleError } from "./errors.ts";

const VALID = `version = 2

[kinds.docs-only]
description = "A documentation-only change"
mode = "shadow"
allowedFolders = ["docs/", "notes"]
maxFiles = 5
maxLines = 80
noTestFiles = true
noDependencyManifest = true
inspectorGreen = true
requiredGreenChecks = ["inspector-tests"]
noQuestionsAsked = true
noCouldNotVerify = true
`;

function refusal(text: string): SkipRuleError {
  try {
    parseSkipRules(text);
  } catch (err) {
    assert.ok(err instanceof SkipRuleError, `expected a SkipRuleError, got ${String(err)}`);
    return err;
  }
  throw new assert.AssertionError({ message: `expected a refusal, but the file parsed:\n${text}` });
}

test("a valid rules file parses into one kind with every condition", () => {
  const rules = parseSkipRules(VALID);
  assert.equal(rules.version, 2);
  assert.equal(rules.path, SKIP_RULES_PATH);
  assert.equal(rules.kinds.length, 1);
  const [kind] = rules.kinds;
  assert.equal(kind.name, "docs-only");
  assert.equal(kind.description, "A documentation-only change");
  assert.equal(kind.mode, "shadow");
  // A trailing slash is the Client's own spelling and is dropped, so a
  // folder is stored once however he wrote it.
  assert.deepEqual(kind.allowedFolders, ["docs", "notes"]);
  assert.equal(kind.maxFiles, 5);
  assert.equal(kind.maxLines, 80);
  assert.equal(kind.noTestFiles, true);
  assert.equal(kind.noDependencyManifest, true);
  assert.equal(kind.inspectorGreen, true);
  assert.deepEqual(kind.requiredGreenChecks, ["inspector-tests"]);
  assert.equal(kind.noQuestionsAsked, true);
  assert.equal(kind.noCouldNotVerify, true);
});

test("rulesVersion carries the declared version AND the file's own bytes", () => {
  const first = parseSkipRules(VALID).rulesVersion;
  assert.match(first, /^2@[0-9a-f]{12}$/);
  // The same declared version with a different line still reads as a
  // different rules version - a file edited without bumping the number
  // must not be indistinguishable on the record.
  const edited = parseSkipRules(VALID.replace("maxFiles = 5", "maxFiles = 50")).rulesVersion;
  assert.match(edited, /^2@[0-9a-f]{12}$/);
  assert.notEqual(edited, first);
  // ...and the same bytes always read the same.
  assert.equal(parseSkipRules(VALID).rulesVersion, first);
});

test('mode = "live" is refused with its own code, naming CONTRACT rule 6', () => {
  const err = refusal(VALID.replace('mode = "shadow"', 'mode = "live"'));
  assert.equal(err.code, "live-not-allowed");
  assert.match(err.message, /CONTRACT rule 6/);
  assert.match(err.message, /only "shadow" is built/);
  // The message has to tell him what to do about it, not just say no.
  assert.match(err.message, /mode = "shadow"/);
});

test("any other mode, and a missing one, are plain malformed", () => {
  assert.equal(refusal(VALID.replace('mode = "shadow"', 'mode = "on"')).code, "malformed");
  assert.equal(refusal(VALID.replace('mode = "shadow"\n', "")).code, "malformed");
});

test("an unknown condition is refused, and the refusal names the whole vocabulary", () => {
  const err = refusal(`${VALID}maxComplexity = 3\n`);
  assert.equal(err.code, "malformed");
  assert.match(err.message, /maxComplexity/);
  assert.match(err.message, /allowedFolders/);
  assert.match(err.message, /noCouldNotVerify/);
});

test("a flag condition set to false is refused rather than read as 'do not check this'", () => {
  const err = refusal(VALID.replace("noTestFiles = true", "noTestFiles = false"));
  assert.equal(err.code, "malformed");
  assert.match(err.message, /must be `true` if it is there at all/);
});

test("a kind with no conditions at all is refused", () => {
  const err = refusal(`version = 1

[kinds.anything]
description = "Anything at all"
mode = "shadow"
`);
  assert.equal(err.code, "malformed");
  assert.match(err.message, /asks no conditions at all/);
});

test('allowedFolders = ["."] is refused: a condition that allows everything asks nothing', () => {
  const err = refusal(VALID.replace('allowedFolders = ["docs/", "notes"]', 'allowedFolders = ["."]'));
  assert.equal(err.code, "malformed");
  assert.match(err.message, /the whole repository/);
});

test("an empty list, an empty entry, and a non-list are all refused", () => {
  assert.match(refusal(VALID.replace('requiredGreenChecks = ["inspector-tests"]', "requiredGreenChecks = []")).message, /empty list/);
  assert.match(
    refusal(VALID.replace('requiredGreenChecks = ["inspector-tests"]', 'requiredGreenChecks = ["  "]')).message,
    /empty entry/
  );
  assert.match(
    refusal(VALID.replace('requiredGreenChecks = ["inspector-tests"]', 'requiredGreenChecks = "inspector-tests"')).message,
    /list of strings/
  );
});

test("a count condition must be a whole number of at least 1", () => {
  assert.match(refusal(VALID.replace("maxFiles = 5", "maxFiles = 0")).message, /at least 1/);
  assert.match(refusal(VALID.replace("maxFiles = 5", "maxFiles = 2.5")).message, /at least 1/);
  assert.match(refusal(VALID.replace("maxFiles = 5", 'maxFiles = "five"')).message, /at least 1/);
});

test("a missing or non-integer version is refused, since the record points at it", () => {
  assert.match(refusal(VALID.replace("version = 2\n", "")).message, /needs a "version" field/);
  assert.match(refusal(VALID.replace("version = 2", "version = 0")).message, /needs a "version" field/);
});

test("a missing description is refused: a report shows his sentence, never a paraphrase", () => {
  assert.match(refusal(VALID.replace('description = "A documentation-only change"\n', "")).message, /needs a "description"/);
});

test("a file with no kinds, an unknown top-level key, and unparseable TOML are each refused", () => {
  assert.match(refusal("version = 1\n").message, /at least one kind/);
  assert.match(refusal(`${VALID}\n[caps]\nperDayUsd = 1\n`).message, /unknown top-level table|unknown top-level key/);
  assert.match(refusal("version = ].[\n").message, /not valid TOML/);
});

/** A tiny committed repository, so the loader can be driven the way it
 * really runs: through `git show <revision>:<path>`, never off the
 * filesystem. */
function makeRepo(fileText: string | null): { dir: string; commit: string } {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-skiprules-"));
  writeFileSync(join(dir, "app.txt"), "hello\n");
  if (fileText !== null) {
    mkdirSync(dirname(join(dir, SKIP_RULES_PATH)), { recursive: true });
    writeFileSync(join(dir, SKIP_RULES_PATH), fileText);
  }
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  return { dir, commit };
}

test("loadSkipRules reads the file as committed at the given revision", () => {
  const { dir, commit } = makeRepo(VALID);
  const rules = loadSkipRules(dir, commit);
  assert.ok(rules !== null);
  assert.equal(rules.kinds[0].maxFiles, 5);
});

test("a working-tree edit to the rules file is invisible: the base commit is what is read", () => {
  const { dir, commit } = makeRepo(VALID);
  // Exactly what a worker with write access to its own checkout could do:
  // rewrite the rules so everything passes. The loader must not see it.
  writeFileSync(
    join(dir, SKIP_RULES_PATH),
    `version = 99

[kinds.everything]
description = "Anything the worker likes"
mode = "shadow"
maxFiles = 10000
`
  );
  const rules = loadSkipRules(dir, commit);
  assert.ok(rules !== null);
  assert.equal(rules.version, 2, "the loader read the worker's own edit instead of the base commit");
  assert.deepEqual(
    rules.kinds.map((kind) => kind.name),
    ["docs-only"]
  );
});

test("a project with no rules file loads as null, not as an empty rule set", () => {
  const { dir, commit } = makeRepo(null);
  assert.equal(loadSkipRules(dir, commit), null);
});

test("an unreadable repository loads as null rather than throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-skiprules-nogit-"));
  assert.equal(loadSkipRules(dir, "deadbeef"), null);
});

test("a rules file that exists at the revision and cannot be used still throws", () => {
  const { dir, commit } = makeRepo(VALID.replace('mode = "shadow"', 'mode = "live"'));
  assert.throws(() => loadSkipRules(dir, commit), (err: unknown) => err instanceof SkipRuleError && err.code === "live-not-allowed");
});
