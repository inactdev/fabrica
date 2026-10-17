// The Client's daily coding agent (Claude Code), driven non-interactively.
// A CLI adapter (adapters/README.md's first family): this file's only job
// is to build the right command line, hand `brief` to the real `claude`
// binary, and translate what it prints back into the shapes `Brain`
// promises. All flags below were verified against the installed binary
// (2.1.222) on 2026-08-04, not guessed - see claude-code.test.ts's
// real-binary test for the live proof and claude-code.md for what
// each discovery means.

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Brain, BrainAskResult, BrainWorkOptions, BrainWorkResult, TranscriptEntry, WorkerWriteup } from "../types.ts";
import { WRITEUP_FIELDS, WRITEUP_STRING_FIELDS, WRITEUP_TITLE_MAX_LENGTH } from "../writeup.ts";
import { ContainmentError, createIsolatedNetwork, removeIsolatedNetwork, runContained } from "../../containment/index.ts";
import type { ReadOnlyMount } from "../../containment/index.ts";
import type { CheckBox } from "../check-box.ts";
import { resolveCommonGitDir, writeSanitizedGitConfig } from "../../line/index.ts";
import { emitLiveTranscriptEntry } from "../live-transcript.ts";
import { GITHUB_HOSTS, RelayError, startRelay } from "../../relay/index.ts";

export type ClaudeCodeErrorCode = "spawn-failed" | "cli-error" | "unparseable-output";

export class ClaudeCodeError extends Error {
  readonly code: ClaudeCodeErrorCode;

  constructor(code: ClaudeCodeErrorCode, message: string) {
    super(message);
    this.name = "ClaudeCodeError";
    this.code = code;
  }
}

// The host environment variable `defaultBrainAdapter` forwards the real
// worker token under (adapters/index.ts's CREDENTIAL_VAR). Named again
// here, in the one directory CONTRACT rule 8 lets a brain be named in,
// so this file can tell "the real token arrived from the host" apart
// from "nothing to protect" (a test's own fake env, which never sets
// this) without the Brain interface needing to say so explicitly.
const HOST_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

// The real model provider's own host - CONTRACT rule 8 permits naming it
// only here. This is where ANTHROPIC_BASE_URL points by default; the
// relay's gateway (below) forwards to it with the real credential
// substituted in, verified against Claude Code's current documentation
// (code.claude.com/docs/en/llm-gateway-connect and .../authentication):
// ANTHROPIC_BASE_URL overrides the API endpoint, and ANTHROPIC_AUTH_TOKEN
// is "sent as the Authorization: Bearer header... when routing through
// an LLM gateway or proxy that authenticates with bearer tokens" - which
// is exactly this relay. CLAUDE_CODE_OAUTH_TOKEN itself has no documented
// gateway-routing support (the gateway-connect guide names only
// ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY as credential variables), so the
// container is handed ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL instead of
// a placeholder-valued HOST_TOKEN_VAR. The one fact this adapter cannot
// verify from documentation or on this machine (no Docker, no live
// credential here) is that api.anthropic.com accepts a subscription
// OAuth token - the same value CLAUDE_CODE_OAUTH_TOKEN would have
// carried - as that Bearer value; it is the standard OAuth-bearer wire
// format, but confirming it needs a real task run, which is this
// change's own stated "done" condition.
const ANTHROPIC_HOST = "api.anthropic.com";
const ANTHROPIC_AUTH_HEADER = "authorization";

/** What `connectThroughRelay` hands back to `ask()`/`work()`: the extra
 * env to merge over the caller's own (with `HOST_TOKEN_VAR` already
 * removed), the container network to run on, and a teardown to run once
 * the call is done - every bit of it (the network, the relay, the
 * placeholder) is as throwaway as the container itself. */
interface RelayedNetwork {
  env: Record<string, string>;
  network: { isolatedNetwork: string };
  teardown: () => Promise<void>;
}

