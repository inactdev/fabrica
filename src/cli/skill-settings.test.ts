// Every fabrica subcommand main.ts actually dispatches on is either free
// to run unprompted (it only reads or starts work) or requires the
// Client (it records his own judgment - CONTRACT rule 6; issue #8's
// ask/answer). This proves each shipped skill/<harness>/settings.json
// draws that line exactly, against main.ts's real dispatch rather than
// a name copied by hand, and using the word-boundary and
// compound-command semantics the permission engine documents - so a
// command added to main.ts without a matching decision here fails
// loudly instead of silently landing on whichever side an exclusion
// pattern would have guessed. Harnesses are discovered by reading
// skill/ rather than named here, matching how the hook-settings tests
// do it, since CONTRACT rule 8's scan reads every file under src/.
//
// This models the documented rules (word-boundary prefix matching;
// shell operators - &&, ;, |, and friends - splitting a command into
// independently-checked subcommands) - it is not proof the real
// permission engine behaves that way. skill-settings-live.test.ts is
// the empirical companion that drives a real session and reads its
// own permission_denials, including for a chained bypass attempt. Both
// only cover operator-based chaining and word-boundary prefixes -
// neither attempts a command-substitution-style bypass (e.g.
// `cat $(fabrica verdict ...)`), which stays untested and open.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const skillDir = join(repoRoot, "skill");

// The commands that record the Client's own judgment rather than
// reading or starting work. A command added to main.ts that ends up in
// neither this list nor an allow pattern fails the coverage test below
// instead of silently falling through either way.
const DECIDING_COMMANDS = ["verdict", "answer"];

function commandsInMainDispatch(): string[] {
  const mainSource = readFileSync(join(repoRoot, "src", "cli", "main.ts"), "utf8");
  return [...mainSource.matchAll(/if \(command === "([a-z-]+)"\)/g)]
    .map((m) => m[1])
    .filter((command) => !command.startsWith("-"));
}

interface SettingsTemplate {
  harness: string;
  allow: string[];
  deny: string[];
}

function harnessSettings(): SettingsTemplate[] {
  if (!existsSync(skillDir)) return [];
  return readdirSync(skillDir)
    .filter((name) => statSync(join(skillDir, name)).isDirectory())
    .filter((harness) => existsSync(join(skillDir, harness, "settings.json")))
    .map((harness) => {
      const settings = JSON.parse(readFileSync(join(skillDir, harness, "settings.json"), "utf8")) as {
        permissions?: { allow?: string[]; deny?: string[] };
      };
      return {
        harness,
        allow: settings.permissions?.allow ?? [],
        deny: settings.permissions?.deny ?? [],
      };
    });
}

/** Documented Bash pattern semantics: an exact pattern (no `*`) matches
 * only that literal command; a trailing `<prefix> *` enforces a word
 * boundary, matching the bare prefix (end-of-string) or the prefix
 * followed by a space. */
function bashPatternMatches(pattern: string, command: string): boolean {
  const body = /^Bash\((.*)\)$/.exec(pattern)?.[1];
  if (body === undefined) return false;
  if (body.endsWith(" *")) {
    const prefix = body.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  return command === body;
}

const SEPARATOR_TOKENS = ["&&", "||", "|&", ";", "|", "&"];

/** Shell separators split a command into subcommands checked
 * independently - a rule covering one side of `&&`/`;`/`|` does not
 * extend permission to the other side. */
function subcommandsOf(command: string): string[] {
  return command
    .split(/(&&|\|\||\|&|;|\||&)/)
    .map((part) => part.trim())
    .filter((part) => part !== "" && !SEPARATOR_TOKENS.includes(part));
}

/** Deny beats allow and is checked first; anything matching neither
 * falls to "ask", which is not the same as auto-running. */
function evaluate(settings: SettingsTemplate, command: string): "allow" | "deny" | "ask" {
  const verdicts = subcommandsOf(command).map((sub): "allow" | "deny" | "ask" => {
    if (settings.deny.some((p) => bashPatternMatches(p, sub))) return "deny";
    if (settings.allow.some((p) => bashPatternMatches(p, sub))) return "allow";
    return "ask";
  });
  if (verdicts.includes("deny")) return "deny";
  if (verdicts.includes("ask")) return "ask";
  return "allow";
}

test("main.ts's real dispatch is fully covered: deciding commands are never allowed, everything else is", () => {
  const templates = harnessSettings();
  assert.ok(templates.length > 0, "no harness ships a settings.json to check");

  const commands = commandsInMainDispatch();
  assert.ok(commands.length > 0, "found no commands in main.ts's dispatch - the scan itself is broken");
  for (const deciding of DECIDING_COMMANDS) {
    assert.ok(
      commands.includes(deciding),
      `commandsInMainDispatch() found no "${deciding}" branch - if main.ts's dispatch shape changed ` +
        `(a switch, single quotes, a reformatted condition), this scan silently drops it and the ` +
        `"never allowed" assertion below never runs for it`
    );
  }

  for (const settings of templates) {
    for (const command of commands) {
      const verdict = evaluate(settings, `fabrica ${command}`);
      if (DECIDING_COMMANDS.includes(command)) {
        assert.notEqual(
          verdict,
          "allow",
          `${settings.harness}: "fabrica ${command}" records the Client's own judgment but is auto-approved`
        );
      } else {
        assert.equal(
          verdict,
          "allow",
          `${settings.harness}: "fabrica ${command}" is neither in DECIDING_COMMANDS nor auto-approved - ` +
            `a command added to main.ts must be explicitly decided one way or the other, not left to fall through`
        );
      }
    }
  }
});

test("fabrica verdict and fabrica answer are never auto-approved, including through a chained command", () => {
  const templates = harnessSettings();
  assert.ok(templates.length > 0, "no harness ships a settings.json to check");

  const attempts = [
    "fabrica verdict",
    "fabrica verdict task-1 accept",
    'fabrica verdict task-1 fix -m "note"',
    "fabrica answer",
    'fabrica answer task-1 -m "answer text"',
    "fabrica status && fabrica verdict task-1 accept",
    "fabrica status; fabrica verdict task-1 accept",
    "fabrica do 'x' | fabrica verdict task-1 accept",
    "fabrica log task-1 && fabrica answer task-1 -m 'x'",
  ];

  for (const settings of templates) {
    for (const attempt of attempts) {
      assert.notEqual(
        evaluate(settings, attempt),
        "allow",
        `${settings.harness}: "${attempt}" auto-approves - a verdict/answer command must never run unprompted`
      );
    }
  }
});

test("fabrica do/status/log/watch run unprompted, bare and with arguments", () => {
  const templates = harnessSettings();
  assert.ok(templates.length > 0, "no harness ships a settings.json to check");

  const attempts = [
    "fabrica do",
    'fabrica do "fix the bug" --project /repo',
    "fabrica status",
    "fabrica status --json",
    "fabrica log task-1",
    "fabrica log task-1 --transcript",
    "fabrica watch task-1",
  ];

  for (const settings of templates) {
    for (const attempt of attempts) {
      assert.equal(
        evaluate(settings, attempt),
        "allow",
        `${settings.harness}: "${attempt}" is not auto-approved - reading/starting commands should never prompt`
      );
    }
  }
});
