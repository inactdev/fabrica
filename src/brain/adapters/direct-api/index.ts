// Direct-API adapters (adapters/README.md's second family, opened for the
// first time here - ROADMAP.md Phase 3: "per-token API pipes stay closed
// unless you deliberately open one, behind a cap that can be zero").
// Unlike the reference CLI adapter, there is no existing coding-agent
// binary to wrap: the whole agent loop - reading files, writing them,
// running commands, and deciding when it's done - is this file's own
// responsibility. That loop (worker-loop.mjs) runs entirely inside ONE
// `runContained` call per `ask()`/`work()`, the same "one process, one
// container" shape the reference adapter uses, rather than splitting the
// loop (host-side) from each individual tool call (its own container):
// the model call itself is part of the Worker's own work and belongs
// inside the sandbox too, not just its file/shell side effects. See
// direct-api.md for the full design writeup and what was verified where.
//
// Both `openRouterAdapter` and `ollamaAdapter` set `requiresPerTaskCap:
// true` (contract/surface.ts's `Brain.requiresPerTaskCap`, enforced by
// `src/foreman/caps.ts`'s `requireCapForBrain`): a direct, metered API has
// no flat-rate subscription ceiling to fall back on the way the reference
// CLI adapter's account does, so this family must not run a single task
// without `[caps].perTaskUsd` configured in projects.toml - the Client
// ruling behind issue #200. Ollama costs nothing per call, but the same
// rule applies uniformly to both backends by that ruling: one cap,
// whichever metered model actually runs.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Brain, BrainAskResult, BrainWorkOptions, BrainWorkResult, TranscriptEntry, WorkerWriteup } from "../../../../contract/surface.ts";
import { ContainmentError, runContained } from "../../../containment/index.ts";
import { resolveGitMounts, DEFAULT_IMAGE } from "../claude-code.ts";
import { emitLiveTranscriptEntry } from "../../live-transcript.ts";

export type DirectApiErrorCode = "spawn-failed" | "script-failed";

export class DirectApiError extends Error {
  readonly code: DirectApiErrorCode;

  constructor(code: DirectApiErrorCode, message: string) {
    super(message);
    this.name = "DirectApiError";
    this.code = code;
  }
}

// The script's own file, read from disk and shadow-mounted into the
// container at a fixed path (never passed as a `node -e` string): a real,
// independently-runnable file is what worker-loop.test.ts exercises
// directly with a plain `node`, with nothing lost between what's tested
// and what actually runs here.
const WORKER_LOOP_SCRIPT = fileURLToPath(new URL("./worker-loop.mjs", import.meta.url));
const CONTAINER_SCRIPT_PATH = "/opt/fabrica/direct-api-worker-loop.mjs";

type DirectApiBackendName = "openrouter" | "ollama";

interface DirectApiAdapterOptions {
  backendName: DirectApiBackendName;
  model: string;
  baseUrl: string;
  apiKey?: string;
  image?: string;
}

interface ScriptEntryLine {
  type: "entry";
  entry: TranscriptEntry;
}
interface ScriptAskResultLine {
  type: "result";
  mode: "ask";
  questions: string[];
  costUsd: number | null;
}
interface ScriptWorkResultLine {
  type: "result";
  mode: "work";
  writeup: Record<string, string> | null;
  gateChanges: string | null;
  session: string;
}
type ScriptLine = ScriptEntryLine | ScriptAskResultLine | ScriptWorkResultLine;

function parseScriptLines(stdout: string): ScriptLine[] {
  const lines: ScriptLine[] = [];
  for (const raw of stdout.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as ScriptLine);
    } catch {
      // A non-JSON line never happens in this script's own output; skip
      // defensively rather than fail a whole call over one stray line.
    }
  }
  return lines;
}

/** worker-loop.mjs's own WRITEUP_FIELDS guarantee every key is present
 * as a string (possibly empty) whenever it emits a non-null `writeup` at
 * all - the Foreman's own pr-body.ts is what actually checks for empty
 * fields and an over-long title, the same as it does for every other
 * adapter's write-up, so this just gives the shape its proper type
 * rather than re-validating it here too. */
function toWorkerWriteup(record: Record<string, string>): WorkerWriteup {
  return {
    title: record.title ?? "",
    what: record.what ?? "",
    why: record.why ?? "",
    how: record.how ?? "",
    deviations: record.deviations ?? "",
  };
}

function scriptInputEnv(input: Record<string, unknown>, apiKey: string | undefined): Record<string, string> {
  return {
    DIRECT_API_INPUT: JSON.stringify(input),
    ...(apiKey ? { DIRECT_API_KEY: apiKey } : {}),
  };
}

