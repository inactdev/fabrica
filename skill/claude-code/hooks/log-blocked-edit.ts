// Claude Code PermissionDenied hook: reads the denial payload Claude Code
// writes to stdin and records it as an edit-attempt-blocked event, so a
// blocked edit is still visible on Fabrica's own record even though it
// never touched disk (SPEC.md "Catching off-the-books work"). Wired up via
// settings.json's hooks.PermissionDenied entry — see ../README.md for the
// exact settings and how this hook event and its payload shape were
// verified against the installed Claude Code binary.
//
// Deliberately imports from ../../../src/index.ts, the same single public
// entry point the CLI uses — never src/offbooks/ directly (this script is
// as much an "outermost layer" as src/cli/ is, so it follows the same
// AGENTS.md rule).

import { recordBlockedEditAttempt } from "../../../src/index.ts";

interface PermissionDeniedPayload {
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    notebook_path?: string;
    command?: string;
  };
  cwd?: string;
  reason?: string;
}

function resolveRecordHome(): string {
  const override = process.env.FABRICA_HOME;
  if (override !== undefined && override.trim().length > 0) return override;
  // Mirrors src/cli/record-home.ts's default exactly (SPEC.md: "~/.fabrica/
  // (path configurable)") — not imported from there because that module is
  // deliberately CLI-only (AGENTS.md: "the record home is never hardcoded
  // past the outermost CLI layer"), and this hook is its own such layer.
  return `${process.env.HOME ?? ""}/.fabrica`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const payload = JSON.parse(await readStdin()) as PermissionDeniedPayload;

  recordBlockedEditAttempt(resolveRecordHome(), {
    tool: payload.tool_name ?? "unknown",
    target: payload.tool_input?.file_path ?? payload.tool_input?.notebook_path ?? payload.tool_input?.command,
    cwd: payload.cwd ?? process.cwd(),
    reason: payload.reason,
  });
}

main().catch((err) => {
  // Logging a blocked attempt is a courtesy, same principle as
  // src/offbooks/check.ts's detection net: a failure here must never
  // surface as a Claude Code error or interrupt the session it's watching.
  process.stderr.write(`log-blocked-edit hook: ${err instanceof Error ? err.message : String(err)}\n`);
});
