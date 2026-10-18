// A direct-API adapter (issue #200): one adapter that speaks an
// OpenAI-compatible chat-completions API and runs the agent loop itself
// inside the worker's box. The second of the two families
// adapters/README.md describes, and the asymmetry that file warns about
// is real - a CLI adapter delegates the agent loop to a program that
// already exists, while this one carries that loop as its own code
// (openai-agent/, run inside the box, never on the host).
//
// Three things make it the shape issue #200 asked for:
//
// 1. **It refuses to run without a cap.** `work()` throws before any
//    container starts, naming the exact setting to add, whenever
//    `BrainWorkOptions.maxSpendUsd` is absent - which is exactly when the
//    project has no `[caps].perTaskUsd` (src/foreman/attempts.ts only
//    passes the hint when that cap is set). Per-token API pipes "stay
//    closed unless you deliberately open one, behind a cap that can be
//    zero" (ROADMAP.md, Phase 3), and the August 2026 ruling the issue
//    cites makes that refusal this adapter's job. The in-box agent checks
//    it again (openai-agent/main.mjs), so no way of starting it can spend
//    uncapped money.
// 2. **It is model-agnostic and hot-swappable.** Nothing here names a
//    model: the vendor (the default base URL) and the credential's
//    variable name are this adapter's to choose, and which model runs is
//    one setting (`model`), swappable without touching code.
// 3. **Its receipts are real, metered dollars.** Cost is never computed
//    from a price table in this repo - a per-million-token price that
//    went stale would report invented money as `costBasis: "metered"`.
//    The default target reports the charge for each call on its own usage
//    object, and that figure is what lands on the receipt (see
//    openai-agent/types.ts's `CostSource` for the only other honest
//    option: a server the Client runs themselves, which bills nothing).
//
// Everything about the two targets below was read from the vendors' own
// current documentation on 2026-10-17 (CONTRACT rule 11's standing
// question: never guess a command or API shape) - see
// openai-compatible.md for the exact documents, the quotes, and the one
// thing that could not be verified from inside a worker box: a live call
// to either endpoint, which needs a credential and egress this box does
// not have.

import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Brain, BrainAskResult, BrainWorkOptions, BrainWorkResult, TranscriptEntry, WorkerWriteup } from "../types.ts";
import { WRITEUP_OPTIONAL_STRING_FIELDS, WRITEUP_STRING_FIELDS, WRITEUP_TITLE_MAX_LENGTH } from "../writeup.ts";
import { ContainmentError, createEgressNetwork, createIsolatedNetwork, removeEgressNetwork, removeIsolatedNetwork, runContained } from "../../containment/index.ts";
import type { ReadOnlyMount } from "../../containment/index.ts";
import { emitLiveTranscriptEntry } from "../live-transcript.ts";
import { GITHUB_HOSTS, RelayError, startContainerizedRelay } from "../../relay/index.ts";
import type { GatewayTarget } from "../../relay/index.ts";
// The reference adapter's own proven recipe for making git work inside a
// box (read-only shared .git, with a sanitized config shadow-mounted over
// the real one). Imported rather than copied, and deliberately not
// extracted into a third module: that would mean editing the reference
// adapter, whose own tests need Docker and a credential, for no change in
// behaviour. Both adapters mount git identically because the requirement
// is identical.
import { buildAskPrompt, DEFAULT_IMAGE, resolveGitMounts } from "./claude-code.ts";
import type { AgentJob, AgentLine, AgentResult, CostSource } from "./openai-agent/types.ts";

export type OpenAiCompatibleErrorCode =
  /** `work()` was called with no per-call spending cap (issue #200). */
  | "no-cap"
  | "invalid-base-url"
  | "spawn-failed"
  /** The box ran but printed no final result line. */
  | "unparseable-output"
  /** The agent reported a failure before it ever reached the model - a
   * rejected credential, an unknown model, an unreachable endpoint. */
  | "api-unreachable";

export class OpenAiCompatibleError extends Error {
  readonly code: OpenAiCompatibleErrorCode;

  constructor(code: OpenAiCompatibleErrorCode, message: string) {
    super(message);
    this.name = "OpenAiCompatibleError";
    this.code = code;
  }
}