function createDirectApiAdapter(opts: DirectApiAdapterOptions): Brain {
  const image = opts.image ?? DEFAULT_IMAGE;

  return {
    name: opts.backendName,
    model: opts.model,
    requiresPerTaskCap: true,

    async ask(brief: string): Promise<BrainAskResult> {
      // No ProductionLine exists yet at this step (SPEC.md step 2) - a
      // throwaway scratch dir stands in for workdir, same reasoning as
      // the reference adapter's own ask(): CONTRACT rule 1 holds here by
      // construction, since this call has no path to anything of the
      // Client's to touch.
      const scratchDir = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-direct-api-ask-"));
      const homeDir = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-direct-api-ask-home-"));
      let stdout: string;
      let stderr: string;
      let exitCode: number | null;
      try {
        ({ stdout, stderr, exitCode } = await runContained("node", [CONTAINER_SCRIPT_PATH], {
          workdir: scratchDir,
          // Deliberately allowed, not left open by accident: this call's
          // only job is to reach the configured model API.
          network: "allowed",
          image,
          env: scriptInputEnv(
            { mode: "ask", brief, model: opts.model, baseUrl: opts.baseUrl, backendName: opts.backendName },
            opts.apiKey
          ),
          homeDir,
          readOnlyMounts: [{ source: WORKER_LOOP_SCRIPT, target: CONTAINER_SCRIPT_PATH }],
        }));
      } catch (err) {
        if (err instanceof ContainmentError) {
          throw new DirectApiError("spawn-failed", `could not run the direct-API worker loop contained (image ${image}): ${err.message}`);
        }
        throw err;
      } finally {
        rmSync(scratchDir, { recursive: true, force: true });
        rmSync(homeDir, { recursive: true, force: true });
      }

      const lines = parseScriptLines(stdout);
      const result = [...lines].reverse().find((l): l is ScriptAskResultLine => l.type === "result" && l.mode === "ask");
      if (exitCode !== 0 || !result) {
        throw new DirectApiError("script-failed", stderr.trim() || `exit code ${exitCode}`);
      }
      return { questions: result.questions, costUsd: result.costUsd };
    },

    async work(brief: string, workdir: string, workOpts?: BrainWorkOptions): Promise<BrainWorkResult> {
      const { readOnlyMounts, sanitizedConfigDir } = resolveGitMounts(workdir);

      // Same persistence shape as the reference CLI adapter's own
      // $HOME-per-workdir session dir (claude-code.ts), under its own
      // suffix so the two adapters' state never collides if ever pointed
      // at the same workdir: the full OpenAI-style message history lives
      // under $HOME (worker-loop.mjs's SESSION_FILE_NAME), which is what
      // actually makes a warm resume possible across separate
      // `runContained` calls - each one is otherwise a fresh, empty
      // container.
      const realWorkdir = realpathSync(workdir);
      const sessionDir = `${realWorkdir}.fabrica-direct-api-session`;
      mkdirSync(sessionDir, { recursive: true });

      const entries: TranscriptEntry[] = [];
      let buffered = "";
      const onStdout = (chunk: string) => {
        buffered += chunk;
        let newlineAt = buffered.indexOf("\n");
        while (newlineAt !== -1) {
          const raw = buffered.slice(0, newlineAt).trim();
          buffered = buffered.slice(newlineAt + 1);
          if (raw) {
            try {
              const parsed = JSON.parse(raw) as ScriptLine;
              if (parsed.type === "entry") {
                entries.push(parsed.entry);
                emitLiveTranscriptEntry(workdir, parsed.entry);
              }
            } catch {
              // Skipped defensively, same as the final reparse below.
            }
          }
          newlineAt = buffered.indexOf("\n");
        }
      };

      let stdout: string;
      let stderr: string;
      let exitCode: number | null;
      try {
        ({ stdout, stderr, exitCode } = await runContained("node", [CONTAINER_SCRIPT_PATH], {
          workdir,
          // Deliberately allowed: the model call this loop makes every
          // turn is the whole reason this adapter has to reach a
          // network at all. workdir itself is what's actually confined,
          // plus read-only git history via readOnlyMounts, same as the
          // reference adapter.
          network: "allowed",
          image,
          env: scriptInputEnv(
            {
              mode: "work",
              brief,
              model: opts.model,
              baseUrl: opts.baseUrl,
              backendName: opts.backendName,
              maxSpendUsd: workOpts?.maxSpendUsd ?? null,
              hasSession: workOpts?.session !== undefined,
            },
            opts.apiKey
          ),
          readOnlyMounts: [...readOnlyMounts, { source: WORKER_LOOP_SCRIPT, target: CONTAINER_SCRIPT_PATH }],
          homeDir: sessionDir,
          onStdout,
        }));
      } catch (err) {
        if (err instanceof ContainmentError) {
          throw new DirectApiError("spawn-failed", `could not run the direct-API worker loop contained (image ${image}) in ${workdir}: ${err.message}`);
        }
        throw err;
      } finally {
        rmSync(sanitizedConfigDir, { recursive: true, force: true });
      }

      // Reparsed from the complete, buffered stdout rather than relying
      // only on what the live feeder above already split into lines -
      // same belt-and-suspenders the reference adapter uses, and the one
      // place the final "result" line (unknowable until the process
      // exits) is actually found.
      const lines = parseScriptLines(stdout);
      const result = [...lines].reverse().find((l): l is ScriptWorkResultLine => l.type === "result" && l.mode === "work");
      if (exitCode !== 0 || !result) {
        throw new DirectApiError("script-failed", stderr.trim() || `exit code ${exitCode}`);
      }

      return {
        transcript: entries,
        session: result.session,
        ...(result.gateChanges ? { gateChanges: result.gateChanges } : {}),
        ...(result.writeup ? { writeup: toWorkerWriteup(result.writeup) } : {}),
      };
    },
  };
}

