// Guards the shipped session-config templates under skill/<harness>/: their
// PreToolUse matcher is a regex tested against tool_name, not an exact-match
// list, so an unanchored form would also deny (and log as an
// edit-attempt-blocked event) every unrelated tool whose name merely contains
// one of the editing-tool words. Harnesses are discovered by reading skill/
// rather than named here, since CONTRACT rule 8's scan reads every file under
// src/ and a harness's name inside this one would trip it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skill");

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

const EDITING_TOOLS = ["Edit", "Write", "NotebookEdit", "MultiEdit"];

interface HarnessTemplate {
  harness: string;
  entries: { matcher: string; commands: string[] }[];
  allow: string[];
}

function harnessTemplates(): HarnessTemplate[] {
  return readdirSync(skillDir)
    .filter((name) => statSync(join(skillDir, name)).isDirectory())
    .filter((harness) => existsSync(join(skillDir, harness, "settings.json")))
    .map((harness) => {
      const settings = JSON.parse(readFileSync(join(skillDir, harness, "settings.json"), "utf8")) as {
        hooks?: { PreToolUse?: HookEntry[] };
        permissions?: { allow?: string[] };
      };
      return {
        harness,
        entries: (settings.hooks?.PreToolUse ?? []).map((entry) => ({
          matcher: entry.matcher ?? "",
          commands: (entry.hooks ?? []).map((hook) => hook.command ?? ""),
        })),
        allow: settings.permissions?.allow ?? [],
      };
    });
}

/** The entries these tests are about: the ones whose matcher catches an
 * editing tool. A harness is free to wire unrelated PreToolUse hooks of its
 * own alongside them, and nothing here should judge those. */
function editingEntries(template: HarnessTemplate): HarnessTemplate["entries"] {
  return template.entries.filter((entry) => EDITING_TOOLS.some((tool) => new RegExp(entry.matcher).test(tool)));
}

test("every shipped session config wires the editing tools to a PreToolUse hook", () => {
  const templates = harnessTemplates();
  assert.ok(templates.length > 0, "no harness ships a settings.json at all");

  for (const template of templates) {
    const { harness, entries } = template;
    assert.ok(entries.length > 0, `${harness}: settings.json declares no PreToolUse hook`);
    for (const tool of EDITING_TOOLS) {
      assert.ok(
        entries.some((entry) => new RegExp(entry.matcher).test(tool)),
        `${harness}: no PreToolUse matcher covers the ${tool} tool`
      );
    }
  }
});

test("a shipped matcher never catches a tool whose name merely contains an editing word", () => {
  // An unanchored `Edit|Write|...` matches all of these, which would deny
  // harmless tools and dilute the one event this template exists to produce.
  const bystanders = ["TodoWrite", "mcp__notes__WritePage", "EditorConfigRead", "PreEdit"];

  for (const template of harnessTemplates()) {
    for (const { matcher } of editingEntries(template)) {
      for (const tool of bystanders) {
        assert.equal(
          new RegExp(matcher).test(tool),
          false,
          `${template.harness}: matcher ${matcher} also denies the unrelated ${tool} tool - anchor it with ^(...)$`
        );
      }
    }
  }
});

test("a shipped hook command is the installed fabrica command, never a hand-typed path", () => {
  // The design this replaced substituted an absolute path into a checkout by
  // hand, which fails open the moment that path goes stale (see the harness's
  // own README under skill/). A path here is that failure mode coming back.
  for (const template of harnessTemplates()) {
    const harness = template.harness;
    const commands = editingEntries(template).flatMap((entry) => entry.commands);
    assert.ok(commands.length > 0, `${harness}: settings.json wires no hook command at all`);
    for (const command of commands) {
      assert.match(command, /^fabrica /, `${harness}: hook command ${command} must invoke fabrica off PATH`);
      assert.equal(
        /[/\\]|<[A-Z-]+>/.test(command),
        false,
        `${harness}: hook command ${command} names a path or placeholder - it must resolve on PATH instead`
      );
    }
  }
});

test("no shipped Bash allow entry auto-approves find", () => {
  // Client ruling (issue #13 follow-up): removed outright, not narrowed -
  // `find -delete`/`-exec` mutates the filesystem without ever becoming a
  // commit, so nothing downstream sees it. Allow means no prompt at all.
  for (const { harness, allow } of harnessTemplates()) {
    for (const entry of allow) {
      assert.equal(
        /^Bash\(\s*find\b/.test(entry),
        false,
        `${harness}: allow entry ${entry} auto-approves find - removed by ruling, see that harness's README`
      );
    }
  }
});