/** Issue #186's second half, scoped down (no `projects.toml`, no
 * `fabrica doctor` - just the wiring): every worker box joins a fresh
 * isolated network (`../../containment/isolated-network.ts`) with no
 * route anywhere except the relay this starts on that network's own
 * gateway address. The container never sees `realToken` - only a
 * freshly minted, per-call placeholder in `ANTHROPIC_AUTH_TOKEN` - while
 * `ANTHROPIC_BASE_URL` points at the relay. GitHub is reachable through
 * the relay's CONNECT tunnel (`GITHUB_HOSTS`); every other tunnel target
 * is refused. Every other request (model calls, since `ANTHROPIC_BASE_URL`
 * redirects them here) is forwarded to the real `ANTHROPIC_HOST`, with
 * the placeholder swapped back out for `realToken` on the way - the one
 * place both values ever meet. */
async function connectThroughRelay(realToken: string): Promise<RelayedNetwork> {
  const id = randomUUID().replace(/-/g, "");
  const networkName = `fabrica-worker-${id}`;
  const placeholder = `fabrica-placeholder-${id}`;

  // The relay's own "network-refused" bookkeeping (src/relay/types.ts's
  // RelayOptions) wants a record home and task id, neither of which this
  // seam has: Brain.ask/work take no taskId at all (CONTRACT rule 8's
  // socket is brief/workdir/opts only), so there is no real task record
  // to attribute a refusal to here. A throwaway scratch location stands
  // in instead, the same spirit as ask()'s own throwaway scratch
  // directory and homeDir above - a refused tunnel target from this
  // relay therefore doesn't reach the Client's real task record today;
  // a stated gap, not a silent one.
  const scratchRecordHome = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-relay-record-"));

  const network = await createIsolatedNetwork(networkName);
  const relay = await startRelay({
    recordHome: scratchRecordHome,
    taskId: "worker",
    bindAddress: network.gatewayIp,
    tunnelAllowlist: [...GITHUB_HOSTS],
    gateway: {
      host: ANTHROPIC_HOST,
      credential: { header: ANTHROPIC_AUTH_HEADER, fakeValue: placeholder, realValue: `Bearer ${realToken}` },
    },
  });

  return {
    env: {
      ANTHROPIC_BASE_URL: `http://${network.gatewayIp}:${relay.port}`,
      ANTHROPIC_AUTH_TOKEN: placeholder,
      // Documented fix (code.claude.com/docs/en/llm-gateway-connect,
      // "Turn off traffic outside the gateway path") for exactly this
      // network's own shape: version checks, telemetry, and similar
      // nonessential calls bypass ANTHROPIC_BASE_URL and go straight to
      // Anthropic's own hosts, which this isolated network has no route
      // to at all - left unset, they would not fail cleanly, they would
      // hang until they time out.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      // GitHub reachability for anything inside the box that speaks the
      // ordinary HTTP_PROXY/HTTPS_PROXY convention (git itself needs
      // none - its network access to the project's history is already
      // read-only bind mounts, never live - but a Worker's own shell
      // commands, e.g. the `gh` CLI, do). Both cases since different
      // tools read different ones.
      HTTP_PROXY: `http://${network.gatewayIp}:${relay.port}`,
      HTTPS_PROXY: `http://${network.gatewayIp}:${relay.port}`,
      http_proxy: `http://${network.gatewayIp}:${relay.port}`,
      https_proxy: `http://${network.gatewayIp}:${relay.port}`,
    },
    network: { isolatedNetwork: networkName },
    teardown: async () => {
      await relay.close();
      await removeIsolatedNetwork(networkName);
      rmSync(scratchRecordHome, { recursive: true, force: true });
    },
  };
}

/** What to actually hand `runContained`: either the unchanged `"allowed"`
 * network and env (nothing in `env` carries the real worker token - a
 * test's own fake env, most of this file's fast tests), or - whenever
 * `HOST_TOKEN_VAR` is present, which it always is for a real worker
 * (`defaultBrainAdapter` forwards it before any call) - the relay-backed
 * replacement from `connectThroughRelay` above, with `HOST_TOKEN_VAR`
 * itself stripped out of what reaches the container. */
async function prepareNetwork(
  env: Record<string, string> | undefined
): Promise<{ network: "allowed" | { isolatedNetwork: string }; env?: Record<string, string>; teardown: () => Promise<void> }> {
  const realToken = env?.[HOST_TOKEN_VAR];
  if (!realToken) return { network: "allowed", env, teardown: async () => {} };

  const relayed = await connectThroughRelay(realToken);
  const { [HOST_TOKEN_VAR]: _dropped, ...rest } = env;
  return { network: relayed.network, env: { ...rest, ...relayed.env }, teardown: relayed.teardown };
}

