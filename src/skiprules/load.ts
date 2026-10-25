// Reads a project's committed skip-rules file.
//
// Read through git, at the task's own base commit, never off the
// filesystem of the worktree the round just ran in. That is not a
// detail: a worker has write access to its throwaway checkout, so the
// working-tree copy of this file is a file the thing being judged could
// have written itself. The base commit is the one revision nothing in
// the round can have changed.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as TOML from "smol-toml";
import { SkipRuleError } from "./errors.ts";
import { CONDITION_KEYS } from "./conditions.ts";
import type { ChangeKind, SkipRules } from "./types.ts";

/** Repository-relative, committed, and a protected path on the project's
 * own side (issue #204's amendment: "the file and the graduation track
 * are protected paths") - which is the project's gate to enforce, not
 * Fabrica's. */
export const SKIP_RULES_PATH = ".fabrica/skip-rules.toml";

/**
 * The rules file as it stands at `revision` in `project`, or null when
 * there is none there - which is the ordinary case and means this
 * project has not opted in to skip rules at all. Null is the difference
 * between "no rules" and "rules that said nothing": a project with no
 * file gets no `would-close-by-rule` event, ever.
 *
 * Throws `SkipRuleError` for a file that exists and cannot be used.
 */
export function loadSkipRules(project: string, revision: string): SkipRules | null {
  const text = readAtRevision(project, revision);
  if (text === null) return null;
  return parseSkipRules(text);
}

/** `git show <revision>:<path>`, or null when that path is not in that
 * commit. Deliberately cannot tell "not there" from "git itself is
 * broken": both mean this evaluation has no rules to apply, and the
 * caller records that it had none. An unreadable git is never a reason
 * to lose a delivery. */
