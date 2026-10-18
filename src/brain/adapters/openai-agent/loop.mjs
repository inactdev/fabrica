// @ts-check
// The agent loop itself - the part a CLI adapter never has to write
// (../README.md: "a direct API adapter implements that loop itself").
// Runs inside the worker's box, reports every step on stdout as NDJSON
// (types.ts's AgentLine) so the host can put it on the record live, and
// meters money as it goes.
//
// Rule 10's cap, exactly as the Client ruled it for issue #200: the cap
// is metered dollars for this one `work()` call, taken from the
// provider's own per-call usage; the loop checks before each call and
// stops at the first one that crosses the line, so it can overshoot by
// at most one call; and a stop returns what was done so far with a
// budget-exhausted note, never a thrown error. Starting with no cap at
// all is refused one layer up, before any of this runs
// (../openai-compatible.ts) - by the time a job reaches this file in
// "work" mode, `maxSpendUsd` is a number.
//
// Plain JavaScript importing only `node:` built-ins and its siblings;
// see client.mjs.

import { chatCompletion, usageFrom } from "./client.mjs";
import { clamp, loadSession, runTool, saveSession, WORK_TOOLS, WRITEUP_TOOL_NAME } from "./tools.mjs";

/** @typedef {import("./types.ts").AgentJob} AgentJob */
/** @typedef {import("./types.ts").AgentLine} AgentLine */
/** @typedef {import("./types.ts").AgentResult} AgentResult */

/** What the model is told about where it is and how it finishes. The
 * task itself, the standing question and the write-up rules all arrive
 * in the brief, put there by Fabrica's own code (src/foreman/
 * standing-question.ts) - this says only what is true of *this* worker's
 * surroundings, which nothing else can tell it. */
export const WORK_SYSTEM_PROMPT = [
  "You are a software engineer working on a real task, alone, with no one to ask.",
  "",
  "Your tools are the only way you can see or change anything. The project is a throwaway copy, checked out at",
  "your working directory: read it, edit it, run its checks. Nothing you do reaches anyone's real checkout.",
  "You cannot commit - the git directory is read-only on purpose, and your changes are committed for you once",
  "you are done. `git status` and `git diff` do work, and are the honest way to see what you have changed.",
  "",
  `Finish by calling ${WRITEUP_TOOL_NAME} exactly once, with the write-up the brief asks you for. That call is`,
  "the only way to finish: until you make it, the task is not done, and if you stop calling tools without it",
  "your work is treated as incomplete. Do the work first, verify it by running the project's own checks, and",
  "only then write it up.",
].join("\n");

/** What a model that goes quiet without finishing is told, once, before
 * the loop gives up on it. A turn that neither calls a tool nor submits
 * is usually a model that has lost track of the protocol, not one that
 * is done - but it must never become a reason to spin. */
export const IDLE_NUDGE =
  `You have not finished. Either call a tool to carry on with the work, or call ${WRITEUP_TOOL_NAME} with your ` +
  `write-up if the work is genuinely complete. Do not reply with prose alone.`;

const MAX_NUDGES = 2;

/**
 * The write-up tool, built from the schema the host passed in (which the
 * host builds from src/brain/writeup.ts) so the field list lives in
 * exactly one place in this repo.
 * @param {AgentJob} job
 */
function writeupTool(job) {
  return {
    type: "function",
    function: {
      name: WRITEUP_TOOL_NAME,
      description:
        "Submit your finished work's write-up and end the task. Call this once, last, after the work is done and " +
        "verified. Every field is required.",
      parameters: job.writeupSchema,
    },
  };
}

/**
 * What is wrong with a submitted write-up, or undefined when it is
 * usable. The Foreman checks this again on the host and renders a red
 * attempt out of a bad one (src/foreman/pr-body.ts); checking here too
 * means the model gets told while it can still fix it, which is cheaper
 * than a whole extra round.
 * @param {AgentJob} job
 * @param {Record<string, unknown>} args
 * @returns {string | undefined}
 */
export function writeupProblem(job, args) {
  for (const field of job.writeupStringFields) {
    const value = args[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      return `${field} is required and must be a non-empty string`;
    }
  }
  const title = /** @type {string} */ (args.title);
  if (title.length > job.writeupTitleMaxLength) {
    return `title is ${title.length} characters; it must be at most ${job.writeupTitleMaxLength}`;
  }
  const confidence = args.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
    return "confidence is required and must be a number from 0 to 100";
  }
  return undefined;
}

/**
 * @param {AgentJob} job
 * @param {Record<string, unknown>} args
 */