// Built from src/brain/adapters/docker/Dockerfile (the build command,
// with the Dockerfile-hash stamp `fabrica doctor` checks, is in that
// file; once, before this adapter's default image can be found) - see that
// file and claude-code.md's "Process containment" section for what it
// installs and why a fresh build has nothing authenticated yet.
export const DEFAULT_IMAGE = "fabrica-claude-code:latest";

/** The write-up work() asks for, as a JSON Schema passed to
 * `--json-schema`. The CLI holds the model's final answer to it and
 * returns the object on the result line's `structured_output` (verified
 * on 2.1.222), so no write-up is ever parsed out of prose. */
export const WRITEUP_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...WRITEUP_FIELDS],
  properties: {
    title: { type: "string", minLength: 1, maxLength: WRITEUP_TITLE_MAX_LENGTH },
    what: { type: "string", minLength: 1 },
    why: { type: "string", minLength: 1 },
    how: { type: "string", minLength: 1 },
    confidence: { type: "number", minimum: 0, maximum: 100 },
    assumptions: { type: "string", minLength: 1 },
    expectedOutcomes: { type: "string", minLength: 1 },
    deviations: { type: "string", minLength: 1 },
  },
};

export interface ClaudeCodeAdapterOptions {
  /** Value for `claude --model` (an alias like "sonnet" or a full model
   * id like "claude-sonnet-5"). Omitted means the CLI's own configured
   * default runs, and `Brain.model` reports that honestly as "default"
   * rather than guessing which model that resolves to. */
  model?: string;
  /** The command to run inside the container - override for tests that
   * stand in a controllable fake binary, reachable at a path under
   * `workdir` (the only thing the container can see). Defaults to
   * "claude", resolved via the image's own PATH. */
  binPath?: string;
  /** The Docker image `runContained` runs `binPath` inside. Defaults to
   * `DEFAULT_IMAGE`; overridable for tests that need a different
   * image (e.g. one with Node, to run a fake CLI script). */
  image?: string;
  /** The exact environment variables the contained process receives,
   * passed through to `runContained`'s allowlist - mostly unchanged.
   * Omitted means the container gets only what its own image defines -
   * nothing from this process's own environment (API keys, tokens) leaks
   * in. The one key treated specially is `HOST_TOKEN_VAR`
   * (`CLAUDE_CODE_OAUTH_TOKEN`, what `defaultBrainAdapter` forwards the
   * real worker token under): when present, it never reaches the
   * container as-is - `prepareNetwork` strips it and substitutes a
   * relay-backed `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` pair instead
   * (see `connectThroughRelay`), so the box only ever holds a per-call
   * placeholder for its credential. */
  env?: Record<string, string>;
  /** ask()'s scratch workdir override - same purpose as `binPath` above:
   * lets a test seed a directory with the fake CLI script before calling
   * ask(), since ask() otherwise mints and destroys its own fresh
   * tmpdir per call (there being no real project to mount for a call
   * that runs before any ProductionLine exists). Leave it out in real
   * use. */
  askScratchDir?: string;
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
  /** --json-schema's answer, already an object (verified on 2.1.222). */
  structured_output?: unknown;
  /** "error_max_budget_usd" when --max-budget-usd ran out. */
  subtype?: string;
  errors?: string[];
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
    // TTY to answer the prompt, so the tool can only refuse). This
    // adapter always runs through src/containment/ (Docker), so the
    // "full OS account access" cost this flag would otherwise carry is
    // already contained to `workdir` - see this file's own "Process
    // containment" section.
    "--permission-mode",
    "bypassPermissions",
    "--json-schema",
    JSON.stringify(WRITEUP_JSON_SCHEMA),
  ];
  if (workOpts?.session) args.push("--resume", workOpts.session);
  if (opts.model) args.push("--model", opts.model);
  // claude's own --effort flag already implements the Brain contract's
  // "ignore what you don't recognize, never fail" rule: an unrecognized
  // value logs a stderr warning and falls back to the default effort,
  // exit code 0 (verified against the real binary). Nothing extra to
  // enforce here.
  if (workOpts?.reasoningEffort) args.push("--effort", workOpts.reasoningEffort);
  // Rule 10's per-task cap as a hint (BrainWorkOptions.maxSpendUsd). The
  // real binary checks it after each turn, not during one, so a call can
  // still finish a little past it - the Foreman's own check after the
  // attempt is the guaranteed stop.
  if (workOpts?.maxSpendUsd !== undefined) args.push("--max-budget-usd", String(workOpts.maxSpendUsd));
  return args;
}

