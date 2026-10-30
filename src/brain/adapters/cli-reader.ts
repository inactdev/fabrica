// A code reader (src/reader/) that reaches its model through the `claude`
// command already installed on this machine, instead of through an API
// key and an endpoint.
//
// Issue #315, the second work-mode issue: at work the only model access
// is Claude Code on a company subscription - there is no API key and no
// OpenRouter - so `[reader] vendor = "claude-code"` has to work with no
// `<VENDOR>_API_KEY` and no `<VENDOR>_BASE_URL` at all. The model name
// still comes from projects.toml, exactly as it does for every other
// vendor.
//
// WHY THIS FILE IS HERE. This directory is the only one anywhere under
// `src/` allowed to name a brain, a model, a vendor or a harness
// (CONTRACT rule 8, whose scan reads every other file under `src/` and
// flags the word as plain text, an import specifier included). So all of
// "which `vendor =` spelling means this", "which command that is", "how
// its command line is built" and "how its answer is read back" lives
// here, and `cliReaderFor(vendor)` is the whole of what the generic
// reader module asks - it never learns the name it just matched.
//
// It is NOT a `Brain`: a reader never works on a repository, holds no
// session and runs no tools, so it implements none of that interface.
// It is one call that takes text and returns text, the same seam
// `src/reader/call.ts` fills for an API-keyed vendor.
//
// EVERY FLAG BELOW WAS VERIFIED against the installed binary (2.1.222)
// on 2026-10-30, not guessed - see claude-code.md's "Reading a diff
// through the host's own CLI" for the exact commands and what each
// returned.

import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/** The `vendor =` spelling in projects.toml that means "go through the
 * command below". Deliberately the harness's own name rather than the
 * company's: `[reader] vendor = "anthropic"` is the API-keyed vendor and
 * stays that, so a Client who has both can name either. */
export const CLI_READER_VENDOR = "claude-code";

/** What has to be on PATH for that vendor to work. A missing one is a
 * refusal at task start, naming it (src/reader/resolve.ts) - the
 * clarification issue #315 itself gives. */
export const CLI_READER_COMMAND = "claude";

/** A whole diff in and a list out: generous, and the same ceiling the
 * API-keyed path uses (src/reader/call.ts's `DEFAULT_TIMEOUT_MS`), so a
 * slow read fails the same way whichever way it was reached. */
export const CLI_READER_TIMEOUT_MS = 300_000;

/** The result subtype the command prints when it could not satisfy the
 * schema. Not a failed call: the model read the diff, only the shape
 * went wrong, so its own text is read instead - the same carve-out
 * `claude-code.ts` makes for a missing write-up. */
const SCHEMA_GAVE_UP = "error_max_structured_output_retries";

/** How much of the command's own error output is worth repeating to the
 * Client - enough to carry a real message, short enough that a failure
 * line stays a line. */
const ERROR_OUTPUT_CHARS = 1_000;

export interface CliReaderRequest {
  /** From projects.toml's `[reader] model`, forwarded as `--model`. */
  model: string;
  /** The same `messages` array the API-keyed call sends, joined into the
   * one prompt this command takes. Nothing about the prompt is composed
   * here: the reader's own module owns what it asks for. */
  messages: { role: "system" | "user"; content: string }[];
  /** JSON Schema for `--json-schema`, so the answer comes back already
   * structured instead of parsed out of prose. The shape is the
   * reader's, not this file's. */
  schema: unknown;
  timeoutMs?: number;
  /** The environment the command inherits. Defaults to Fabrica's own,
   * because the whole point of this vendor is that the host's own
   * installed, already-signed-in CLI is the credential - there is none
   * for Fabrica to pass. Never modified. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: a stand-in binary, so the fast tests prove this file's
   * argument-building and answer-reading without a credential, a
   * network or a cent of spend. */
  command?: string;
}

/** What the generic reader module gets back for a vendor this file
 * serves. Nothing on it names anything: the caller sees a command string
 * to print in a refusal and two functions to call. */