function writeupFrom(job, args) {
  /** @type {Record<string, unknown>} */
  const writeup = { confidence: args.confidence };
  for (const field of job.writeupStringFields) writeup[field] = args[field];
  // An optional field only rides along when the model actually filled
  // it in: the host omits its bullet entirely when it is empty, so an
  // empty string here would be the same as leaving it out, with no
  // placeholder either way.
  for (const field of job.writeupOptionalStringFields ?? []) {
    const value = args[field];
    if (typeof value === "string" && value.trim().length > 0) writeup[field] = value;
  }
  return writeup;
}

/**
 * A tool call's arguments, which arrive as a JSON *string* on the wire
 * (OpenRouter's own tool-calling doc shows `arguments` as a string, and
 * so does every OpenAI-compatible server). Unparseable arguments are a
 * message back to the model, not a crash.
 * @param {unknown} raw
 * @returns {{ args: Record<string, unknown> } | { problem: string }}
 */
function parseToolArguments(raw) {
  if (raw === undefined || raw === null || raw === "") return { args: {} };
  if (typeof raw === "object") return { args: /** @type {Record<string, unknown>} */ (raw) };
  if (typeof raw !== "string") return { problem: "the tool call's arguments were neither a JSON string nor an object" };
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { problem: "the tool call's arguments were not a JSON object" };
    return { args: /** @type {Record<string, unknown>} */ (parsed) };
  } catch (err) {
    return { problem: `the tool call's arguments were not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Runs one "work" job to completion.
 * @param {AgentJob} job
 * @param {(line: AgentLine) => void} emit
 * @param {{ root: string, chat?: typeof chatCompletion }} deps
 * @returns {Promise<AgentResult>}
 */
export async function runWork(job, emit, deps) {
  const chat = deps.chat ?? chatCompletion;
  const env = { root: deps.root, maxToolOutputChars: job.maxToolOutputChars, bashTimeoutMs: job.bashTimeoutMs };
  const tools = [...WORK_TOOLS, writeupTool(job)];

  // A warm fix round (CONTRACT rule 6's "fix") resumes the prior call's
  // own history and treats this brief as a correction inside it, which
  // is what SPEC.md asks for - "a retry is a correction into the same
  // session, never a cold restart". A resume that finds nothing (first
  // round, or a session file that never survived) starts cold, which is
  // correct rather than an error: the brief says what to do either way.
  const prior = job.resumeSessionId === undefined ? [] : loadSession(job.resumeSessionId);
  /** @type {any[]} */
  const messages =
    prior.length > 0
      ? [...prior, { role: "user", content: job.brief }]
      : [
          { role: "system", content: WORK_SYSTEM_PROMPT },
          { role: "user", content: job.brief },
        ];

  let spentUsd = 0;
  let costKnown = true;
  let turnsCompleted = 0;
  let nudges = 0;
  /** @type {import("./types.ts").AgentStopReason} */
  let stopReason = "max-turns";
  /** @type {Record<string, unknown> | undefined} */
  let writeup;
  /** @type {string | undefined} */
  let gateChanges;
  /** @type {string | undefined} */
  let error;

  for (let turn = 1; turn <= job.maxTurns; turn++) {
    if (job.maxSpendUsd !== null && spentUsd >= job.maxSpendUsd) {
      stopReason = "budget-exhausted";
      break;
    }

    /** @type {Record<string, unknown>} */
    let response;
    try {
      response = await chat(job, {
        messages,
        tools,
        tool_choice: "auto",
        ...(job.reasoningEffort === undefined ? {} : { reasoning_effort: job.reasoningEffort }),
      });
    } catch (err) {
      stopReason = "api-error";
      error = err instanceof Error ? err.message : String(err);
      break;
    }
    turnsCompleted++;

    const usage = usageFrom(response.usage, job.costSource);
    emit({ t: "usage", turn, usage, costSource: job.costSource });
    if (usage.costUsd === null) costKnown = false;
    else spentUsd += usage.costUsd;

    const choice = /** @type {Record<string, unknown>} */ (/** @type {any[]} */ (response.choices)[0] ?? {});
    const message = /** @type {Record<string, unknown>} */ (choice.message ?? {});
    const content = typeof message.content === "string" ? message.content : "";
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    // The assistant's own message goes back in verbatim, tool_calls and
    // all: the next request has to carry the exchange the tool results
    // below answer to, or the provider rejects it.
    messages.push(message);
    if (content.trim().length > 0) emit({ t: "text", text: content });

    if (toolCalls.length === 0) {
      if (nudges < MAX_NUDGES) {
        nudges++;
        messages.push({ role: "user", content: IDLE_NUDGE });
        continue;
      }
      stopReason = "idle";
      break;
    }

    let submitted = false;
    for (const call of toolCalls) {
      const fn = /** @type {Record<string, unknown>} */ (call?.function ?? {});
      const name = typeof fn.name === "string" ? fn.name : "";
      const parsed = parseToolArguments(fn.arguments);
      const callId = typeof call?.id === "string" ? call.id : "";
      emit({ t: "tool-call", name, args: "args" in parsed ? parsed.args : fn.arguments });

      /** @type {{ text: string, isError: boolean }} */
      let result;
      if ("problem" in parsed) {
        result = { text: parsed.problem, isError: true };
      } else if (name === WRITEUP_TOOL_NAME) {
        const problem = writeupProblem(job, parsed.args);
        if (problem === undefined) {
          writeup = writeupFrom(job, parsed.args);
          const declared = parsed.args.gateChanges;
          if (typeof declared === "string" && declared.trim().length > 0) gateChanges = declared;
          submitted = true;
          result = { text: "write-up accepted; the task is finished", isError: false };
        } else {
          result = { text: `that write-up cannot be used: ${problem}. Call it again with that fixed.`, isError: true };
        }
      } else {
        result = await runTool(env, name, parsed.args);
      }

      emit({ t: "tool-result", name, text: result.text, isError: result.isError });
      messages.push({ role: "tool", tool_call_id: callId, content: clamp(result.text, job.maxToolOutputChars) });
      if (submitted) break;
    }

    if (submitted) {
      stopReason = "submitted";
      break;
    }
  }

  if (stopReason === "budget-exhausted") {
    emit({
      t: "note",
      text:
        `stopped on the spending cap for this call: $${spentUsd.toFixed(6)} of $${job.maxSpendUsd} spent, ` +
        `after ${turnsCompleted} model ${turnsCompleted === 1 ? "call" : "calls"}`,
    });
  }

  // Saved whatever the outcome, so a fix round can pick up this exact
  // context - including the round that ran out of money, which is
  // precisely the one a Client is most likely to continue. A failure to
  // save costs the warm resume, nothing more: the work itself is
  // already on disk in the worktree, and losing it must not turn a
  // finished attempt into a failed one.
  try {
    saveSession(job.sessionId, messages);
  } catch (err) {
    emit({ t: "note", text: `this call's session could not be saved, so a fix round will start cold: ${err instanceof Error ? err.message : String(err)}` });
  }

  return {
    ok: stopReason === "submitted",
    stopReason,
    turnsCompleted,
    totalCostUsd: costKnown ? spentUsd : null,
    session: job.sessionId,
    ...(writeup === undefined ? {} : { writeup }),
    ...(gateChanges === undefined ? {} : { gateChanges }),
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * Runs one "ask" job: SPEC.md step 2's single clarifying call. No tools,
 * no session, one call, bounded by `askMaxTokens` - there is nothing for
 * a loop to do here, and nothing on disk for this call to touch (the
 * host runs it against an empty scratch directory, so CONTRACT rule 1
 * holds by construction).
 * @param {AgentJob} job
 * @param {(line: AgentLine) => void} emit
 * @param {{ chat?: typeof chatCompletion }} deps
 * @returns {Promise<AgentResult>}
 */
export async function runAsk(job, emit, deps) {
  const chat = deps.chat ?? chatCompletion;
  /** @type {Record<string, unknown>} */
  let response;
  try {
    response = await chat(job, {
      messages: [{ role: "user", content: job.brief }],
      ...(job.askMaxTokens === undefined ? {} : { max_tokens: job.askMaxTokens }),
    });
  } catch (err) {
    return {
      ok: false,
      stopReason: "api-error",
      turnsCompleted: 0,
      totalCostUsd: job.costSource === "free" ? 0 : null,
      session: job.sessionId,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const usage = usageFrom(response.usage, job.costSource);
  emit({ t: "usage", turn: 1, usage, costSource: job.costSource });

  const choice = /** @type {Record<string, unknown>} */ (/** @type {any[]} */ (response.choices)[0] ?? {});
  const message = /** @type {Record<string, unknown>} */ (choice.message ?? {});
  const content = typeof message.content === "string" ? message.content : "";
  if (content.trim().length > 0) emit({ t: "text", text: content });

  return {
    ok: true,
    stopReason: "answered",
    turnsCompleted: 1,
    totalCostUsd: usage.costUsd,
    session: job.sessionId,
    questions: questionsFrom(content),
  };
}

/**
 * The clarifying answer's questions. The model is asked for bare JSON
 * but may fence it anyway; anything that still is not the shape asked
 * for means "nothing to ask," never a failed task - over-asking and
 * crashing are both worse than proceeding (see ../../README.md's
 * `ask(brief)` section).
 * @param {string} text
 * @returns {string[]}
 */
export function questionsFrom(text) {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  try {
    const parsed = JSON.parse(fenced ? fenced[1] : text.trim());
    const questions = /** @type {Record<string, unknown>} */ (parsed ?? {}).questions;
    if (!Array.isArray(questions)) return [];
    return questions.filter((q) => typeof q === "string" && q.trim().length > 0);
  } catch {
    return [];
  }
}