// SPEC.md step 2, "Clarify-or-proceed" (issue #8): the prompt this
// adapter's ask() sends. Instructs the model to draw the line this issue
// itself draws - materially ambiguous means an ambiguity that would
// change what gets built, not one a reasonable person would resolve the
// same way every time - and to answer in a fixed, parseable shape rather
// than free prose.
export function buildAskPrompt(brief: string): string {
  return (
    "You are deciding whether a task description is materially ambiguous " +
    "before any work starts on it - ambiguous in a way that would change " +
    "what actually gets built, not something a reasonable person would " +
    "fill in the same way every time. If it is materially ambiguous, " +
    "write the numbered questions whose answers would change what gets " +
    "built. If it is already clear enough to proceed, ask nothing. " +
    "The project's files are not present at this step on purpose - they " +
    "will be there when work starts - so ask only about what the Client " +
    "wants, never about where the code is.\n\n" +
    "Respond with ONLY a JSON object, no other text before or after it, " +
    "in exactly this shape:\n" +
    '{"questions": ["question one", "question two"]}\n' +
    "or, if nothing needs asking:\n" +
    '{"questions": []}\n\n' +
    `Task:\n${brief}`
  );
}

function buildAskArgs(prompt: string, opts: ClaudeCodeAdapterOptions): string[] {
  // No --permission-mode bypassPermissions here: this call is asked to
  // think and answer, never to edit anything, so it needs none of the
  // tool access work() has to unlock. No --resume either - ask() always
  // starts a fresh, throwaway session; nothing about it is meant to
  // continue into work()'s own session (see this file's own doc for why
  // that wouldn't even resolve - a session only resumes from the cwd it
  // was born in, and ask() and work() never share one).
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

/** The model is asked for bare JSON but may still wrap it in a fenced
 * code block despite the instruction - stripped defensively before
 * parsing. Anything that still isn't valid JSON, or isn't shaped like
 * BrainAskResult, is treated as "nothing to ask" rather than failing the
 * task over a formatting slip - the same defensive spirit as
 * parseLines() below, and matching this issue's own stated bias toward
 * not over-asking when uncertain. */
function parseAskResult(text: string): BrainAskResult {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced ? fenced[1] : text.trim();
  try {
    const parsed: unknown = JSON.parse(candidate);
    const questions = (parsed as { questions?: unknown } | null)?.questions;
    if (Array.isArray(questions)) {
      // Blank or non-string entries are dropped, not treated as grounds
      // to throw the whole list away - one stray element must not lose a
      // real question. registerAndAsk filters the same way.
      const kept = questions.filter((q): q is string => typeof q === "string" && q.trim().length > 0);
      return kept.length > 0 ? { questions: kept } : {};
    }
  } catch {
    // Not parseable JSON - fall through to "nothing to ask".
  }
  return {};
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

// One stream-json line, mapped to zero or more transcript entries - the
// unit work() maps live, the instant each line's newline lands, rather
// than waiting for the whole call to finish (issue #70).
//
// "system" (hook chatter, session init) and "rate_limit_event" are about
// the harness this binary happens to be running inside, not about the
// work it did on the brief - left out of what a human reviewing the
// worker's transcript needs to see. "assistant" carries what the worker
// thought and did; "user" carries a tool's result fed back to it - both
// are part of the real record of the work.
function mapLineToEntries(line: ClaudeStreamLine): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const now = () => new Date().toISOString();

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
  return entries;
}

/** Turns a stream of raw stdout chunks into complete, trimmed lines,
 * calling `onLine` the instant each one's trailing newline arrives - a
 * line split across two chunks (any chunk boundary that isn't also a
 * newline) is held until the rest of it lands, same as parseLines()
 * sees it once the whole output has arrived. */
function lineFeeder(onLine: (line: string) => void): (chunk: string) => void {
  let buffered = "";
  return (chunk: string) => {
    buffered += chunk;
    let newlineAt = buffered.indexOf("\n");
    while (newlineAt !== -1) {
      const line = buffered.slice(0, newlineAt).trim();
      buffered = buffered.slice(newlineAt + 1);
      if (line) onLine(line);
      newlineAt = buffered.indexOf("\n");
    }
  };
}

// workdir is a ProductionLine worktree, so git needs its real project's
// shared .git mounted back in (read-only) to work at all inside the
// container - see src/line/worktree-git.ts and this file's "Process
// containment" section for why. The shared .git's own `config` is the
// one file in it that can carry a credential (a remote URL can embed
// one), so a sanitized throwaway copy forwarding only the [core]
// section plus individually allowlisted, credential-free [extensions]
// keys - an allowlist, not a denylist - is shadow-mounted over the
// real one - status/log/diff still work, but no remote URL, embedded
// credential, credential helper, or other config-borne credential
// mechanism is readable inside the container. There is no no-git
// fallback: a workdir the mounts can't be resolved for - no git
// repository at all, a corrupted worktree, an unsanitizable config -
// refuses the run with the LineError saying what to fix, rather than
// running the Worker with git silently unavailable (a Worker needs
// git constantly, so "no git, no signal" is a worse failure than an
// upfront refusal with an obvious remedy).
export function resolveGitMounts(workdir: string): { readOnlyMounts: ReadOnlyMount[]; sanitizedConfigDir: string } {
  const commonGitDir = resolveCommonGitDir(workdir);
  const sanitizedConfig = writeSanitizedGitConfig(commonGitDir);
  return {
    readOnlyMounts: [commonGitDir, { source: sanitizedConfig, target: join(commonGitDir, "config") }],
    sanitizedConfigDir: dirname(sanitizedConfig),
  };
}

export function claudeCodeAdapter(opts: ClaudeCodeAdapterOptions = {}): Brain {
  const bin = opts.binPath ?? "claude";
  const image = opts.image ?? DEFAULT_IMAGE;

  return {
    name: "claude-code",
    model: opts.model ?? "default",

    async ask(brief: string): Promise<BrainAskResult> {
      // No ProductionLine exists yet at this point (SPEC.md step 2 runs
      // before step 3's isolation) - a fresh, empty scratch dir stands in
      // for workdir instead of any real project, and nothing else is
      // mounted (no readOnlyMounts: there is no git repository to reach
      // here at all). CONTRACT rule 1 holds by construction: this call
      // has no path to anything of the Client's to touch.
      const ownScratchDir = opts.askScratchDir === undefined;
      const scratchDir = opts.askScratchDir ?? mkdtempSync(join(realpathSync(tmpdir()), "fabrica-ask-"));
      // Without a mounted home, a `--user <uid>` container has no
      // /etc/passwd entry for that uid and $HOME resolves to "/", which
      // is read-only - the CLI writes its own startup config/state under
      // $HOME and would die there (see src/containment/README.md's
      // "$HOME" note). work() persists its home across calls so a
      // --resume finds the last session; ask() never resumes, so this
      // one is throwaway and goes away with the call.
      const homeDir = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-ask-home-"));
      const args = buildAskArgs(buildAskPrompt(brief), opts);

      let stdout: string;
      let stderr: string;
      let exitCode: number | null;
      // Whenever opts.env carries the real worker token (every real
      // call - defaultBrainAdapter forwards it before this runs), this
      // box joins a fresh isolated network instead of the open one, and
      // the token never reaches it: see prepareNetwork/connectThroughRelay.
      let prepared: Awaited<ReturnType<typeof prepareNetwork>> | undefined;
      try {
        prepared = await prepareNetwork(opts.env);
        ({ stdout, stderr, exitCode } = await runContained(bin, args, {
          workdir: scratchDir,
          network: prepared.network,
          image,
          env: prepared.env,
          homeDir,
        }));
      } catch (err) {
        if (err instanceof ContainmentError || err instanceof RelayError) {
          throw new ClaudeCodeError(
            "spawn-failed",
            `could not run "${bin}" contained (image ${image}) to assess ambiguity: ${err.message}`
          );
        }
        throw err;
      } finally {
        if (ownScratchDir) rmSync(scratchDir, { recursive: true, force: true });
        rmSync(homeDir, { recursive: true, force: true });
        await prepared?.teardown();
      }

      const lines = parseLines(stdout);
      const result = [...lines].reverse().find((l) => l.type === "result");

      // The budget running out is the cap working, not the brain failing
      // (verified on 2.1.295: exit 1, is_error true, subtype
      // "error_max_budget_usd", the real cost on the result line). It
      // returns normally so the spend reaches the receipt and the Foreman
      // can stop the task honestly - a throw here would lose the money.
      const budgetExhausted = result?.subtype === "error_max_budget_usd";

      if (!budgetExhausted && (exitCode !== 0 || result?.is_error)) {
        const detail = result?.result ?? (stderr.trim() || `exit code ${exitCode}`);
        const status = result?.api_error_status ? ` (api_error_status ${result.api_error_status})` : "";
        throw new ClaudeCodeError("cli-error", `${detail}${status}`);
      }

      // Rule 10: the clarifying step's own cost; null when the CLI gave none.
      const costUsd = typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null;
      return { ...(result?.result ? parseAskResult(result.result) : {}), costUsd };
    },

    async work(brief: string, workdir: string, workOpts?: BrainWorkOptions): Promise<BrainWorkResult> {
      const args = buildArgs(brief, opts, workOpts);

      const { readOnlyMounts, sanitizedConfigDir } = resolveGitMounts(workdir);

      // A sibling of workdir, named from workdir's own resolved path
      // (the same realpath runContained mounts, so two spellings of one
      // workdir - macOS's /tmp vs /private/tmp - share one session dir)
      // rather than assumed to sit under some recordHome/tasks/<id>/
      // layout, so this needs nothing beyond what work() already has.
      // Persists this task's $HOME (session state under it, for a warm
      // --resume) across every runContained call for this same task,
      // without which a fresh --rm container each call would never find
      // the last one's session (SPEC.md: a retry is a correction into
      // the same session, never a cold restart) - see this file's
      // "Process containment" section. resolveGitMounts above already
      // proved workdir is a readable directory, so realpathSync here
      // cannot fail.
      const realWorkdir = realpathSync(workdir);
      const sessionDir = `${realWorkdir}.fabrica-session`;
      mkdirSync(sessionDir, { recursive: true });

      // Mapped the moment each line's newline lands, not once the whole
      // call resolves (issue #70): `entries` ends up holding exactly what
      // the old toTranscript(parseLines(stdout)) post-hoc pass used to
      // build, in the same order, since both walk the same stream of
      // lines - this just does it as they arrive instead of afterward.
      // emitLiveTranscriptEntry is this adapter's own choice to make;
      // nothing about Brain.work's contract changes - a caller that
      // never registered a listener for this workdir sees no difference.
      const entries: TranscriptEntry[] = [];
      const onStdout = lineFeeder((raw) => {
        let parsed: ClaudeStreamLine;
        try {
          parsed = JSON.parse(raw) as ClaudeStreamLine;
        } catch {
          // A non-JSON line never happens in stream-json output; skip
          // defensively, same as parseLines() below (which still
          // re-parses the complete buffered output afterward to find the
          // terminal "result" line - only knowable once the process exits).
          return;
        }
        for (const entry of mapLineToEntries(parsed)) {
          entries.push(entry);
          emitLiveTranscriptEntry(workdir, entry);
        }
      });

      let stdout: string;
      let stderr: string;
      let exitCode: number | null;
      // Network was unconditionally "allowed" before issue #186's second
      // half: the CLI has to reach its own API to do anything at all.
      // Now, whenever opts.env carries the real worker token (every real
      // call), that reach is narrowed to a fresh isolated network with a
      // relay as its only route out - see prepareNetwork/connectThroughRelay.
      // A caller with no real token to protect (this file's own fast
      // tests, which pass a fake env) keeps the old "allowed" network.
      let prepared: Awaited<ReturnType<typeof prepareNetwork>> | undefined;
      try {
        prepared = await prepareNetwork(opts.env);
        ({ stdout, stderr, exitCode } = await runContained(bin, args, {
          workdir,
          network: prepared.network,
          image,
          env: prepared.env,
          readOnlyMounts,
          homeDir: sessionDir,
          onStdout,
        }));
      } catch (err) {
        if (err instanceof ContainmentError || err instanceof RelayError) {
          throw new ClaudeCodeError(
            "spawn-failed",
            `could not run "${bin}" contained (image ${image}) in ${workdir}: ${err.message}`
          );
        }
        throw err;
      } finally {
        rmSync(sanitizedConfigDir, { recursive: true, force: true });
        await prepared?.teardown();
      }

      const lines = parseLines(stdout);
      const result = [...lines].reverse().find((l) => l.type === "result");

      // The budget running out is the cap working, not the brain failing
      // (verified on 2.1.295: exit 1, is_error true, subtype
      // "error_max_budget_usd", the real cost on the result line). It
      // returns normally so the spend reaches the receipt and the Foreman
      // can stop the task honestly - a throw here would lose the money.
      const budgetExhausted = result?.subtype === "error_max_budget_usd";
      // The CLI giving up on matching the write-up schema is a missing
      // write-up, not a failed call: the work and its spend are real, and
      // the Foreman turns the absent write-up into a red attempt.
      const writeupGaveUp = result?.subtype === "error_max_structured_output_retries";

      if (!budgetExhausted && !writeupGaveUp && (exitCode !== 0 || result?.is_error)) {
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

      // budget-exhausted and usage (below) are synthesized from the
      // terminal "result" line, not mapped from a stream-json block -
      // the earliest either can be known is right here, once the
      // process has actually exited, so there is no earlier "live"
      // moment for them to arrive at. They reach the record through
      // runAttempts' own catch-up pass for whatever a work() call
      // didn't already deliver live (src/foreman/attempts.ts), not
      // through emitLiveTranscriptEntry.
      const transcript = entries;
      if (budgetExhausted) {
        transcript.push({
          occurredAt: new Date().toISOString(),
          kind: "budget-exhausted",
          text: result.errors?.join("; ") || "reached the maximum budget for this call",
        });
      }
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
          // Issue #188: this account is a flat-rate subscription (see
          // claude-code.md's "Cost, duration, and token usage" section),
          // so the figure above is notional, not billed money - marked
          // here so the caps bind on real, metered spend only.
          costBasis: "subscription-estimate",
        }),
      });

      const writeup = writeupFrom(result.structured_output);
      return {
        transcript,
        session: result.session_id,
        ...(writeup ? { writeup } : {}),
      };
    },
  };
}