/** The vendor this adapter names for itself (the Client names a model,
 * not a vendor - that is this adapter's choice to make, and
 * hot-swappable through `baseUrl` for anyone who wants a different one).
 * OpenRouter, because it is the one OpenAI-compatible gateway whose own
 * documentation promises both halves this adapter needs: open-weight
 * models from every vendor behind a single key and a single model string
 * - "best result for the money" is a choice the Client can make per task
 * rather than per account - and the real charge for each call returned
 * on the response itself, so a receipt never needs a price table.
 * `https://openrouter.ai/api/v1`, Bearer-token authenticated
 * (OpenRouterTeam/docs, api_reference/authentication.mdx, read
 * 2026-10-17). */
export const HOSTED_BASE_URL = "https://openrouter.ai/api/v1";
export const HOSTED_CREDENTIAL_VAR = "OPENROUTER_API_KEY";

/** The other target issue #200 names: a local Ollama, which serves
 * open-weight models on the same endpoint shape at
 * `http://<host>:11434/v1` and "requires an API key value, but Ollama
 * ignores it" (ollama/ollama, docs/api/openai-compatibility.mdx, read
 * 2026-10-17) - so this adapter sends none at all. `host.docker.internal`
 * is how a container reaches a server on the Docker host; whether it
 * resolves from the relay container on this machine is the one thing
 * openai-compatible.md lists as unverified from here. */
export const LOCAL_BASE_URL = "http://host.docker.internal:11434/v1";

/** Where the agent's own copy is mounted inside the box - fixed and
 * internal, the same way `/workdir` is. Read-only: the worker runs this
 * code, and nothing it does should be able to rewrite its own harness. */
const CONTAINER_AGENT_DIR = "/fabrica-agent";

const DEFAULT_MAX_TURNS = 80;
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 20_000;
const DEFAULT_BASH_TIMEOUT_MS = 600_000;
/** A clarifying call answers with a short JSON object; this is a hard
 * ceiling on it, since that call takes no cap through the `Brain` seam
 * (see `ask()` below and openai-compatible.md's "What bounds the
 * clarifying call"). A reasoning model can spend a small ceiling like
 * this entirely on reasoning and return empty content - OpenRouter's own
 * parameters doc warns of exactly that - which here means "nothing to
 * ask" and the task proceeds. That is the safe direction to fail in
 * (src/brain/README.md: a brain that asks about everything makes the
 * tool nobody wants to use), and it is why this is a ceiling on the
 * clarifying step rather than on the work. */
const ASK_MAX_TOKENS = 1_024;

// This file lives at <packageRoot>/src/brain/adapters/ - the agent's own
// directory is its sibling. Resolved from this module's own URL, never
// from the process's working directory, so it is correct whether Fabrica
// runs from a dev checkout or a global install (the same care
// src/cli/README.md's bin notes call for).
const AGENT_SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "openai-agent");

export interface OpenAiCompatibleOptions {
  /** The model id, exactly as the target names it (e.g. an open-weight
   * model's slug on the hosted target, or a pulled model's tag on a
   * local one). Required: this adapter has no favourite model, and
   * guessing a slug that may not exist would fail at the first call
   * with the provider's own confusing error instead of this one. */
  model: string;
  /** Defaults to `HOSTED_BASE_URL`. Any OpenAI-compatible base URL
   * works - the path is preserved, so a vendor whose API lives under a
   * prefix is fine. */
  baseUrl?: string;
  /** The real credential. Never reaches the box: the relay holds it and
   * swaps a per-call placeholder for it on the way out (see
   * `connectThroughRelay`). Omitted means a target that needs none,
   * which is what a local server wants. */
  apiKey?: string;
  /** Defaults to `"reported"` with a credential and `"free"` without
   * one - a keyed endpoint bills per call and must report the charge; a
   * keyless one is a server the Client runs, which bills nothing. Set it
   * explicitly for anything that does not match that assumption. */
  costSource?: CostSource;
  /** The Docker image the agent runs inside. Defaults to the worker
   * image this repo already builds (`DEFAULT_IMAGE`): the agent needs
   * node, git, bash and the project's own toolchains, which is exactly
   * what that image carries, so this adapter adds no second image to
   * build or keep current. */
  image?: string;
  maxTurns?: number;
  maxToolOutputChars?: number;
  bashTimeoutMs?: number;
  /** Where to set the cap, named verbatim in the refusal when there is
   * none (issue #200: "refused with the exact setting to add"). The CLI
   * passes the real path of the Client's own projects.toml. */
  capSetting?: string;
  /** ask()'s scratch workdir override - the same test seam the reference
   * adapter has. Leave it out in real use; ask() mints and destroys its
   * own empty directory per call. */
  askScratchDir?: string;
}