export interface CliReaderVendor {
  /** The vendor as projects.toml spells it - handed back so a caller
   * echoes the Client's own word without holding it as a literal. */
  vendor: string;
  /** The command that must be on PATH. Printed in refusals. */
  command: string;
  /** Whether that command is there, looked up without running anything. */
  installed: (env: NodeJS.ProcessEnv) => boolean;
  /** One read. Resolves with the model's answer as text - JSON, when the
   * structured answer arrived - and throws an Error written for the
   * Client for every way the call can fail. */
  ask: (request: CliReaderRequest) => Promise<string>;
}

/**
 * The vendor this file serves, or undefined when `vendor` is somebody
 * else's - which is every other vendor, all of which the generic module
 * then settles the ordinary way (a key and an endpoint).
 *
 * Compared the way a person reads it (trimmed, case-insensitive), the
 * same comparison `src/reviewer/resolve.ts` makes about vendor names
 * written by hand into projects.toml.
 */
export function cliReaderFor(vendor: string): CliReaderVendor | undefined {
  if (vendor.trim().toLowerCase() !== CLI_READER_VENDOR) return undefined;
  return {
    vendor: CLI_READER_VENDOR,
    command: CLI_READER_COMMAND,
    installed: (env) => commandOnPath(CLI_READER_COMMAND, env),
    ask: askCliReader,
  };
}

/** Whether `command` names an executable - a path as given, a bare name
 * against PATH - looked up without running anything.
 *
 * `src/inspector/run.ts`'s `commandIsInstalled` is the same ten lines
 * for the same question about Inspector's own binary. Deliberately not
 * imported: a brain adapter has no business depending on the Inspector
 * module, and this is the cheaper of the two wrongs.
 */
function commandOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  const candidates =
    isAbsolute(command) || command.includes("/")
      ? [command]
      : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  return candidates.some((path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * The command line. Every flag is on the verified list (2.1.222):
 *
 * - `-p` with NO prompt argument: the prompt arrives on stdin instead.
 *   This is not a style choice - Linux caps one argv string at 128 KiB
 *   (MAX_ARG_STRLEN), and a read is allowed up to 1 MB of diff
 *   (src/reader/read.ts's MAX_DIFF_BYTES), so the reference adapter's
 *   `-p <brief>` shape would die with E2BIG on a large change. Verified
 *   live: `printf '<prompt>' | claude -p --output-format json ...`
 *   answers exactly as the argv form does.
 * - `--output-format json`: one result object on stdout, the shape
 *   `doctor-checks.ts`'s live probe already reads.
 * - `--json-schema <schema>`: the answer comes back on that object's
 *   `structured_output`, already parsed (verified live, and the same
 *   fact `claude-code.ts`'s write-up schema depends on).
 * - `--tools ""`: all tools off. The reader reads the diff it was
 *   handed; it has no business opening files, running commands or
 *   reaching the network. Verified live that structured output still
 *   arrives with tools disabled (it rides its own channel, not the tool
 *   set).
 * - `--model <model>`: the Client's own `[reader] model`.
 *
 * No `--permission-mode bypassPermissions` (nothing is being edited, so
 * there is nothing to unlock), no `--resume` (a read is never continued),
 * and no `--max-budget-usd`: the API-keyed path has no cap either, and a
 * cap here would turn a read into a truncated one, which is the one
 * dishonest answer available (see src/reader/read.ts on why too much
 * diff is refused rather than trimmed).
 */
export function buildCliReaderArgs(request: CliReaderRequest): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(request.schema),
    "--tools",
    "",
    "--model",
    request.model,
  ];
}

/** The messages, as the one prompt this command takes. The roles are not
 * dropped silently - there is no separate system channel being used
 * here, so both parts go into the prompt in order, which is what the
 * reference adapter's own `ask()` does with its instruction and its task
 * text. */
export function cliReaderPrompt(messages: { content: string }[]): string {
  return messages.map((message) => message.content).join("\n\n");
}

async function askCliReader(request: CliReaderRequest): Promise<string> {
  const command = request.command ?? CLI_READER_COMMAND;
  // A fresh, empty directory per call, exactly as the reference
  // adapter's `ask()` runs in one: this command discovers agent-memory
  // files and settings from its working directory, and a read must see
  // the diff it was handed and nothing else of whatever repository
  // Fabrica happens to be standing in.
  const cwd = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-cli-reader-"));
  try {
    const run = await runCommand(command, buildCliReaderArgs(request), cliReaderPrompt(request.messages), {
      cwd,
      env: request.env ?? process.env,
      timeoutMs: request.timeoutMs ?? CLI_READER_TIMEOUT_MS,
    });
    return answerFrom(command, run);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

interface CommandRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(
  command: string,
  args: string[],
  stdin: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<CommandRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // ENOENT here means the command went missing between the refusal
      // check at task start and the read itself. Said plainly rather
      // than reported as the model's own failure.
      reject(new Error(`could not run the reader's command \`${command}\`: ${err.code ?? err.message}`));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`the reader's command \`${command}\` gave no answer within ${opts.timeoutMs}ms`));
        return;
      }
      resolve({ exitCode, stdout, stderr });
    });
    // Written and closed in one go: the prompt is the whole of this
    // call's input, and an open stdin would leave the command waiting.
    child.stdin.on("error", () => {
      // A command that exited before reading its prompt (a missing
      // credential, say) closes the pipe under us. The real reason is in
      // its own output, which `close` above already carries - an EPIPE
      // here would say nothing useful and must not crash the process.
    });
    child.stdin.end(stdin);
  });
}

