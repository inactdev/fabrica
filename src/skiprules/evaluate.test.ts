import { test } from "node:test";
import assert from "node:assert/strict";
import { isDependencyManifest, isTestFile, isUnderFolder } from "./conditions.ts";
import { closingKind, evaluateKind, evaluateRules } from "./evaluate.ts";
import { parseSkipRules } from "./load.ts";
import type { ChangeFacts, ChangeKind, KindEvaluation } from "./types.ts";

/** A delivery that satisfies every condition the kind below asks. */
function safeFacts(over: Partial<ChangeFacts> = {}): ChangeFacts {
  return {
    files: ["docs/intro.md", "notes/a.md"],
    outcome: "done",
    counts: { files: 2, insertions: 10, deletions: 2 },
    inspectorVerdict: "green",
    concludedChecks: [
      { name: "inspector-tests", red: false },
      { name: "block-protected-path-change", red: false },
    ],
    questionsAsked: false,
    couldNotVerify: "",
    ...over,
  };
}

const KIND: ChangeKind = {
  name: "docs-only",
  description: "A documentation-only change",
  mode: "shadow",
  allowedFolders: ["docs", "notes"],
  maxFiles: 5,
  maxLines: 80,
  noTestFiles: true,
  noDependencyManifest: true,
  inspectorGreen: true,
  requiredGreenChecks: ["inspector-tests"],
  noQuestionsAsked: true,
  noCouldNotVerify: true,
};

function answerFor(result: KindEvaluation, condition: string): { answer: string; detail: string } {
  const found = result.answers.find((a) => a.condition === condition);
  assert.ok(found, `no answer for "${condition}" (saw: ${result.answers.map((a) => a.condition).join(", ")})`);
  return found;
}

test("a change satisfying every condition is safe, and every answer is recorded", () => {
  const result = evaluateKind(KIND, safeFacts());
  assert.equal(result.safe, true);
  // Every condition the kind asks, plus the code floor in front of them.
  assert.deepEqual(
    result.answers.map((a) => a.condition),
    [
      "deliveryDone",
      "allowedFolders",
      "noTestFiles",
      "noDependencyManifest",
      "maxFiles",
      "maxLines",
      "inspectorGreen",
      "requiredGreenChecks",
      "noQuestionsAsked",
      "noCouldNotVerify",
    ]
  );
  assert.ok(
    result.answers.every((a) => a.answer === "safe"),
    "an answer was not safe"
  );
  // Every answer carries its question and what the facts actually were,
  // so a report never has to recompute either.
  assert.ok(result.answers.every((a) => a.question.length > 0 && a.detail.length > 0));
});

test("a touched test file makes the kind unsafe, and names the file", () => {
  const result = evaluateKind(KIND, safeFacts({ files: ["docs/intro.md", "src/foo.test.ts"] }));
  assert.equal(result.safe, false);
  const answer = answerFor(result, "noTestFiles");
  assert.equal(answer.answer, "unsafe");
  assert.match(answer.detail, /src\/foo\.test\.ts/);
});

test("every condition is answered even after one goes unsafe - a near miss has to be readable", () => {
  const result = evaluateKind(KIND, safeFacts({ files: ["src/foo.test.ts"] }));
  assert.equal(result.answers.length, 10);
  // The folder condition is answered too, independently of the test one.
  assert.equal(answerFor(result, "allowedFolders").answer, "unsafe");
  assert.equal(answerFor(result, "noQuestionsAsked").answer, "safe");
});

test("the code floor refuses a delivery that is not done, whatever the conditions say", () => {
  for (const outcome of ["failure-report", "inspection-red", "not-verified", "nothing-changed", "cap-stopped", "paused-by-meter"]) {
    const result = evaluateKind(KIND, safeFacts({ outcome }));
    assert.equal(result.safe, false, `outcome "${outcome}" was read as safe`);
    const floor = answerFor(result, "deliveryDone");
    assert.equal(floor.answer, "unsafe");
    assert.match(floor.detail, new RegExp(outcome));
  }
});

test("the floor is marked as Fabrica's own question, not one from the rules file", () => {
  const result = evaluateKind(KIND, safeFacts());
  assert.equal(result.answers.find((a) => a.condition === "deliveryDone")?.fixed, true);
  assert.ok(
    result.answers.filter((a) => a.condition !== "deliveryDone").every((a) => a.fixed === undefined),
    "a condition from the rules file was marked fixed"
  );
});

test("a kind that asks nothing but the floor still cannot pass a delivery that is not done", () => {
  const bare: ChangeKind = { name: "bare", description: "Only the floor", mode: "shadow", noQuestionsAsked: true };
  assert.equal(evaluateKind(bare, safeFacts()).safe, true);
  assert.equal(evaluateKind(bare, safeFacts({ outcome: "inspection-red" })).safe, false);
});

test("a file outside the allowed folders is unsafe, and the file is named", () => {
  const result = evaluateKind(KIND, safeFacts({ files: ["docs/a.md", "src/app.ts"] }));
  assert.equal(answerFor(result, "allowedFolders").answer, "unsafe");
  assert.match(answerFor(result, "allowedFolders").detail, /src\/app\.ts/);
});

test("an empty file list answers every file question unknown, never 'all zero files were fine'", () => {
  const result = evaluateKind(KIND, safeFacts({ files: [] }));
  assert.equal(result.safe, false);
  for (const condition of ["allowedFolders", "noTestFiles", "noDependencyManifest"]) {
    assert.equal(answerFor(result, condition).answer, "unknown", condition);
  }
});

