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

function harnessTemplates(): { harness: string; matchers: string[] }[] {
  return readdirSync(skillDir)
    .filter((name) => statSync(join(skillDir, name)).isDirectory())
    .filter((harness) => existsSync(join(skillDir, harness, "settings.json")))
    .map((harness) => {
      const settings = JSON.parse(readFileSync(join(skillDir, harness, "settings.json"), "utf8")) as {
        hooks?: { PreToolUse?: HookEntry[] };
      };
      const entries = settings.hooks?.PreToolUse ?? [];
      return { harness, matchers: entries.map((entry) => entry.matcher ?? "") };
    });
}

test("every shipped session config wires the editing tools to a PreToolUse hook", () => {
  const templates = harnessTemplates();
  assert.ok(templates.length > 0, "no harness ships a settings.json at all");

  for (const { harness, matchers } of templates) {
    assert.ok(matchers.length > 0, `${harness}: settings.json declares no PreToolUse hook`);
    for (const matcher of matchers) {
      for (const tool of ["Edit", "Write", "NotebookEdit", "MultiEdit"]) {
        assert.ok(new RegExp(matcher).test(tool), `${harness}: matcher ${matcher} misses the ${tool} tool`);
      }
    }
  }
});

test("a shipped matcher never catches a tool whose name merely contains an editing word", () => {
  // An unanchored `Edit|Write|...` matches all of these, which would deny
  // harmless tools and dilute the one event this template exists to produce.
  const bystanders = ["TodoWrite", "mcp__notes__WritePage", "EditorConfigRead", "PreEdit"];

  for (const { harness, matchers } of harnessTemplates()) {
    for (const matcher of matchers) {
      for (const tool of bystanders) {
        assert.equal(
          new RegExp(matcher).test(tool),
          false,
          `${harness}: matcher ${matcher} also denies the unrelated ${tool} tool - anchor it with ^(...)$`
        );
      }
    }
  }
});
