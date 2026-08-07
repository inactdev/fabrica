// Issue #53 — a PR touching the ratified contract must never be able to
// merge itself. Unlike CONTRACT rule 9 (self-grading), touching
// `contract/` or `CONTRACT.md` is not itself a violation — the Client's
// ruling (2026-08-05) says a contract change is "completely fine" to
// propose. What's required is that it never slides through on green
// alone: only the Client merges it.
//
// Enforcement lives entirely in .github/workflows/rule9-gate.yml, in the
// same job as rule 9's own check but as a second, separately-worded
// matching pass — see that file's own header comment for the full
// reasoning. There is no Fabrica code involved at all (no detection
// module to unit-test), so the only way to prove the protection exists
// is to read the workflow's own source and check its pattern list — the
// same "the file itself is the answer key" spirit as rule7's watchdog
// test, applied to a CI file instead of a contract/*.test.ts file.
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

test("rule9-gate.yml protects contract/ and CONTRACT.md, distinctly from rule 9's own protected paths", () => {
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

  const allErrors = [...source.matchAll(/::error::([^\n]*)/g)].map((match) => match[1]);
  assert.equal(
    allErrors.filter((message) => message === contractErrors[0]).length,
    1,
    "rule 9's own check must not reuse the contract-path failure message verbatim"
  );
});
