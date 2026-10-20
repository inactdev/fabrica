// Issue #53 — a PR touching the ratified contract must never be able to
// merge itself. Unlike CONTRACT rule 9 (self-grading), touching
// `contract/` or `CONTRACT.md` is not itself a violation — the Client's
// ruling (2026-08-05) says a contract change is "completely fine" to
// propose. What's required is that it never slides through on green
// alone: only the Client merges it.
//
// Enforcement lives entirely in .github/workflows/rule9-gate.yml, in the
// same job as rule 9's own check but as separately-worded matching passes.
// The contract pass stays before the temporary test pass so a contract test
// is reported as a contract change, not merely as a test change. There is no
// Fabrica code involved at all (no detection module to unit-test), so the
// only way to prove the protection exists
// is to read the workflow's own source and check its pattern list — the
// same "the file itself is the answer key" spirit as rule7's watchdog
// test, applied to a CI file instead of a contract/*.test.ts file.
//
// Issue #96's test pass additionally honors Inspector's own judgment: a
// changed `*.test.ts` is cleared when the pull request's head commit
// carries an `inspector-tests` commit status of `success`, and stays red
// for every other state, for no such status at all, and — fail closed —
// for a status that cannot be read. The assertions below pin all four
// outcomes, pin that the clearance touches neither rule 9's own pass nor
// the contract pass, and pin that the status is consulted only once a test
// file has really changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(here, "..", ".github", "workflows", "rule9-gate.yml");

// Mirrors bash's `[[ "$candidate" == $pattern ]]` glob matching as used
// by the workflow (no extglob): `*` matches any run of characters,
// everything else is literal.
function bashGlobToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

// Reads a YAML block scalar (`KEY: |`) as its list of lines. The block
// ends at the first line indented no deeper than the key itself — a
// blank-line terminator alone would swallow the `run:` step that follows
// the env block, and any `*` in that swallowed text would turn every
// pattern assertion below into a match-anything no-op.
function readBlockScalarLines(source: string, key: string): string[] | null {
  const keyLine = source.match(new RegExp(`^([ \\t]*)${key}:[ \\t]*\\|[ \\t]*\\n`, "m"));
  if (!keyLine || keyLine.index === undefined) return null;

  const keyIndent = keyLine[1].length;
  const rest = source.slice(keyLine.index + keyLine[0].length).split("\n");
  const lines: string[] = [];

  for (const line of rest) {
    if (line.trim() === "") break;
    if (line.length - line.trimStart().length <= keyIndent) break;
    lines.push(line.trim());
  }

  return lines;
}