/** What a prepared box needs: the relay-backed network, the environment,
 * and the teardown that removes every throwaway piece of it. */
interface PreparedNetwork {
  endpoint: string;
  apiKey: string | null;
  env: Record<string, string>;
  network: { isolatedNetwork: string };
  teardown: () => Promise<void>;
}

/** The target's base URL split into the two halves this needs: what the
 * relay must be pointed at, and the path prefix the in-box agent has to
 * keep in front of `/chat/completions` so the call lands on the real
 * endpoint once the relay forwards it. */
export function splitBaseUrl(baseUrl: string): { gateway: GatewayTarget; pathPrefix: string } {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new OpenAiCompatibleError("invalid-base-url", `"${baseUrl}" is not a URL - give the API's base URL, e.g. ${HOSTED_BASE_URL}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OpenAiCompatibleError("invalid-base-url", `"${baseUrl}" is not an http(s) URL - give the API's base URL, e.g. ${HOSTED_BASE_URL}`);
  }
  const tls = url.protocol === "https:";
  const explicitPort = url.port === "" ? undefined : Number(url.port);
  // Port left off whenever it is the protocol's default, so the relay
  // sends a plain `Host: <host>` upstream; given explicitly otherwise,
  // including for plain http, since the relay's own default port is 443
  // regardless of the tls flag.
  const port = explicitPort ?? (tls ? undefined : 80);
  return {
    gateway: { host: url.hostname, tls, ...(port === undefined ? {} : { port }) },
    pathPrefix: url.pathname.replace(/\/+$/, ""),
  };
}

/** Every worker box this adapter starts joins a fresh isolated network
 * whose only other member is a relay container (issue #186's shape, the
 * reference adapter's own wiring generalized to a caller-named gateway):
 * the model API is reachable only through that relay, which is also the
 * only thing that ever holds the real credential, and GitHub is reachable
 * only through its CONNECT tunnel. Every other destination is refused. */
async function connectThroughRelay(opts: { baseUrl: string; apiKey?: string }): Promise<PreparedNetwork> {
  const { gateway, pathPrefix } = splitBaseUrl(opts.baseUrl);
  const id = randomUUID().replace(/-/g, "");
  const isolatedNetworkName = `fabrica-worker-${id}`;
  const egressNetworkName = `fabrica-relay-egress-${id}`;
  const placeholder = `fabrica-placeholder-${id}`;

  // Same stated gap as the reference adapter's: the `Brain` seam carries
  // no taskId (CONTRACT rule 8's socket is brief/workdir/opts only), so a
  // refused tunnel target is recorded against a throwaway scratch record
  // home rather than the Client's real task record.
  const scratchRecordHome = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-relay-record-"));

  const isolatedNetwork = await createIsolatedNetwork(isolatedNetworkName);
  const egressNetwork = await createEgressNetwork(egressNetworkName);

  let relay: Awaited<ReturnType<typeof startContainerizedRelay>>;
  try {
    relay = await startContainerizedRelay({
      recordHome: scratchRecordHome,
      taskId: "worker",
      isolatedNetwork: isolatedNetwork.name,
      egressNetwork: egressNetwork.name,
      tunnelAllowlist: [...GITHUB_HOSTS],
      gateway: {
        ...gateway,
        ...(opts.apiKey === undefined
          ? {}
          : { credential: { header: "authorization", fakeValue: placeholder, realValue: `Bearer ${opts.apiKey}` } }),
      },
    });
  } catch (err) {
    await removeIsolatedNetwork(isolatedNetworkName).catch(() => {});
    await removeEgressNetwork(egressNetworkName).catch(() => {});
    rmSync(scratchRecordHome, { recursive: true, force: true });
    throw err;
  }

  const relayUrl = `http://${relay.host}:${relay.port}`;
  return {
    endpoint: `${relayUrl}${pathPrefix}`,
    apiKey: opts.apiKey === undefined ? null : placeholder,
    env: {
      // For whatever inside the box speaks the ordinary proxy
      // convention - a Worker's own shell commands, `gh`, a package
      // install. The agent's own HTTP client reads none of these: it is
      // pointed straight at the relay's gateway address above.
      HTTP_PROXY: relayUrl,
      HTTPS_PROXY: relayUrl,
      http_proxy: relayUrl,
      https_proxy: relayUrl,
      NO_PROXY: relay.host,
      no_proxy: relay.host,
    },
    network: { isolatedNetwork: isolatedNetworkName },
    teardown: async () => {
      // Order matters: a network with a container still attached refuses
      // to be removed.
      await relay.close();
      await removeIsolatedNetwork(isolatedNetworkName);
      await removeEgressNetwork(egressNetworkName);
      rmSync(scratchRecordHome, { recursive: true, force: true });
    },
  };
}