test("maxLines counts insertions plus deletions, so a large deletion cannot pass a small limit", () => {
  const under = evaluateKind(KIND, safeFacts({ counts: { files: 1, insertions: 40, deletions: 40 } }));
  assert.equal(answerFor(under, "maxLines").answer, "safe");
  const over = evaluateKind(KIND, safeFacts({ counts: { files: 1, insertions: 1, deletions: 100 } }));
  assert.equal(answerFor(over, "maxLines").answer, "unsafe");
  assert.match(answerFor(over, "maxLines").detail, /101 line\(s\) changed \(\+1\/-100\), limit 80/);
});

test("counts that could not be read answer unknown, not zero", () => {
  const result = evaluateKind(KIND, safeFacts({ counts: null }));
  assert.equal(result.safe, false);
  assert.equal(answerFor(result, "maxFiles").answer, "unknown");
  assert.equal(answerFor(result, "maxLines").answer, "unknown");
});

test("a dependency manifest anywhere in the tree is unsafe, lock file alone included", () => {
  for (const file of ["package.json", "package-lock.json", "packages/ui/package.json", "go.sum", "Cargo.lock"]) {
    const result = evaluateKind(KIND, safeFacts({ files: ["docs/a.md", file] }));
    assert.equal(answerFor(result, "noDependencyManifest").answer, "unsafe", file);
  }
});

test("Inspector: red and refused are unsafe, and never having been called is unknown", () => {
  assert.equal(answerFor(evaluateKind(KIND, safeFacts({ inspectorVerdict: "red" })), "inspectorGreen").answer, "unsafe");
  assert.equal(answerFor(evaluateKind(KIND, safeFacts({ inspectorVerdict: "refused" })), "inspectorGreen").answer, "unsafe");
  const never = answerFor(evaluateKind(KIND, safeFacts({ inspectorVerdict: null })), "inspectorGreen");
  assert.equal(never.answer, "unknown");
  assert.match(never.detail, /no verdict/);
});

test("a required check is never green by silence - a check that never concluded is unknown", () => {
  const missing = answerFor(evaluateKind(KIND, safeFacts({ concludedChecks: [] })), "requiredGreenChecks");
  assert.equal(missing.answer, "unknown");
  assert.match(missing.detail, /never concluded: inspector-tests/);

  const red = answerFor(
    evaluateKind(KIND, safeFacts({ concludedChecks: [{ name: "inspector-tests", red: true }] })),
    "requiredGreenChecks"
  );
  assert.equal(red.answer, "unsafe");
  assert.match(red.detail, /red: inspector-tests/);
});

test("a task that stopped to ask the Client is unsafe", () => {
  assert.equal(answerFor(evaluateKind(KIND, safeFacts({ questionsAsked: true })), "noQuestionsAsked").answer, "unsafe");
});

test("a write-up reporting something it could not verify is unsafe, and the reason is carried", () => {
  const answer = answerFor(
    evaluateKind(KIND, safeFacts({ couldNotVerify: "could not reach the staging API\nsecond line" })),
    "noCouldNotVerify"
  );
  assert.equal(answer.answer, "unsafe");
  assert.match(answer.detail, /could not reach the staging API/);
  assert.doesNotMatch(answer.detail, /second line/, "only the first line belongs on a one-line detail");
});

test("evaluateRules answers every kind, and closingKind picks the first safe one in the file's own order", () => {
  const rules = parseSkipRules(`version = 1

[kinds.strict]
description = "Strict"
mode = "shadow"
maxFiles = 1

[kinds.loose]
description = "Loose"
mode = "shadow"
maxFiles = 10

[kinds.looser]
description = "Looser"
mode = "shadow"
maxFiles = 100
`);
  const kinds = evaluateRules(rules, safeFacts());
  assert.deepEqual(
    kinds.map((k) => [k.kind, k.safe]),
    [
      ["strict", false],
      ["loose", true],
      ["looser", true],
    ]
  );
  assert.equal(closingKind(kinds), "loose");
  assert.equal(closingKind(evaluateRules(rules, safeFacts({ counts: { files: 500, insertions: 1, deletions: 0 } }))), null);
});

test("isTestFile recognizes the conventions it claims to, and leaves ordinary files alone", () => {
  for (const path of [
    "src/foo.test.ts",
    "src/foo_test.go",
    "app/foo.spec.js",
    "tests/helper.py",
    "pkg/__tests__/a.tsx",
    "cmd/inspector/testdata/x.json",
    "spec/models/user_spec.rb",
  ]) {
    assert.equal(isTestFile(path), true, path);
  }
  for (const path of ["src/foo.ts", "docs/testing.md", "src/latest.ts", "src/contest.ts", "src/protester/a.ts"]) {
    assert.equal(isTestFile(path), false, path);
  }
});

test("isDependencyManifest matches manifests by basename and nothing else", () => {
  assert.equal(isDependencyManifest("package.json"), true);
  assert.equal(isDependencyManifest("a/b/pnpm-lock.yaml"), true);
  assert.equal(isDependencyManifest("tsconfig.json"), false);
  assert.equal(isDependencyManifest("docs/package.json.md"), false);
});

test("isUnderFolder reads a folder as a directory prefix, never a string prefix", () => {
  assert.equal(isUnderFolder("src/a.ts", "src"), true);
  assert.equal(isUnderFolder("src", "src"), true);
  assert.equal(isUnderFolder("srcery/a.ts", "src"), false);
  assert.equal(isUnderFolder("a/src/b.ts", "src"), false);
});