/** Self-tests a project with no Inspector (issue #64, mode b): runs its
 * check command once inside this adapter's own worker box - the same
 * image, the same workdir and read-only git mounts, and the same network
 * the worker itself had - never on the host. No credential and no session
 * home go in: the check needs neither. A box that cannot start is
 * reported as not run, so it is never mistaken for a red check. */
export function claudeCodeCheckBox(opts: { image?: string } = {}): CheckBox {
  const image = opts.image ?? DEFAULT_IMAGE;
  return async (workdir, command) => {
    let mounts: { readOnlyMounts: ReadOnlyMount[]; sanitizedConfigDir: string };
    try {
      mounts = resolveGitMounts(workdir);
    } catch (err) {
      return { ran: false, reason: `could not prepare the worker's box: ${err instanceof Error ? err.message : String(err)}` };
    }
    try {
      const { stdout, stderr, exitCode } = await runContained("sh", ["-c", command], {
        workdir,
        network: "allowed",
        image,
        readOnlyMounts: mounts.readOnlyMounts,
      });
      return { ran: true, exitCode: exitCode ?? -1, output: [stdout, stderr].filter((s) => s.length > 0).join("\n") };
    } catch (err) {
      if (err instanceof ContainmentError) {
        return { ran: false, reason: `could not start the worker's box (image ${image}): ${err.message}` };
      }
      throw err;
    } finally {
      rmSync(mounts.sanitizedConfigDir, { recursive: true, force: true });
    }
  };
}

/** The result line's structured_output as a write-up, when it has the
 * shape asked for: an object whose string fields are all strings and
 * whose `confidence` is a number. Anything else is no write-up - the
 * Foreman checks the contents (empty fields, title length, confidence
 * range) and names what is wrong. */
function writeupFrom(value: unknown): WorkerWriteup | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (!WRITEUP_STRING_FIELDS.every((field) => typeof record[field] === "string")) return undefined;
  if (typeof record.confidence !== "number") return undefined;
  return {
    title: record.title as string,
    what: record.what as string,
    why: record.why as string,
    how: record.how as string,
    confidence: record.confidence,
    assumptions: record.assumptions as string,
    expectedOutcomes: record.expectedOutcomes as string,
    deviations: record.deviations as string,
  };
}