/** `host:port` (Ollama's own `OLLAMA_HOST` convention) or a full
 * `http(s)://...` URL, normalized to the base URL Ollama's
 * OpenAI-compatible surface wants (`<base>/chat/completions`). */
export function normalizeOllamaBaseUrl(host: string): string {
  const withScheme = /^https?:\/\//.test(host) ? host : `http://${host}`;
  const withoutTrailingSlash = withScheme.replace(/\/+$/, "");
  return withoutTrailingSlash.endsWith("/v1") ? withoutTrailingSlash : `${withoutTrailingSlash}/v1`;
}

export interface OpenRouterAdapterOptions {
  /** OpenRouter's own model id (e.g. "meta-llama/llama-3.3-70b-instruct")
   * - a required setting, never hardcoded here (issue #200's Client
   * ruling): the cheapest currently-listed open-weight model is a choice
   * for whoever runs this, made by reading OpenRouter's own `/models`
   * pricing at the time, not a default this file bakes in and lets go
   * stale. */
  model: string;
  /** Defaults to `OPENROUTER_BASE_URL`, then `https://openrouter.ai/api/v1`
   * - overridable so a test can point this at a fake server. */
  baseUrl?: string;
  /** Defaults to `OPENROUTER_API_KEY`. */
  apiKey?: string;
  image?: string;
}

/** OpenRouter: one key for many hosted models (issue #200). Network
 * reaches the public internet. */
export function openRouterAdapter(opts: OpenRouterAdapterOptions): Brain {
  return createDirectApiAdapter({
    backendName: "openrouter",
    model: opts.model,
    baseUrl: opts.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKey: opts.apiKey ?? process.env.OPENROUTER_API_KEY,
    image: opts.image,
  });
}

export interface OllamaAdapterOptions {
  /** The local model's own Ollama tag (e.g. "qwen2.5-coder:7b") - a
   * required setting for the same reason OpenRouter's `model` is: pick
   * one that actually fits the machine running it, never assumed here. */
  model: string;
  /** Defaults to `OLLAMA_HOST` (Ollama's own env var), then
   * `host.docker.internal:11434` - deliberately NOT Ollama's own
   * documented default of `127.0.0.1:11434`: this call runs inside a
   * container, where `127.0.0.1` means the container itself, not the
   * host running Ollama. `host.docker.internal` is what
   * `src/containment`'s `--add-host` flag makes reachable from in
   * there, on Docker Desktop and native Linux Docker Engine alike. */
  host?: string;
  image?: string;
}

/** A local Ollama server, reached from inside the sandboxed container at
 * `host.docker.internal` (issue #200). Never billed, but still held to
 * `requiresPerTaskCap` by the same Client ruling that covers
 * `openRouterAdapter` - one cap, whichever metered model actually runs. */
export function ollamaAdapter(opts: OllamaAdapterOptions): Brain {
  return createDirectApiAdapter({
    backendName: "ollama",
    model: opts.model,
    baseUrl: normalizeOllamaBaseUrl(opts.host ?? process.env.OLLAMA_HOST ?? "host.docker.internal:11434"),
    image: opts.image,
  });
}
