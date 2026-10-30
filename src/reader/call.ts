// How a reader is reached. Two ways, one answer shape: an HTTP POST to
// <baseUrl>/chat/completions for a vendor with a key and an endpoint,
// and - issue #315 - a command on this machine for a vendor that has
// neither, which `askCommandReader` at the bottom of this file hands to
// src/brain/adapters. Both return the model's answer as text, so
// everything downstream of the answer is the same code.
//
// Written out here rather than imported from the direct-API brain
// adapter's own client, which already makes the identical call, for a
// reason that is not a preference: CONTRACT rule 8's scan
// (contract/rule8.no-favorite-brain.test.ts) reads every file under
// src/ outside the adapter directory and flags a vendor name as plain
// text anywhere in it - an import specifier included - and that
// client's path names one. A generic module cannot reach it without
// failing that test by construction.
//
// The request shape itself is not invented here. It is the
// chat-completions shape this repository already verified against the
// vendors' own current documentation and wrote down under
// src/brain/adapters/ (a POST to `<endpoint>/chat/completions`, a
// `model` plus a `messages` array in the body, a Bearer token in
// `Authorization`, and the answer's text at
// `choices[0].message.content`) - read from that record, not guessed.
//
// Nothing here knows or names which vendor is on the other end: the
// endpoint and the credential both arrive settled (resolve.ts) from the
// Client's own `[reader]` table and his own `brain.env`.
//
// That scan is also why `askCommandReader` reaches the adapter directory
// through `../brain/index.ts` rather than the adapter file itself: the
// barrel's path names nobody, so importing it is allowed where importing
// a vendor-named path would fail the test. Which is the same constraint
// as the paragraph above, satisfied the other way round - there the
// client had to be rewritten, here one re-export was enough.

import * as http from "node:http";
import * as https from "node:https";
import { cliReaderFor } from "../brain/index.ts";
import type { ApiReader, CommandReader } from "./types.ts";

/** Statuses that mean "not now" rather than "no": the provider's own
 * back-pressure and its own outages. Anything else - a 400, a 401 - is
 * a real answer about this request and is never retried. */
const RETRY_STATUSES: ReadonlySet<number> = new Set([408, 409, 429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [2_000, 6_000];

/** A whole diff plus an instruction is a long prompt and the answer is
 * a list, so this is generous. Injectable, because a test must never
 * wait on it. */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** How much of a provider's own error body is worth repeating to the
 * Client. Enough to carry a real message, short enough that a failure
 * line stays a line. */
const ERROR_BODY_CHARS = 1_000;

export interface CallOptions {
  timeoutMs?: number;
  sleepFn?: (ms: number) => Promise<unknown>;
  /** The whole transport, replaced wholesale in tests - so no test
   * opens a socket and nothing in the default `npm test` run depends on
   * a network or a credential. */
  post?: PostJson;
  /** The same, for the other way a reader can be reached (issue #315):
   * the command that stands in for it, so a test proves the dispatch
   * without running anything real. */
  command?: string;
}

/** The message array both ways of reaching a reader take - the
 * instruction and then the diff, built once by `readDiff`. */
export type ReaderMessages = { role: "system" | "user"; content: string }[];

export type PostJson = (
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number
) => Promise<{ status: number; body: string }>;

function sleep(ms: number): Promise<unknown> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One POST of a JSON body, resolving with the status and the raw body
 * text whatever the status is - a non-2xx answer is information, not an
 * exception, and the caller above decides which ones are worth retrying.
 */
export const postJson: PostJson = (url, headers, body, timeoutMs) =>
  new Promise((resolve, reject) => {
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
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no response within ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(body);
  });

/**
 * Sends one chat-completions request and returns the assistant's text.
 *
 * Throws an Error whose message is written to be shown to the Client
 * verbatim - the caller turns that into a recorded `reader-failed` and
 * carries on, since the reader never blocks a delivery (inspector issue
 * #34's amendment).
 *
 * The credential goes into one header on one request and nowhere else:
 * not into any environment, not into argv, and never into a message
 * here. Every error names the endpoint, which came from config, and
 * never the key.
 */
export async function askReader(
  reader: ApiReader,
  messages: ReaderMessages,
  opts: CallOptions = {}
): Promise<string> {
  const url = `${reader.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${reader.apiKey}`,
  };
  const body = JSON.stringify({ model: reader.model, messages });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pause = opts.sleepFn ?? sleep;
  const post = opts.post ?? postJson;

  let lastProblem = "";
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await pause(RETRY_DELAYS_MS[attempt - 1]);

    let response: { status: number; body: string };
    try {
      response = await post(url, headers, body, timeoutMs);
    } catch (err) {
      lastProblem = `could not reach the reader's model at ${url}: ${messageOf(err)}`;
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      lastProblem = `the reader's model answered ${response.status}: ${response.body.trim().slice(0, ERROR_BODY_CHARS)}`;
      if (RETRY_STATUSES.has(response.status)) continue;
      throw new Error(lastProblem);
    }

    return contentOf(response.body);
  }

  throw new Error(`${lastProblem} (gave up after ${RETRY_DELAYS_MS.length + 1} attempts)`);
}

/**
 * The other way (issue #315): the same messages, asked of a command on
 * this machine instead of an endpoint, and the same thing handed back -
 * the model's answer as text, for `parseFindings` to read exactly as it
 * reads an API-keyed vendor's.
 *
 * `schema` goes to the command as a JSON Schema, so the answer arrives
 * already structured rather than parsed out of prose. The shape is the
 * reader's own (src/reader/read.ts) - this function only carries it.
 *
 * No retry loop, deliberately, where the HTTP path above has one: a
 * command on this machine is not somebody's rate limiter, its own client
 * already handles a provider's back-pressure, and a second whole read is
 * a second whole charge. A failure comes back as a failed read, which
 * never blocks a delivery.
 *
 * Nothing here knows which command, or that there is a vendor behind it:
 * `cliReaderFor` answers from src/brain/adapters, the only place allowed
 * to know (CONTRACT rule 8). A reader that reached this function for a
 * vendor no adapter serves is a resolution bug, not a model failure, and
 * says so.
 */
export async function askCommandReader(
  reader: CommandReader,
  messages: ReaderMessages,
  schema: unknown,
  opts: CallOptions = {}
): Promise<string> {
  const vendor = cliReaderFor(reader.vendor);
  if (vendor === undefined) {
    throw new Error(
      `the code reader "${reader.vendor}" was settled as one reached by running \`${reader.command}\`, but nothing ` +
        `here knows how to run that vendor - this is a bug in Fabrica, not a problem with the read.`
    );
  }
  return vendor.ask({
    model: reader.model,
    messages,
    schema,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.command === undefined ? {} : { command: opts.command }),
  });
}

/** The assistant's text out of one answer body. A 200 carrying an error
 * object instead of choices is a real answer about this request, so it
 * is reported rather than retried - the same call this repository's
 * direct-API adapter already makes about the same shape. */
function contentOf(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`the reader's model answered something that is not JSON: ${messageOf(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("the reader's model answered JSON that is not an object");
  }
  const choices = (parsed as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error(`the reader's model answered no choices: ${raw.trim().slice(0, ERROR_BODY_CHARS)}`);
  }
  const message = (choices[0] as Record<string, unknown> | undefined)?.message;
  const content = typeof message === "object" && message !== null ? (message as Record<string, unknown>).content : undefined;
  if (typeof content !== "string") {
    throw new Error(`the reader's model answered no message content: ${raw.trim().slice(0, ERROR_BODY_CHARS)}`);
  }
  return content;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