function readAtRevision(project: string, revision: string): string | null {
  try {
    return execFileSync("git", ["show", `${revision}:${SKIP_RULES_PATH}`], {
      cwd: project,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

export function parseSkipRules(text: string): SkipRules {
  let parsed: unknown;
  try {
    parsed = TOML.parse(text);
  } catch (err) {
    const reason = ((err as Error).message ?? String(err)).split("\n")[0];
    throw new SkipRuleError("malformed", `${SKIP_RULES_PATH} is not valid TOML: ${reason}`);
  }
  if (!isTable(parsed)) {
    throw new SkipRuleError("malformed", `${SKIP_RULES_PATH} must contain a TOML table at its root.`);
  }

  const { version, kinds: rawKinds, ...rest } = parsed;
  const extra = Object.keys(rest);
  if (extra.length > 0) {
    throw new SkipRuleError(
      "malformed",
      `${SKIP_RULES_PATH} has unknown top-level key(s): ${extra.join(", ")}. ` +
        `Only "version" and the [kinds.<name>] tables are recognized.`
    );
  }

  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new SkipRuleError(
      "malformed",
      `${SKIP_RULES_PATH} needs a "version" field: a whole number of at least 1, bumped whenever you change a line. ` +
        `Got ${String(version)}.`
    );
  }

  if (!isTable(rawKinds)) {
    throw new SkipRuleError(
      "malformed",
      `${SKIP_RULES_PATH} must declare at least one kind of change, as [kinds.<name>].`
    );
  }
  const names = Object.keys(rawKinds);
  if (names.length === 0) {
    throw new SkipRuleError(
      "malformed",
      `${SKIP_RULES_PATH} declares no kinds. A file with none asks no questions about anything.`
    );
  }

  const kinds = names.map((name) => parseKind(name, rawKinds[name]));
  return {
    version,
    rulesVersion: `${version}@${fileHash(text)}`,
    path: SKIP_RULES_PATH,
    kinds,
  };
}

function parseKind(name: string, value: unknown): ChangeKind {
  const label = `${SKIP_RULES_PATH}: [kinds.${name}]`;
  if (!isTable(value)) {
    throw new SkipRuleError("malformed", `${label} must be a table with a "description", a "mode" and at least one condition.`);
  }
  const { description, mode, ...conditions } = value;

  if (typeof description !== "string" || description.trim().length === 0) {
    throw new SkipRuleError(
      "malformed",
      `${label} needs a "description": your own plain-English sentence for this kind of change, ` +
        `which is what a report shows instead of paraphrasing you.`
    );
  }

  // Refused by its own code, with its own sentence: "live" is not a typo
  // and must not be answered as one. CONTRACT rule 6 is the Client's to
  // amend, and until he does, nothing may close without his verdict.
  if (mode === "live") {
    throw new SkipRuleError(
      "live-not-allowed",
      `${label} sets mode = "live", and only "shadow" is built. CONTRACT rule 6 ("the Client's verdict closes a ` +
        `task") has not been amended, so nothing may close without him; until it is, a rule can only record what ` +
        `it would have done. Set mode = "shadow" to keep this kind recording.`
    );
  }
  if (mode !== "shadow") {
    throw new SkipRuleError(
      "malformed",
      `${label} needs mode = "shadow" (the only mode built). Got ${String(mode)}.`
    );
  }

  const unknown = Object.keys(conditions).filter((key) => !(CONDITION_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new SkipRuleError(
      "malformed",
      `${label} names condition(s) the vocabulary has no question for: ${unknown.join(", ")}. ` +
        `A line can only combine the fixed questions: ${CONDITION_KEYS.join(", ")}.`
    );
  }

  const kind: ChangeKind = { name, description: description.trim(), mode: "shadow" };
  for (const key of CONDITION_KEYS) {
    const raw = (conditions as Record<string, unknown>)[key];
    if (raw === undefined) continue;
    // Assigned key by key rather than through one indexed write, so
    // every field keeps its own declared type and a vocabulary entry
    // whose value type nobody validated is a build error, not a cast.
    switch (key) {
      case "allowedFolders":
        kind.allowedFolders = requireFolders(raw, `${label}.${key}`);
        break;
      case "requiredGreenChecks":
        kind.requiredGreenChecks = requireStringList(raw, `${label}.${key}`);
        break;
      case "maxFiles":
        kind.maxFiles = requireCount(raw, `${label}.${key}`);
        break;
      case "maxLines":
        kind.maxLines = requireCount(raw, `${label}.${key}`);
        break;
      case "noTestFiles":
        kind.noTestFiles = requireFlag(raw, `${label}.${key}`);
        break;
      case "noDependencyManifest":
        kind.noDependencyManifest = requireFlag(raw, `${label}.${key}`);
        break;
      case "inspectorGreen":
        kind.inspectorGreen = requireFlag(raw, `${label}.${key}`);
        break;
      case "noQuestionsAsked":
        kind.noQuestionsAsked = requireFlag(raw, `${label}.${key}`);
        break;
      case "noCouldNotVerify":
        kind.noCouldNotVerify = requireFlag(raw, `${label}.${key}`);
        break;
      default: {
        // Compile-time exhaustiveness: a key added to the vocabulary
        // without a branch here fails the build, rather than silently
        // being accepted into the file and then never asked.
        const unhandled: never = key;
        throw new SkipRuleError("malformed", `${label}.${String(unhandled)} has no validator.`);
      }
    }
  }

  const asked = CONDITION_KEYS.filter((key) => kind[key] !== undefined);
  if (asked.length === 0) {
    throw new SkipRuleError(
      "malformed",
      `${label} asks no conditions at all, which would read as "close anything of this kind". ` +
        `Name at least one of: ${CONDITION_KEYS.join(", ")}.`
    );
  }

  return kind;
}

/** A flag condition's only legal value. See `FLAG_CONDITIONS`. */
function requireFlag(raw: unknown, label: string): true {
  if (raw !== true) {
    throw new SkipRuleError(
      "malformed",
      `${label} must be \`true\` if it is there at all, not ${String(raw)}. ` +
        `A question you don't want asked is one you leave out - "false" would be a safeguard removed by a typo.`
    );
  }
  return true;
}

function requireCount(raw: unknown, label: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new SkipRuleError("malformed", `${label} must be a whole number of at least 1, not ${String(raw)}.`);
  }
  return raw;
}

function requireStringList(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    throw new SkipRuleError("malformed", `${label} must be a list of strings.`);
  }
  const entries = (raw as string[]).map((entry) => entry.trim());
  if (entries.length === 0) {
    throw new SkipRuleError(
      "malformed",
      `${label} is an empty list, which answers nothing. Remove it, or name at least one entry.`
    );
  }
  if (entries.some((entry) => entry.length === 0)) {
    throw new SkipRuleError("malformed", `${label} has an empty entry; remove it or name one.`);
  }
  return entries;
}

function requireFolders(raw: unknown, label: string): string[] {
  const entries = requireStringList(raw, label);
  const everything = entries.filter((entry) => entry === "." || entry === "/" || entry === "./");
  if (everything.length > 0) {
    throw new SkipRuleError(
      "malformed",
      `${label} names "${everything[0]}", the whole repository, which allows every file and so asks nothing. ` +
        `Name the folders this kind of change is allowed to touch.`
    );
  }
  // Written as a prefix either way ("src" or "src/"): stored without the
  // trailing slash so the event's own detail reads the way the Client
  // wrote it, and matched as a directory prefix by `isUnderFolder`.
  return entries.map((entry) => entry.replace(/\/+$/, ""));
}

/** Twelve hex characters of the file's sha-256 - enough to tell two
 * versions of a short TOML file apart, short enough to read in a status
 * line. Paired with the Client's own declared `version`, so a file edited
 * without bumping that number is still distinguishable on the record. */
function fileHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}
