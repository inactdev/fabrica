// Answering the questions. Pure: facts in, answers out, no record, no
// git, no network, and - the property issue #204 asks for a test of -
// no model anywhere between "checks finished" and the decision.
//
// Three answers, not two. "unknown" exists because a question nothing
// could answer must not be read as either "safe" or "unsafe": git that
// could not be read, a required check that never concluded, an
// Inspector that was never called. Only "safe" is safe; `unknown`
// counts with `unsafe` for every purpose except the wording a reader
// sees, where the difference is the whole point.

import { isDependencyManifest, isTestFile, isUnderFolder } from "./conditions.ts";
import { CONDITION_KEYS } from "./conditions.ts";
import type { ChangeFacts, ChangeKind, ConditionAnswer, KindEvaluation, SkipRules } from "./types.ts";

/** Every kind in the file, each with every one of its own conditions
 * answered - never short-circuited on the first unsafe one. A report is
 * only useful if it says which conditions a near-miss missed on, and the
 * noticer (a later issue) reads exactly that. */
export function evaluateRules(rules: SkipRules, facts: ChangeFacts): KindEvaluation[] {
  return rules.kinds.map((kind) => evaluateKind(kind, facts));
}

export function evaluateKind(kind: ChangeKind, facts: ChangeFacts): KindEvaluation {
  const answers: ConditionAnswer[] = [deliveryDoneAnswer(facts)];
  for (const key of CONDITION_KEYS) {
    if (kind[key] === undefined) continue;
    answers.push(answerCondition(key, kind, facts));
  }
  return {
    kind: kind.name,
    description: kind.description,
    mode: kind.mode,
    safe: answers.every((answer) => answer.answer === "safe"),
    answers,
  };
}

/**
 * The one question that is not from the rules file: a code-fixed floor in
 * front of every kind's own conditions. No line a Client could write may
 * close a task whose delivery is not "done" - a failure report, a red
 * inspection, a cap or meter stop, a rebase conflict, a round that
 * changed nothing. Marked `fixed` on the record so a reader can tell
 * Fabrica's own question from his.
 */
function deliveryDoneAnswer(facts: ChangeFacts): ConditionAnswer {
  const question = "Is the delivery done?";
  if (facts.outcome === null) {
    return { condition: "deliveryDone", question, answer: "unknown", detail: "no delivery on the record", fixed: true };
  }
  return {
    condition: "deliveryDone",
    question,
    answer: facts.outcome === "done" ? "safe" : "unsafe",
    detail: `delivery outcome: ${facts.outcome}`,
    fixed: true,
  };
}

