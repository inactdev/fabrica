// @ts-check
// The one HTTP call this agent makes: POST <endpoint>/chat/completions,
// the OpenAI-compatible chat-completions shape. Runs *inside* the worker's
// box, against the relay's own address (src/relay/), which forwards the
// call to the real provider with the real credential swapped in - so the
// value in `Authorization` here is a per-call placeholder, never the
// Client's key.
//
// Verified against current vendor documentation on 2026-10-17, not
// guessed (CONTRACT rule 11's standing question):
//
// - OpenRouter, the default hosted target: `Authorization` set to a
//   Bearer token, base URL `https://openrouter.ai/api/v1`
//   (OpenRouterTeam/docs, api_reference/authentication.mdx); every
//   response carries a `usage` object with `cost` ("The total amount
//   charged to your account") and `prompt_tokens`/`completion_tokens`,
//   with no request parameter needed - the old `usage: { include: true }`
//   is documented as deprecated and inert
//   (cookbook/administration/usage-accounting.mdx). `tools`,
//   `tool_choice` and `max_tokens` are documented request parameters
//   (api_reference/parameters.mdx), and the three-step tool-calling
//   exchange below - assistant message with `tool_calls`, then one
//   `{ role: "tool", tool_call_id, content }` message per call - is
//   quoted verbatim from guides/features/tool-calling.mdx.
// - A local Ollama server, the other target the issue names, speaks the
//   same endpoint at `http://<host>:11434/v1` and "requires an API key
//   value, but Ollama ignores it" (ollama/ollama,
//   docs/api/openai-compatibility.mdx) - hence `apiKey: null` sending no
//   header at all, which that server accepts.
//
// Plain JavaScript importing only `node:` built-ins: the box runs this
// with a stock `node`, no tsx and nothing from node_modules (see
// runtime-imports.test.ts, which proves it).

import * as http from "node:http";
import * as https from "node:https";

/** @typedef {import("./types.ts").ChatTarget} ChatTarget */
/** @typedef {import("./types.ts").AgentUsage} AgentUsage */

/** How many times a refused or failed call is retried before the loop
 * gives up, and how long it waits first. A 429 or a 5xx is the
 * provider's own "not now," which a one-shot failure would turn into a
 * dead task; anything else (a 400, a 401) is a real answer and is never
 * retried. */
const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [2_000, 6_000];

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One POST of a JSON body, returning the status and the raw body text.
 * No streaming: the loop needs the terminal `usage` object to meter
 * spend, and a non-streaming response carries it in one piece.
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {string} body
 * @param {number} timeoutMs
 * @returns {Promise<{ status: number, body: string }>}
 */
function postJson(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port === "" ? undefined : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: { ...headers, "content-length": String(Buffer.byteLength(body, "utf8")) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no response within ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * The usage object as a dollar figure, by the target's own rule (see
 * types.ts's CostSource). An unknown cost stays null - rule 10 never
 * counts one as zero.
 * @param {unknown} usage
 * @param {import("./types.ts").CostSource} costSource
 * @returns {AgentUsage}
 */
export function usageFrom(usage, costSource) {
  const record = typeof usage === "object" && usage !== null ? /** @type {Record<string, unknown>} */ (usage) : {};
  const number = (/** @type {unknown} */ value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const reported = number(record.cost);
  return {
    costUsd: costSource === "free" ? 0 : reported,
    promptTokens: number(record.prompt_tokens),
    completionTokens: number(record.completion_tokens),
  };
}

/**
 * Sends one chat-completions request, retrying only what the provider
 * itself says to retry. Resolves with the parsed response, or throws an
 * Error whose message is what the Client needs to read - the loop turns
 * that into an "api-error" stop rather than a crash.
 * @param {ChatTarget} job
 * @param {Record<string, unknown>} payload
 * @param {{ timeoutMs?: number, sleepFn?: (ms: number) => Promise<unknown> }} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function chatCompletion(job, payload, opts = {}) {
  const url = `${job.endpoint.replace(/\/+$/, "")}/chat/completions`;
  /** @type {Record<string, string>} */
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (job.apiKey !== null) headers.authorization = `Bearer ${job.apiKey}`;
  const body = JSON.stringify({ model: job.model, ...payload });
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const pause = opts.sleepFn ?? sleep;

  let lastProblem = "";
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await pause(RETRY_DELAYS_MS[attempt - 1]);

    /** @type {{ status: number, body: string }} */
    let response;
    try {
      response = await postJson(url, headers, body, timeoutMs);
    } catch (err) {
      lastProblem = `could not reach the model API at ${url}: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      lastProblem = `the model API answered ${response.status}: ${response.body.trim().slice(0, 1_000)}`;
      if (RETRY_STATUSES.has(response.status)) continue;
      throw new Error(lastProblem);
    }

    try {
      const parsed = JSON.parse(response.body);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not a JSON object");
      // Some OpenAI-compatible servers answer 200 with an error object
      // instead of choices; that is a real answer, not a transport
      // problem, so it is reported rather than retried.
      const choices = /** @type {Record<string, unknown>} */ (parsed).choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new Error(`no choices in the response: ${response.body.trim().slice(0, 1_000)}`);
      }
      return /** @type {Record<string, unknown>} */ (parsed);
    } catch (err) {
      throw new Error(`the model API's answer could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`${lastProblem} (gave up after ${RETRY_DELAYS_MS.length + 1} attempts)`);
}