/** The write-up tool's `parameters`: the nine required ratified fields
 * and the one optional one, built from src/brain/writeup.ts so no field
 * list is restated here or in the agent, plus the one extra thing a
 * worker may declare with its work - rule 9's `gateChanges`, which is
 * optional because leaving the gate alone is the normal case and "no
 * changes here" has no other spelling (src/brain/README.md's
 * `gateChanges` section). */
export function writeupToolSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [...WRITEUP_STRING_FIELDS, "confidence"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: WRITEUP_TITLE_MAX_LENGTH, description: "Your own words, in the imperative, at most 60 characters - never the task text." },
      why: { type: "string", minLength: 1, description: "What this change is for, from the product side." },
      what: { type: "string", minLength: 1, description: "The steps you took to accomplish the task." },
      how: { type: "string", minLength: 1, description: "The engineering side: what you added, modified or refactored." },
      outsideChanges: {
        type: "string",
        minLength: 1,
        description:
          'Anything this change needs beyond this repository - settings, infrastructure, an external service, the machine it runs on - or "None."',
      },
      confidence: { type: "number", minimum: 0, maximum: 100 },
      assumptions: { type: "string", minLength: 1 },
      expectedOutcomes: { type: "string", minLength: 1 },
      deviations: { type: "string", minLength: 1, description: 'What you deviated from the request and why, or "None."' },
      couldNotVerify: {
        type: "string",
        description:
          "Optional: anything you could not check from where you are - a service you could not reach, a test you could not run. Leave it out entirely if there is nothing.",
      },
      gateChanges: {
        type: "string",
        description:
          "Only if you changed one of the project's own tests or check settings: which check changed, and why the brief called for it.",
      },
    },
  };
}

/** A copy of the agent, and this call's job file, in a throwaway
 * directory of their own - mounted read-only into the box. Only the
 * `.mjs` files are copied: the box runs them with a stock `node`, and a
 * TypeScript file reaching it would be a file nothing in there can
 * execute. Exported so the box test can stage one the same way a real
 * call does, without a credential or a relay. */
export function stageAgent(job: AgentJob): { dir: string; jobPath: string } {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-agent-"));
  for (const entry of readdirSync(AGENT_SOURCE_DIR)) {
    if (!entry.endsWith(".mjs")) continue;
    cpSync(join(AGENT_SOURCE_DIR, entry), join(dir, entry));
  }
  const jobPath = join(dir, "job.json");
  writeFileSync(jobPath, JSON.stringify(job));
  return { dir, jobPath };
}

/** Turns a stream of raw stdout chunks into complete lines, calling
 * `onLine` the instant each one's newline arrives (issue #70) - a line
 * split across two chunks is held until the rest of it lands. The same
 * shape as the reference adapter's own feeder; both exist because a
 * contained process's stdout arrives in arbitrary chunks. */