function answerCondition(key: (typeof CONDITION_KEYS)[number], kind: ChangeKind, facts: ChangeFacts): ConditionAnswer {
  switch (key) {
    case "allowedFolders": {
      const folders = kind.allowedFolders!;
      const question = `Is every changed file under ${folders.join(", ")}?`;
      if (facts.files.length === 0) {
        // No file list means nothing could be checked against the
        // folders - not "every one of zero files is allowed", which is
        // technically true and exactly the kind of true that closes a
        // task nobody looked at.
        return { condition: key, question, answer: "unknown", detail: "the delivery names no files" };
      }
      const outside = facts.files.filter((file) => !folders.some((folder) => isUnderFolder(file, folder)));
      return {
        condition: key,
        question,
        answer: outside.length === 0 ? "safe" : "unsafe",
        detail: outside.length === 0 ? `all ${facts.files.length} file(s) inside` : `outside: ${outside.join(", ")}`,
      };
    }

    case "noTestFiles": {
      const question = "Were no test files touched?";
      if (facts.files.length === 0) {
        return { condition: key, question, answer: "unknown", detail: "the delivery names no files" };
      }
      const tests = facts.files.filter(isTestFile);
      return {
        condition: key,
        question,
        answer: tests.length === 0 ? "safe" : "unsafe",
        detail: tests.length === 0 ? "no test file among the changed files" : `test file(s) touched: ${tests.join(", ")}`,
      };
    }

    case "noDependencyManifest": {
      const question = "Was no dependency manifest changed?";
      if (facts.files.length === 0) {
        return { condition: key, question, answer: "unknown", detail: "the delivery names no files" };
      }
      const manifests = facts.files.filter(isDependencyManifest);
      return {
        condition: key,
        question,
        answer: manifests.length === 0 ? "safe" : "unsafe",
        detail: manifests.length === 0 ? "no manifest among the changed files" : `manifest(s) changed: ${manifests.join(", ")}`,
      };
    }

    case "maxFiles": {
      const limit = kind.maxFiles!;
      const question = `Were at most ${limit} file(s) changed?`;
      if (facts.counts === null) {
        return { condition: key, question, answer: "unknown", detail: "the change's counts could not be read" };
      }
      return {
        condition: key,
        question,
        answer: facts.counts.files <= limit ? "safe" : "unsafe",
        detail: `${facts.counts.files} file(s) changed, limit ${limit}`,
      };
    }

    case "maxLines": {
      const limit = kind.maxLines!;
      const question = `Were at most ${limit} line(s) changed?`;
      if (facts.counts === null) {
        return { condition: key, question, answer: "unknown", detail: "the change's counts could not be read" };
      }
      // Insertions plus deletions: a change that rewrites 40 lines moved
      // 80, and reading only insertions would let a large deletion pass a
      // small limit.
      const moved = facts.counts.insertions + facts.counts.deletions;
      return {
        condition: key,
        question,
        answer: moved <= limit ? "safe" : "unsafe",
        detail: `${moved} line(s) changed (+${facts.counts.insertions}/-${facts.counts.deletions}), limit ${limit}`,
      };
    }

    case "inspectorGreen": {
      const question = "Did Inspector reach green?";
      if (facts.inspectorVerdict === null) {
        return { condition: key, question, answer: "unknown", detail: "Inspector reached no verdict on this round" };
      }
      return {
        condition: key,
        question,
        answer: facts.inspectorVerdict === "green" ? "safe" : "unsafe",
        detail: `Inspector: ${facts.inspectorVerdict}`,
      };
    }

    case "requiredGreenChecks": {
      const required = kind.requiredGreenChecks!;
      const question = `Did every one of ${required.join(", ")} conclude green?`;
      const missing = required.filter((name) => !facts.concludedChecks.some((check) => check.name === name));
      const red = required.filter((name) => facts.concludedChecks.some((check) => check.name === name && check.red));
      if (red.length > 0) {
        return { condition: key, question, answer: "unsafe", detail: `red: ${red.join(", ")}` };
      }
      if (missing.length > 0) {
        // Never green by silence: a check that did not conclude within
        // the round's bounded wait, or never ran at all, is unknown.
        return { condition: key, question, answer: "unknown", detail: `never concluded: ${missing.join(", ")}` };
      }
      return { condition: key, question, answer: "safe", detail: `all ${required.length} green` };
    }

    case "noQuestionsAsked": {
      const question = "Did the task run without stopping to ask the Client?";
      return {
        condition: key,
        question,
        answer: facts.questionsAsked ? "unsafe" : "safe",
        detail: facts.questionsAsked ? "the task stopped for clarification" : "no clarifying questions were asked",
      };
    }

    case "noCouldNotVerify": {
      const question = "Did the worker report nothing it could not verify?";
      return {
        condition: key,
        question,
        answer: facts.couldNotVerify.length === 0 ? "safe" : "unsafe",
        detail:
          facts.couldNotVerify.length === 0
            ? "the write-up reported nothing unverified"
            : `could not verify: ${firstLine(facts.couldNotVerify)}`,
      };
    }
  }
}

function firstLine(text: string): string {
  const [line] = text.split("\n");
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/** The first kind that would have closed this task, or null when none
 * would. "First" is the order the rules file declares its kinds in, so
 * the answer is the Client's own ordering rather than whichever one a
 * map happened to yield. */
export function closingKind(kinds: KindEvaluation[]): string | null {
  return kinds.find((kind) => kind.safe)?.kind ?? null;
}
