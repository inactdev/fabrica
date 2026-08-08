// `fabrica deny-and-log-edit`: reads a PreToolUse hook payload from
// stdin, denies the call, and records it as an edit-attempt-blocked
// event, in one invocation (SPEC.md "Catching off-the-books work"). This
// is what skill/<harness>/settings.json wires a file-editing hook to run
// - see that harness's own README under skill/ for the full history.
//
// This is the installed `fabrica` command itself, not a path into this
// checkout: a harness resolves `fabrica` on PATH the same way it
// resolves any other installed tool, so a session config never needs a
// hand-typed, easily-stale absolute path to this repository (Client
// ruling, issue #13 follow-up). Because `fabrica` already resolves its
// own dependencies via `bin.mjs`'s `import.meta.url` trick regardless of
// the caller's cwd (src/cli/README.md), this still works from inside a
// target project with no `tsx` or `node_modules` of its own - the same
// property the old path substitution existed for.

import { recordBlockedEditAttempt } from "../index.ts";
import { resolveRecordHome } from "./record-home.ts";

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

/** A harness writes the payload and closes stdin immediately, so this only
 * ever expires when one doesn't - and waiting there until the harness's own
 * hook timeout fires is a *non-blocking* error, i.e. the edit is allowed and
 * never logged. Giving up early and denying anyway keeps this command's
 * fail-closed promise. */
const STDIN_READ_TIMEOUT_MS = 5_000;

async function readStdin(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  const chunks: Buffer[] = [];
  const read = (async () => {
    for await (const chunk of stream) chunks.push(chunk as Buffer);
  })().then(
    () => "closed" as const,
    () => "closed" as const
  );

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), timeoutMs);
    timer.unref?.();
  });

  const outcome = await Promise.race([read, deadline]);
  clearTimeout(timer);
  if (outcome === "timed-out") (stream as Partial<NodeJS.ReadStream>).destroy?.();
  return outcome === "timed-out" ? "" : Buffer.concat(chunks).toString("utf8");
}

function denyDecision(): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: DENY_REASON,
    },
  });
}

export const DENY_AND_LOG_EDIT_HELP = `Usage: fabrica deny-and-log-edit

Reads a PreToolUse hook payload from stdin, denies it, and records the
attempt as an edit-attempt-blocked event. Not meant to be typed by hand -
this is what a harness's session config runs automatically; see that
harness's own README under skill/ for how it's wired in.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

export interface RunDenyAndLogEditOptions {
  recordHome?: string;
  stdin?: NodeJS.ReadableStream;
  stdinTimeoutMs?: number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Always denies and always returns 0 - the deny decision on stdout is
 * what stops the edit, not the exit code. Fails closed: a malformed
 * payload, a payload that never arrives, or a logging failure all still
 * emit the deny decision, never silently allow the edit through. (This
 * covers failures *inside* this command; it cannot cover a harness that
 * could not launch `fabrica` at all - see the documented fail-open gap in
 * that harness's own README under skill/.) */
export async function runDenyAndLogEditCommand(opts: RunDenyAndLogEditOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => process.stdout.write(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));

  const raw = await readStdin(opts.stdin ?? process.stdin, opts.stdinTimeoutMs ?? STDIN_READ_TIMEOUT_MS);
  if (raw === "") stderr("deny-and-log-edit: no hook payload arrived on stdin - denying anyway.");

  let payload: PreToolUsePayload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    // Malformed input from the harness itself - still deny below.
  }

  try {
    recordBlockedEditAttempt(opts.recordHome ?? resolveRecordHome(), {
      tool: payload.tool_name ?? "unknown",
      target: payload.tool_input?.file_path ?? payload.tool_input?.notebook_path ?? payload.tool_input?.command,
      cwd: payload.cwd ?? process.cwd(),
      reason: DENY_REASON,
    });
  } catch (err) {
    stderr(`deny-and-log-edit: failed to record the attempt: ${err instanceof Error ? err.message : String(err)}`);
  }

  stdout(denyDecision());
  return 0;
}