export function lineFeeder(onLine: (line: string) => void): (chunk: string) => void {
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

/** One agent line as the transcript entries a human watching the worker
 * should see. A "result" line carries no entry of its own - it is the
 * host's own bookkeeping, and what a reader needs from it (the cap being
 * hit, the cost) is already its own entry. */
export function mapAgentLine(line: AgentLine): TranscriptEntry[] {
  const occurredAt = new Date().toISOString();
  switch (line.t) {
    case "text":
      return [{ occurredAt, kind: "text", text: line.text }];
    case "tool-call":
      return [{ occurredAt, kind: "tool-call", text: `${line.name}(${JSON.stringify(line.args ?? {})})` }];
    case "tool-result":
      return [{ occurredAt, kind: line.isError ? "tool-error" : "tool-result", text: line.text }];
    case "note":
      return [{ occurredAt, kind: "note", text: line.text }];
    case "usage":
      // Rule 10's reserved kind (contract/surface.ts's TranscriptEntry):
      // one entry per API call, summed into the attempt's cost by
      // src/foreman/spend.ts. Always "metered" - this is real billed
      // money, reported by the provider itself, or a genuine $0.00 on a
      // target that bills nothing; never an estimate.
      return [
        {
          occurredAt,
          kind: "usage",
          text: JSON.stringify({
            totalCostUsd: line.usage.costUsd,
            usage: { input_tokens: line.usage.promptTokens, output_tokens: line.usage.completionTokens },
            turn: line.turn,
            costBasis: "metered",
          }),
        },
      ];
    case "result":
      return [];
  }
}

/** The agent's final line, as a `WorkerWriteup` when it has the shape
 * the seam promises. The Foreman checks the contents again and names
 * what is wrong with a bad one (src/foreman/pr-body.ts); this only
 * refuses to pass off something that is not the right shape at all. */
function writeupFrom(value: unknown): WorkerWriteup | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (!WRITEUP_STRING_FIELDS.every((field) => typeof record[field] === "string")) return undefined;
  if (typeof record.confidence !== "number") return undefined;
  // Built field by field rather than passed through: whatever else the
  // model put in the tool call (rule 9's `gateChanges` rides in the same
  // arguments object) must not end up inside the write-up itself.
  const writeup = { confidence: record.confidence } as Record<string, unknown>;
  for (const field of WRITEUP_STRING_FIELDS) writeup[field] = record[field];
  for (const field of WRITEUP_OPTIONAL_STRING_FIELDS) {
    if (typeof record[field] === "string") writeup[field] = record[field];
  }
  return writeup as unknown as WorkerWriteup;
}

/** The refusal issue #200 is named after. Thrown before any box starts,
 * so nothing has been spent and nothing has to be torn down - and
 * naming the one setting that fixes it, since "no cap" is a
 * configuration the Client can change in one line, not a bug. */
function refuseWithoutCap(capSetting: string | undefined): never {
  const where = capSetting === undefined ? "your projects.toml" : capSetting;
  throw new OpenAiCompatibleError(
    "no-cap",
    `This worker calls a paid model API per token, so it will not start without a spending cap. ` +
      `Add a per-task cap to ${where}:\n\n  [caps]\n  perTaskUsd = 2.00\n\n` +
      `Then run the task again. (Any number works, including a small one - the cap is what makes the pipe safe to open.)`
  );
}

