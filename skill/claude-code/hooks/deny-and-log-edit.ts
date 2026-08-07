// Claude Code PreToolUse hook: denies a file-edit attempt AND logs it as
// an edit-attempt-blocked event, in the same invocation (SPEC.md
// "Catching off-the-books work"). Replaces an earlier two-piece design
// (a bare-name permissions.deny entry plus a separate PermissionDenied
// hook, log-blocked-edit.ts - deleted) after empirical testing against
// the really installed harness found that design's PermissionDenied hook
// never fired in ANY of four tested configurations (bare-name deny, a
// path-form deny, no deny rule at all, and via a spawned subagent) - see
// ../README.md's verification table for the full history and how this
// design was verified instead.
//
// Denying through a PreToolUse hook rather than permissions.deny keeps
// the tool visible to the model (never removed from its context), so a
// real tool-use attempt is made every time - which is exactly what makes
// logging possible: nothing attempted means nothing to log.
// permissionDecisionReason is also shown back to the model, so an
// attempt now gets a clear, actionable explanation instead of the tool
// silently not existing.
//
// Deliberately imports from ../../../src/index.ts, the same single public
// entry point the CLI uses - never src/offbooks/ directly (this script is
// as much an "outermost layer" as src/cli/ is, so it follows the same
// AGENTS.md rule).

import { recordBlockedEditAttempt } from "../../../src/index.ts";

const DENY_REASON =
  'Fabrica: file editing is disabled in this session. Use `fabrica do "<task>" --project <name>` ' +
  "to make the change through a tracked, verified task instead.";

interface PreToolUsePayload {
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    notebook_path?: string;
    command?: string;
  };
  cwd?: string;
}

function resolveRecordHome(): string {
  const override = process.env.FABRICA_HOME;
  if (override !== undefined && override.trim().length > 0) return override;
  return `${process.env.HOME ?? ""}/.fabrica`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function emitDeny(): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: DENY_REASON,
      },
    })
  );
}

async function main(): Promise<void> {
  let payload: PreToolUsePayload = {};
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    // Malformed input from the harness itself - still deny below (fail closed).
  }

  try {
    recordBlockedEditAttempt(resolveRecordHome(), {
      tool: payload.tool_name ?? "unknown",
      target: payload.tool_input?.file_path ?? payload.tool_input?.notebook_path ?? payload.tool_input?.command,
      cwd: payload.cwd ?? process.cwd(),
      reason: DENY_REASON,
    });
  } catch (err) {
    process.stderr.write(
      `deny-and-log-edit hook: failed to record the attempt: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }

  emitDeny();
}

main().catch((err) => {
  process.stderr.write(`deny-and-log-edit hook crashed: ${err instanceof Error ? err.message : String(err)}\n`);
  emitDeny();
});