test("rule9-gate.yml protects contract paths and gates non-contract test changes on Inspector", () => {
  const source = readFileSync(workflowPath, "utf8");

  // The job name is load-bearing (wired into required-status-check
  // settings) and must stay exactly this, whatever else changes in the
  // file.
  assert.match(source, /block-protected-path-change/, "job name must not change");

  // pull_request_target, not pull_request — the workflow's own header
  // comment explains why (definition read from the base branch, immune
  // to a PR rewriting the gate that judges it).
  assert.match(source, /pull_request_target:/, "must trigger on pull_request_target");

  // No checkout of PR content, ever — this job only compares filenames.
  // (The word appears in the file's own safety-critical prose warning
  // against adding one; only an actual `uses:` step would be real.)
  assert.doesNotMatch(source, /uses:\s*actions\/checkout/, "must never check out PR content");

  // Everything below reads the rule 9 job in isolation: the file carries a
  // second job (inspector-stamp) that legitimately reads a commit status
  // too, so an assertion anchored to the whole file could be satisfied by
  // that job and prove nothing about this one.
  const jobStart = source.indexOf("  block-protected-path-change:");
  const jobEnd = source.indexOf("\n  inspector-stamp:");
  assert.ok(jobStart >= 0, "no block-protected-path-change job found in rule9-gate.yml");
  assert.ok(jobEnd > jobStart, "no inspector-stamp job found after it to bound the rule 9 job");
  const ruleNineJob = source.slice(jobStart, jobEnd);

  // The test pass reads a commit status, so the job needs that scope -
  // and only read scopes, never the default token's.
  assert.match(ruleNineJob, /statuses:\s*read/, "the job must request statuses: read");
  assert.doesNotMatch(
    ruleNineJob,
    /:\s*write\b/,
    "the job must request no write scope - it only ever reads"
  );
  assert.match(
    ruleNineJob,
    /pull-requests:\s*read/,
    "the job must still request pull-requests: read for the changed-file listing"
  );

  // Rule 9's own pass must stay exactly what it was: one unconditional
  // failure the moment a protected path appears, with nothing about
  // Inspector in it. Nothing clears a rule 9 violation.
  const ruleNineLoop = source.match(
    /while IFS= read -r pattern; do\n(?:(?!while IFS= read -r pattern; do)[\s\S])*?done <<< "\$PROTECTED_PATHS"/
  );
  assert.ok(ruleNineLoop, "no loop over PROTECTED_PATHS found in rule9-gate.yml");
  const ruleNineErrors = [...ruleNineLoop[0].matchAll(/::error::([^\n]*)/g)].map(
    (match) => match[1]
  );
  assert.equal(
    ruleNineErrors.length,
    1,
    "the PROTECTED_PATHS loop must emit exactly one failure message"
  );
  assert.match(
    ruleNineErrors[0],
    /CONTRACT rule 9/,
    "rule 9's own failure message must still name rule 9"
  );
  assert.doesNotMatch(
    ruleNineLoop[0],
    /inspector/i,
    "rule 9's own pass must not consult Inspector - nothing clears a rule 9 violation"
  );

  const rulePatterns = readBlockScalarLines(source, "PROTECTED_PATHS");
  assert.ok(rulePatterns, "no PROTECTED_PATHS block found in rule9-gate.yml");
  const matchesRulePattern = (candidate: string) =>
    rulePatterns.some((pattern) => bashGlobToRegExp(pattern).test(candidate));
  assert.ok(matchesRulePattern("check.sh"), "check.sh must still be protected");
  assert.ok(
    matchesRulePattern(".github/workflows/rule9-gate.yml"),
    "the gate must still protect its own definition"
  );

  const patterns = readBlockScalarLines(source, "CONTRACT_PROTECTED_PATHS");
  assert.ok(patterns, "no CONTRACT_PROTECTED_PATHS block found in rule9-gate.yml");
  assert.ok(patterns.length > 0, "CONTRACT_PROTECTED_PATHS must list at least one pattern");

  const matchesSomePattern = (candidate: string) =>
    patterns.some((pattern) => bashGlobToRegExp(pattern).test(candidate));

  assert.ok(matchesSomePattern("CONTRACT.md"), "CONTRACT.md must be listed as protected");
  assert.ok(
    matchesSomePattern("contract/surface.ts"),
    "a file under contract/ must be listed as protected"
  );
  assert.ok(
    matchesSomePattern("contract/rule9-gate.contract-paths.test.ts"),
    "this very test file, being under contract/, must itself match the protected pattern"
  );

  // A pattern list that matched everything would satisfy the three
  // assertions above without protecting anything.
  assert.ok(
    !matchesSomePattern("src/foreman/do.ts"),
    "the contract patterns must not match ordinary src/ files"
  );

  // The contract-path failure message must be distinguishable from rule
  // 9's self-grading message — an author needs to tell "you broke a
  // rule" apart from "you changed a rule, which needs the Client". Read
  // it out of the loop that actually consumes CONTRACT_PROTECTED_PATHS:
  // rule 9's own message sits between that variable's declaration and
  // this loop, so anything anchored to the declaration alone would pass
  // on rule 9's wording even with the contract message deleted.
  const contractLoop = source.match(
    /while IFS= read -r pattern; do\n(?:(?!while IFS= read -r pattern; do)[\s\S])*?done <<< "\$CONTRACT_PROTECTED_PATHS"/
  );
  assert.ok(contractLoop, "no loop over CONTRACT_PROTECTED_PATHS found in rule9-gate.yml");

  const contractErrors = [...contractLoop[0].matchAll(/::error::([^\n]*)/g)].map(
    (match) => match[1]
  );
  assert.equal(
    contractErrors.length,
    1,
    "the CONTRACT_PROTECTED_PATHS loop must emit exactly one failure message"
  );
  assert.match(
    contractErrors[0],
    /ratified contract/i,
    "the contract-path failure message must name the contract, not reuse rule 9's wording"
  );
  assert.match(
    contractErrors[0],
    /only the client/i,
    "the contract-path failure message must say only the Client may merge it"
  );

  assert.doesNotMatch(
    contractLoop[0],
    /inspector/i,
    "the contract pass must not consult Inspector - a contract change is the Client's to merge"
  );

  // Issue #96's pass: a changed test file is cleared only by Inspector's
  // examiner, and otherwise still needs the Client. This third pass must
  // stay after the contract pass: contract tests match both patterns, but
  // the contract message is the meaningful one and must win.
  const testPatterns = readBlockScalarLines(source, "TEST_PROTECTED_PATHS");
  assert.ok(testPatterns, "no TEST_PROTECTED_PATHS block found in rule9-gate.yml");
  assert.ok(
    testPatterns.length > 0,
    "TEST_PROTECTED_PATHS must list at least one pattern"
  );

  const matchesTestPattern = (candidate: string) =>
    testPatterns.some((pattern) => bashGlobToRegExp(pattern).test(candidate));

  assert.ok(
    matchesTestPattern("src/foreman/gate-changes.test.ts"),
    "a nested src test file must be protected"
  );
  assert.ok(
    !matchesTestPattern("src/foreman/gate-changes.ts"),
    "the near-miss non-test source file gate-changes.ts must not be protected as a test"
  );

  const testLoop = source.match(
    /while IFS= read -r pattern; do\n(?:(?!while IFS= read -r pattern; do)[\s\S])*?done <<< "\$TEST_PROTECTED_PATHS"/
  );
  assert.ok(testLoop, "no loop over TEST_PROTECTED_PATHS found in rule9-gate.yml");

  // The matching loop itself only names a changed test file now; the
  // verdict comes from Inspector's status afterwards. So the pass's
  // messages are read from the loop plus everything after it in this job,
  // not from the loop alone.
  const testPass = ruleNineJob.slice(ruleNineJob.indexOf(testLoop[0]));
  assert.doesNotMatch(
    testLoop[0],
    /::error::/,
    "the matching loop must only name a changed test file, not decide its fate"
  );

  const testErrors = [...testPass.matchAll(/::error::([^\n]*)/g)].map((match) => match[1]);
  assert.equal(
    testErrors.length,
    3,
    "the test pass must fail distinctly on a non-success status, on no status at all, and on a status it cannot read"
  );
  assert.equal(
    new Set(testErrors).size,
    3,
    "the three test-pass failure messages must each be worded for their own cause"
  );
  for (const message of testErrors) {
    assert.match(
      message,
      /only the client|client must review|the client review/i,
      `every test-pass failure message must point at the Client: ${message}`
    );
    assert.match(
      message,
      /fabrica\/issues\/96/,
      `every test-pass failure message must name the issue tracking this stopgap: ${message}`
    );
    assert.notEqual(
      message,
      contractErrors[0],
      "no test-pass failure message may reuse the contract-path wording"
    );
    assert.notEqual(
      message,
      ruleNineErrors[0],
      "no test-pass failure message may reuse rule 9's own wording"
    );
  }

  // Inspector's judgment is read from the pull request head's own commit
  // status, under exactly the context name Inspector posts.
  assert.match(
    testPass,
    /context\s*==\s*"inspector-tests"/,
    'the test pass must key on the commit status literally named "inspector-tests"'
  );
  assert.match(
    testPass,
    /repos\/\$REPO\/commits\/\$HEAD_SHA\/status/,
    "the test pass must read the status of the pull request's own head commit"
  );
  assert.match(
    source,
    /HEAD_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/,
    "HEAD_SHA must come from the pull request's head sha, never a checked-out ref"
  );

  // Only success clears. Every other state - including a pending run -
  // falls through to a failure above.
  assert.match(
    testPass,
    /\[\s*"\$tests_state"\s*=\s*"success"\s*\]/,
    "only an inspector-tests state of success may clear a test change"
  );

  // Fail closed: the status read's own failure is branched on explicitly,
  // so an unreadable status can never be mistaken for a clearance.
  assert.match(
    testPass,
    /if\s*!\s*tests_state=\$\(gh api/,
    "a failed status read must be handled explicitly, not left to pass as a clearance"
  );

  // ...and the read happens only once a test file has actually changed, so
  // a pull request touching no test is never failed by a status it has no
  // use for.
  const guardIndex = testPass.indexOf('if [ -n "$touched_test" ]; then');
  const readIndex = testPass.indexOf("gh api");
  assert.ok(guardIndex >= 0, "the status read must be guarded on a test file having changed");
  assert.ok(
    readIndex > guardIndex,
    "the status read must sit inside that guard, not ahead of it"
  );

  const contractLoopStart = ruleNineJob.indexOf(contractLoop[0]);
  const testLoopStart = ruleNineJob.indexOf(testLoop[0]);
  assert.ok(testLoopStart > contractLoopStart, "the test pass must follow the contract pass");

  const allErrors = [...source.matchAll(/::error::([^\n]*)/g)].map((match) => match[1]);
  assert.equal(
    allErrors.filter((message) => message === contractErrors[0]).length,
    1,
    "rule 9's own check must not reuse the contract-path failure message verbatim"
  );
});