export function openAiCompatibleAdapter(opts: OpenAiCompatibleOptions): Brain {
  const baseUrl = opts.baseUrl ?? HOSTED_BASE_URL;
  const image = opts.image ?? DEFAULT_IMAGE;
  const costSource: CostSource = opts.costSource ?? (opts.apiKey === undefined ? "free" : "reported");

  const jobBase = {
    model: opts.model,
    costSource,
    maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
    maxToolOutputChars: opts.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS,
    bashTimeoutMs: opts.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS,
    writeupSchema: writeupToolSchema(),
    writeupStringFields: [...WRITEUP_STRING_FIELDS],
    writeupOptionalStringFields: [...WRITEUP_OPTIONAL_STRING_FIELDS],
    writeupTitleMaxLength: WRITEUP_TITLE_MAX_LENGTH,
  };

  /** Runs one staged job in a box and returns every line it printed.
   * `endpoint` and `apiKey` are this function's own to fill in: both
   * only exist once a relay is standing, and neither is a caller's
   * business - the placeholder it hands the box is minted per call. */
  async function runAgent(
    job: Omit<AgentJob, "endpoint" | "apiKey">,
    box: { workdir: string; homeDir: string; readOnlyMounts: ReadOnlyMount[]; onLine?: (line: AgentLine) => void }
  ): Promise<{ lines: AgentLine[]; stderr: string; exitCode: number | null }> {
    let prepared: PreparedNetwork;
    try {
      prepared = await connectThroughRelay({ baseUrl, ...(opts.apiKey === undefined ? {} : { apiKey: opts.apiKey }) });
    } catch (err) {
      if (err instanceof ContainmentError || err instanceof RelayError) {
        throw new OpenAiCompatibleError("spawn-failed", `could not stand up this worker's network: ${err.message}`);
      }
      throw err;
    }

    // From here on the relay and its two networks exist, so every path
    // out of this function has to tear them down - a leaked relay
    // container also leaves its networks undeletable (see
    // src/relay/container/launch.ts's own note on exactly that).
    let staged: { dir: string; jobPath: string };
    try {
      staged = stageAgent({ ...job, endpoint: prepared.endpoint, apiKey: prepared.apiKey });
    } catch (err) {
      await prepared.teardown();
      throw err;
    }

    const lines: AgentLine[] = [];
    const onStdout = lineFeeder((raw) => {
      let parsed: AgentLine;
      try {
        parsed = JSON.parse(raw) as AgentLine;
      } catch {
        // The agent prints nothing but NDJSON on stdout; a line that is
        // not JSON can only come from something else in the box writing
        // there, and is skipped rather than allowed to fail the call.
        return;
      }
      lines.push(parsed);
      box.onLine?.(parsed);
    });

    try {
      const { stderr, exitCode } = await runContained(
        "node",
        [join(CONTAINER_AGENT_DIR, "bootstrap.mjs"), join(CONTAINER_AGENT_DIR, "job.json")],
        {
          workdir: box.workdir,
          network: prepared.network,
          image,
          env: prepared.env,
          readOnlyMounts: [...box.readOnlyMounts, { source: staged.dir, target: CONTAINER_AGENT_DIR }],
          homeDir: box.homeDir,
          onStdout,
        }
      );
      return { lines, stderr, exitCode };
    } catch (err) {
      if (err instanceof ContainmentError || err instanceof RelayError) {
        throw new OpenAiCompatibleError(
          "spawn-failed",
          `could not run this worker contained (image ${image}) in ${box.workdir}: ${err.message}`
        );
      }
      throw err;
    } finally {
      rmSync(staged.dir, { recursive: true, force: true });
      await prepared.teardown();
    }
  }

  function resultFrom(lines: AgentLine[], stderr: string, exitCode: number | null): AgentResult {
    const last = [...lines].reverse().find((line) => line.t === "result");
    if (last === undefined || last.t !== "result") {
      throw new OpenAiCompatibleError(
        "unparseable-output",
        `this worker printed no final result line (exit code ${exitCode})${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`
      );
    }
    return last.result;
  }

  return {
    name: "openai-compatible",
    model: opts.model,

    async ask(brief: string): Promise<BrainAskResult> {
      // No ProductionLine exists at SPEC.md step 2, so there is nothing
      // of the Client's to mount: an empty scratch directory stands in
      // for workdir, with no git mounts at all, and CONTRACT rule 1 holds
      // by construction. The prompt is the reference adapter's own - what
      // counts as materially ambiguous is a property of the step, not of
      // which brain answers it.
      const ownScratchDir = opts.askScratchDir === undefined;
      const scratchDir = opts.askScratchDir ?? mkdtempSync(join(realpathSync(tmpdir()), "fabrica-ask-"));
      const homeDir = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-ask-home-"));

      try {
        const { lines, stderr, exitCode } = await runAgent(
          {
            ...jobBase,
            mode: "ask",
            brief: buildAskPrompt(brief),
            maxSpendUsd: null,
            askMaxTokens: ASK_MAX_TOKENS,
            sessionId: randomUUID(),
          },
          { workdir: scratchDir, homeDir, readOnlyMounts: [] }
        );
        const result = resultFrom(lines, stderr, exitCode);
        if (!result.ok) {
          // Nothing was asked and nothing was done - the Foreman records
          // "ask-failed" with this message, which is how the Client finds
          // out about a rejected key or an unknown model.
          throw new OpenAiCompatibleError("api-unreachable", result.error ?? `the clarifying call failed (${result.stopReason})`);
        }
        return { questions: result.questions ?? [], costUsd: result.totalCostUsd };
      } finally {
        if (ownScratchDir) rmSync(scratchDir, { recursive: true, force: true });
        rmSync(homeDir, { recursive: true, force: true });
      }
    },

    async work(brief: string, workdir: string, workOpts?: BrainWorkOptions): Promise<BrainWorkResult> {
      // Issue #200's refusal, before anything else happens at all: no
      // box, no relay, no API call, nothing to tear down.
      if (workOpts?.maxSpendUsd === undefined) refuseWithoutCap(opts.capSetting);
      const maxSpendUsd = workOpts.maxSpendUsd;

      // A cap with nothing left in it is the cap working, not a reason to
      // refuse the whole task: it reports the same budget-exhausted
      // result the in-box loop would, for $0, without paying for a
      // container to tell us so.
      if (maxSpendUsd <= 0) {
        const transcript: TranscriptEntry[] = [
          { occurredAt: new Date().toISOString(), kind: "usage", text: JSON.stringify({ totalCostUsd: 0, costBasis: "metered" }) },
          {
            occurredAt: new Date().toISOString(),
            kind: "budget-exhausted",
            text: "this task's spending cap was already reached, so no model call was made",
          },
        ];
        for (const entry of transcript) emitLiveTranscriptEntry(workdir, entry);
        return { transcript };
      }

      const { readOnlyMounts, sanitizedConfigDir } = resolveGitMounts(workdir);
      // A sibling of the resolved workdir, so the box's own $HOME - and
      // with it this task's saved message history, which is what makes a
      // warm fix round possible for an API that holds no session of its
      // own - survives across every call for this one task. Same scheme
      // and same reasoning as the reference adapter's session directory.
      const sessionDir = `${realpathSync(workdir)}.fabrica-session`;
      mkdirSync(sessionDir, { recursive: true });

      const transcript: TranscriptEntry[] = [];
      try {
        const { lines, stderr, exitCode } = await runAgent(
          {
            ...jobBase,
            mode: "work",
            brief,
            maxSpendUsd,
            sessionId: randomUUID(),
            ...(workOpts.session === undefined ? {} : { resumeSessionId: workOpts.session }),
            ...(workOpts.reasoningEffort === undefined ? {} : { reasoningEffort: workOpts.reasoningEffort }),
          },
          {
            workdir,
            homeDir: sessionDir,
            readOnlyMounts,
            onLine: (line) => {
              for (const entry of mapAgentLine(line)) {
                transcript.push(entry);
                emitLiveTranscriptEntry(workdir, entry);
              }
            },
          }
        );

        const result = resultFrom(lines, stderr, exitCode);

        // Nothing happened and nothing was spent: a rejected credential,
        // an unknown model, an unreachable endpoint. That is an
        // infrastructure failure, not an attempt with a bad outcome, so
        // it is thrown - the Foreman records it as a failed task with
        // this message rather than delivering an empty transcript.
        if (!result.ok && result.turnsCompleted === 0 && result.totalCostUsd === 0) {
          throw new OpenAiCompatibleError("api-unreachable", result.error ?? `this worker failed before any model call (${result.stopReason})`);
        }

        // Every other unfinished outcome keeps what was done: the spend
        // is real and belongs on the record, and the attempt is red on
        // its missing write-up, which is the Foreman's own job to say
        // (src/foreman/attempts.ts).
        if (result.stopReason === "budget-exhausted") {
          const entry: TranscriptEntry = {
            occurredAt: new Date().toISOString(),
            kind: "budget-exhausted",
            text: `reached the spending cap for this call ($${maxSpendUsd}) after ${result.turnsCompleted} model calls`,
          };
          transcript.push(entry);
          emitLiveTranscriptEntry(workdir, entry);
        }

        const writeup = writeupFrom(result.writeup);
        return {
          transcript,
          session: result.session,
          ...(result.gateChanges === undefined ? {} : { gateChanges: result.gateChanges }),
          ...(writeup === undefined ? {} : { writeup }),
        };
      } finally {
        rmSync(sanitizedConfigDir, { recursive: true, force: true });
      }
    },
  };
}
