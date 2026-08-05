// The Client's daily coding agent (Claude Code), driven non-interactively.
// A CLI adapter (adapters/README.md's first family): this file's only job
// is to build the right command line, hand `brief` to the real `claude`
// binary, and translate what it prints back into the shapes `Brain`
// promises. All flags below were verified against the installed binary
// (2.1.222) on 2026-08-04, not guessed - see claude-code.test.ts's
// real-binary test for the live proof and claude-code.md for what
// each discovery means.

import { spawn } from "node:child_process";
import type { Brain, BrainWorkOptions, BrainWorkResult, TranscriptEntry } from "../types.ts";

export type ClaudeCodeErrorCode = "spawn-failed" | "cli-error" | "unparseable-output";

export class ClaudeCodeError extends Error {
  readonly code: ClaudeCodeErrorCode;

  constructor(code: ClaudeCodeErrorCode, message: string) {
    super(message);
    this.name = "ClaudeCodeError";
    this.code = code;
  }
}

export interface ClaudeCodeAdapterOptions {
  /** Value for `claude --model` (an alias like "sonnet" or a full model
   * id like "claude-sonnet-5"). Omitted means the CLI's own configured
   * default runs, and `Brain.model` reports that honestly as "default"
   * rather than guessing which model that resolves to. */
  model?: string;
  /** The `claude` executable to run - override for tests that stand in
   * a controllable fake binary. Defaults to "claude" (resolved via PATH,
   * same as a person typing it at a shell). */
  binPath?: string;
}

// One line of `claude ... --output-format stream-json`. Only the shape
// this file reads is declared; the real tool emits more than this.
interface ClaudeStreamBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}
interface ClaudeStreamLine {
  type: string;
  message?: { content?: ClaudeStreamBlock[] };
  // The terminal summary line (type: "result") carries everything a
  // receipt eventually wants: cost, duration, token usage, session id.
  is_error?: boolean;
  session_id?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  api_error_status?: number;
  result?: string;
}

function buildArgs(brief: string, opts: ClaudeCodeAdapterOptions, workOpts?: BrainWorkOptions): string[] {
  const args = [
    "-p",
    brief,
    "--output-format",
    "stream-json",
    "--verbose",
    // Without this, every Write/Edit/Bash mutation is silently
    // permission-denied in non-interactive mode (verified: there is no
    // TTY to answer the prompt, so the tool can only refuse). The cost:
    // for the duration of a call the worker has the full access of the
    // OS account this process runs as - Bash/Write/Edit are NOT scoped
    // to workdir. The ProductionLine worktree protects the Client's
    // real project files from modification (CONTRACT rule 1), but it
    // provides no process-level containment - a worker could in
    // principle reach the real checkout, the home directory, or the
    // network. Accepted, documented v1 risk: tolerable only because
    // runs are small and attended; real containment is separate
    // follow-up work that must land before anything runs unattended.
    "--permission-mode",
    "bypassPermissions",
  ];
  if (workOpts?.session) args.push("--resume", workOpts.session);
  if (opts.model) args.push("--model", opts.model);
  // claude's own --effort flag already implements the Brain contract's
  // "ignore what you don't recognize, never fail" rule: an unrecognized
  // value logs a stderr warning and falls back to the default effort,
  // exit code 0 (verified against the real binary). Nothing extra to
  // enforce here.
  if (workOpts?.reasoningEffort) args.push("--effort", workOpts.reasoningEffort);
  return args;
}

function parseLines(stdout: string): ClaudeStreamLine[] {
  const lines: ClaudeStreamLine[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      lines.push(JSON.parse(line) as ClaudeStreamLine);
    } catch {
      // A non-JSON line never happens in stream-json output; skip
      // defensively rather than fail a whole run over one stray line.
    }
  }
  return lines;
}

function toTranscript(lines: ClaudeStreamLine[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const now = () => new Date().toISOString();

  for (const line of lines) {
    // "system" (hook chatter, session init) and "rate_limit_event" are
    // about the harness this binary happens to be running inside, not
    // about the work it did on the brief - left out of what a human
    // reviewing the worker's transcript needs to see. "assistant" carries
    // what the worker thought and did; "user" carries a tool's result
    // fed back to it - both are part of the real record of the work.
    if (line.type === "assistant") {
      for (const block of line.message?.content ?? []) {
        if (block.type === "thinking" && block.thinking) {
          entries.push({ occurredAt: now(), kind: "reasoning", text: block.thinking });
        } else if (block.type === "text" && block.text) {
          entries.push({ occurredAt: now(), kind: "text", text: block.text });
        } else if (block.type === "tool_use") {
          entries.push({
            occurredAt: now(),
            kind: "tool-call",
            text: `${block.name ?? "tool"}(${JSON.stringify(block.input ?? {})})`,
          });
        }
      }
    } else if (line.type === "user") {
      for (const block of line.message?.content ?? []) {
        if (block.type !== "tool_result") continue;
        const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        entries.push({ occurredAt: now(), kind: block.is_error ? "tool-error" : "tool-result", text });
      }
    }
  }
  return entries;
}

export function claudeCodeAdapter(opts: ClaudeCodeAdapterOptions = {}): Brain {
  const bin = opts.binPath ?? "claude";

  return {
    name: "claude-code",
    model: opts.model ?? "default",

    async work(brief: string, workdir: string, workOpts?: BrainWorkOptions): Promise<BrainWorkResult> {
      const args = buildArgs(brief, opts, workOpts);

      const { stdout, stderr, exitCode } = await new Promise<{
        stdout: string;
        stderr: string;
        exitCode: number | null;
      }>((resolve, reject) => {
        const child = spawn(bin, args, { cwd: workdir });
        child.stdin.end();
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => (stdout += chunk));
        child.stderr.on("data", (chunk: string) => (stderr += chunk));
        child.on("error", (err: NodeJS.ErrnoException) => {
          reject(
            new ClaudeCodeError(
              "spawn-failed",
              `could not run "${bin}" in ${workdir}: ${err.code ?? err.message}`
            )
          );
        });
        child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
      });

      const lines = parseLines(stdout);
      const result = [...lines].reverse().find((l) => l.type === "result");

      if (exitCode !== 0 || result?.is_error) {
        const detail = result?.result ?? (stderr.trim() || `exit code ${exitCode}`);
        const status = result?.api_error_status ? ` (api_error_status ${result.api_error_status})` : "";
        throw new ClaudeCodeError("cli-error", `${detail}${status}`);
      }

      if (!result) {
        throw new ClaudeCodeError(
          "unparseable-output",
          `"${bin}" exited 0 but printed no "result" line - cannot recover session id or cost`
        );
      }

      const transcript = toTranscript(lines);
      // The Brain interface has no field of its own for cost/duration/
      // token usage (contract/surface.ts's Brain.work() only returns
      // transcript, gateChanges, and session) - but the issue that
      // called for this adapter also called for cost to reach a
      // Receipt eventually, and this is the only call the rest of
      // Fabrica ever makes. Recording it as one more structured entry,
      // rather than a return field, gets it where it's needed (whatever
      // assembles Receipt can read this entry back out) without
      // reshaping the seam - see claude-code.md.
      transcript.push({
        occurredAt: new Date().toISOString(),
        kind: "usage",
        text: JSON.stringify({
          totalCostUsd: result.total_cost_usd ?? null,
          durationMs: result.duration_ms ?? null,
          usage: result.usage ?? null,
        }),
      });

      return {
        transcript,
        session: result.session_id,
      };
    },
  };
}