/**
 * The model's answer out of one result object, or an Error written for
 * the Client.
 *
 * The order, and the reasoning:
 *
 * 1. A real failure is a failure. `is_error` is the binary's own word
 *    for it, and it is honoured even if something answer-shaped came
 *    along with it - the same call `claude-code.ts` makes about the same
 *    field, with the same one carve-out below.
 * 2. `error_max_structured_output_retries` - the command giving up on
 *    the schema, which `claude-code.ts` treats as "no write-up" rather
 *    than a failed call - is carved out for the same reason: the model
 *    did the reading, only the shape went wrong, and its own text is
 *    still worth reading.
 * 3. `structured_output` is the schema's own answer, already parsed, so
 *    it is handed back as JSON text for the reader's single parser.
 * 4. Otherwise whatever text the call produced, which that same parser
 *    is already tolerant of (fences, a sentence in front) - and which
 *    fails the read quoting the model's own words if it holds no
 *    findings list at all. An honest failure beats a clean read nobody
 *    said.
 */
function answerFrom(command: string, run: CommandRun): string {
  const line = run.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) {
    throw new Error(
      `the reader's command \`${command}\` printed nothing (exit ${run.exitCode}): ${tail(run.stderr)}`
    );
  }

  let result: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    result = parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `the reader's command \`${command}\` printed something that is not a result object ` +
        `(${err instanceof Error ? err.message : String(err)}): ${tail(line)}`
    );
  }

  const structured = result.structured_output;
  const answered = typeof structured === "object" && structured !== null;
  const text = typeof result.result === "string" ? result.result.trim() : "";
  const gaveUpOnSchema = result.subtype === SCHEMA_GAVE_UP;
  if ((result.is_error === true && !gaveUpOnSchema) || (!answered && text.length === 0)) {
    const why = text.length > 0 ? text : run.stderr;
    const status = typeof result.api_error_status === "number" ? ` (api_error_status ${result.api_error_status})` : "";
    throw new Error(
      `the reader's command \`${command}\` failed (exit ${run.exitCode}` +
        `${typeof result.subtype === "string" ? `, ${result.subtype}` : ""})${status}: ${tail(why)}`
    );
  }

  return answered ? JSON.stringify(structured) : text;
}

function tail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > ERROR_OUTPUT_CHARS ? `${flat.slice(0, ERROR_OUTPUT_CHARS)}...` : flat;
}
