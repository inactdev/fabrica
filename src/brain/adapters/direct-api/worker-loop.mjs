// Runs entirely inside one containment call (src/brain/adapters/direct-api/
// index.ts's `runContained` invocation) - plain Node, no project imports,
// because nothing but Node itself is guaranteed to exist inside that
// container. This is the "small agent in its own right" adapters/README.md
// says a direct-API adapter has to be: unlike a CLI adapter (which hands a
// brief to an existing coding-agent binary), there is no such binary here -
// this file IS the loop that reads files, writes them, and runs commands
// against /workdir, driven by an OpenAI-compatible /chat/completions
// endpoint (both OpenRouter and Ollama's own OpenAI-compatible surface
// speak the identical shape - see direct-api.md for what was verified
// where).
//
// Talks to the outside only over stdout, as newline-delimited JSON: one
// line per transcript entry as it happens, then exactly one final
// "result" line. A fatal error (the HTTP call itself failing, an
// unreadable config) writes to stderr and exits non-zero instead -
// index.ts tells the two apart by exit code, the same way claude-code.ts
// reads its own CLI's exit code.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_TURNS = 40;
const SESSION_FILE_NAME = ".fabrica-direct-api-session.json";

// Mirrors src/brain/writeup.ts's WRITEUP_FIELDS - duplicated, not
// imported (this file has no project imports at all; see this file's own
// header). Keep the two lists in sync by hand if that shape ever changes.
const WRITEUP_FIELDS = ["title", "what", "why", "how", "deviations"];

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from the project, by path relative to the project root.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path relative to the project root." } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a UTF-8 text file in the project, by path relative to the project root. " +
        "Creates parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the project root." },
          content: { type: "string", description: "The file's complete new contents." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command (bash -c) in the project root and get back its combined stdout, stderr, and exit code.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The shell command to run." } },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_writeup",
      description:
        "Finish the task and submit your write-up. Call this exactly once, only once the work is actually done.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Your own words, at most 60 characters, summarizing the change." },
          what: { type: "string" },
          why: { type: "string" },
          how: { type: "string" },
          deviations: { type: "string", description: 'What you deviated from the request and why, or "None."' },
          gateChanges: {
            type: "string",
            description:
              "Only if you changed the project's own tests or check settings: which check changed, and why. " +
              "Omit this field entirely otherwise.",
          },
        },
        required: [...WRITEUP_FIELDS],
        additionalProperties: false,
      },
    },
  },
];

const SYSTEM_PROMPT =
  "You are an autonomous coding agent. The project is checked out at the current working directory. " +
  "Use read_file/write_file/run_command to read, change, and verify the project however the task needs - " +
  "run_command is a real bash shell in the project root. When, and only when, the work is genuinely done, " +
  "call submit_writeup exactly once with your write-up; do not type the write-up out as plain text.";

function now() {
  return new Date().toISOString();
}

function emit(entry) {
  process.stdout.write(`${JSON.stringify({ type: "entry", entry: { occurredAt: now(), ...entry } })}\n`);
}

function sessionPath() {
  return join(homedir(), SESSION_FILE_NAME);
}

function loadSession() {
  const file = sessionPath();
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed?.messages) ? parsed.messages : undefined;
  } catch {
    return undefined;
  }
}

function saveSession(messages) {
  writeFileSync(sessionPath(), JSON.stringify({ messages }));
}

async function chatCompletion({ baseUrl, apiKey, model, messages, tools }) {
  const body = { model, messages };
  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`could not reach ${baseUrl}/chat/completions: ${err.message}`);
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${baseUrl}/chat/completions returned non-JSON (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }
  if (!res.ok) {
    throw new Error(`${baseUrl}/chat/completions returned HTTP ${res.status}: ${parsed?.error?.message ?? text.slice(0, 500)}`);
  }
  return parsed;
}

/** The "usage" transcript entry contract/surface.ts's TranscriptEntry
 * documents: a JSON { totalCostUsd, costBasis } string. Ollama is local -
 * a real, known, exact zero, not an unreported unknown - everything else
 * (OpenRouter included) reports null unless the response's own `usage.cost`
 * is a real number, never guessing zero for a provider that simply didn't say. */
function usageEntry(parsed, backendName) {
  let totalCostUsd = null;
  if (backendName === "ollama") {
    totalCostUsd = 0;
  } else {
    const cost = parsed?.usage?.cost;
    if (typeof cost === "number" && Number.isFinite(cost)) totalCostUsd = cost;
  }
  return { kind: "usage", text: JSON.stringify({ totalCostUsd, costBasis: "metered" }) };
}

function executeTool(name, args) {
  try {
    if (name === "read_file") {
      return { ok: true, text: readFileSync(args.path, "utf8") };
    }
    if (name === "write_file") {
      const dir = dirname(args.path);
      if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
      writeFileSync(args.path, args.content ?? "");
      return { ok: true, text: "ok" };
    }
    if (name === "run_command") {
      const result = spawnSync(args.command, {
        shell: "/bin/bash",
        encoding: "utf8",
        cwd: process.cwd(),
        timeout: 10 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
      });
      if (result.error) return { ok: false, text: `could not run the command: ${result.error.message}` };
      const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      return { ok: result.status === 0, text: `exit ${result.status ?? "null"}\n${combined}` };
    }
    return { ok: false, text: `unknown tool: ${name}` };
  } catch (err) {
    return { ok: false, text: `error: ${err.message}` };
  }
}

/** The model is asked for bare JSON but may still fence it - same
 * defensive parse claude-code.ts's parseAskResult uses, duplicated here
 * for the same reason WRITEUP_FIELDS is (no project imports in this
 * file). */
function parseAskResult(text) {
  const trimmed = (text ?? "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    const parsed = JSON.parse(candidate);
    const questions = parsed?.questions;
    if (Array.isArray(questions)) {
      const kept = questions.filter((q) => typeof q === "string" && q.trim().length > 0);
      return kept;
    }
  } catch {
    // Not parseable JSON - nothing to ask, same bias toward not
    // over-asking on an uncertain formatting slip.
  }
  return [];
}

async function runAsk(input, apiKey) {
  const prompt =
    "You are deciding whether a task description is materially ambiguous before any work starts on it - " +
    "ambiguous in a way that would change what actually gets built, not something a reasonable person would " +
    "fill in the same way every time. If it is materially ambiguous, write the numbered questions whose " +
    "answers would change what gets built. If it is already clear enough to proceed, ask nothing. The " +
    "project's files are not present at this step on purpose, so ask only about what is wanted, never about " +
    "where the code is.\n\nRespond with ONLY a JSON object, no other text before or after it, in exactly this " +
    'shape:\n{"questions": ["question one", "question two"]}\nor, if nothing needs asking:\n' +
    `{"questions": []}\n\nTask:\n${input.brief}`;

  const parsed = await chatCompletion({
    baseUrl: input.baseUrl,
    apiKey,
    model: input.model,
    messages: [{ role: "user", content: prompt }],
  });
  const usage = usageEntry(parsed, input.backendName);
  emit(usage);
  const costUsd = JSON.parse(usage.text).totalCostUsd;
  const content = parsed.choices?.[0]?.message?.content ?? "";
  const questions = parseAskResult(content);
  process.stdout.write(`${JSON.stringify({ type: "result", mode: "ask", questions, costUsd })}\n`);
}

async function runWork(input, apiKey) {
  const priorMessages = input.hasSession ? loadSession() : undefined;
  const messages = priorMessages ?? [{ role: "system", content: SYSTEM_PROMPT }];
  messages.push({ role: "user", content: input.brief });

  let finished = null;
  let knownSpentUsd = 0;
  let noToolCallStreak = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (input.maxSpendUsd !== null && input.maxSpendUsd !== undefined && knownSpentUsd !== null && knownSpentUsd >= input.maxSpendUsd) {
      break;
    }

    const parsed = await chatCompletion({
      baseUrl: input.baseUrl,
      apiKey,
      model: input.model,
      messages,
      tools: TOOLS,
    });
    const usage = usageEntry(parsed, input.backendName);
    emit(usage);
    const turnCost = JSON.parse(usage.text).totalCostUsd;
    knownSpentUsd = knownSpentUsd === null || turnCost === null ? null : knownSpentUsd + turnCost;

    const message = parsed.choices?.[0]?.message ?? {};
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
    if (message.content) emit({ kind: "text", text: message.content });
    if (typeof message.reasoning === "string" && message.reasoning) emit({ kind: "reasoning", text: message.reasoning });

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length === 0) {
      if (noToolCallStreak >= 1) break;
      noToolCallStreak += 1;
      messages.push({
        role: "user",
        content: "Continue the task. Call a tool to keep working, or call submit_writeup when you are completely done.",
      });
      continue;
    }
    noToolCallStreak = 0;

    for (const call of toolCalls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        args = {};
      }
      emit({ kind: "tool-call", text: `${name}(${JSON.stringify(args)})` });

      if (name === "submit_writeup") {
        finished = args;
        messages.push({ role: "tool", tool_call_id: call.id, content: "ok" });
        continue;
      }
      const result = executeTool(name, args);
      emit({ kind: result.ok ? "tool-result" : "tool-error", text: result.text });
      messages.push({ role: "tool", tool_call_id: call.id, content: result.text });
    }
    if (finished) break;
  }

  saveSession(messages);

  const writeup = finished
    ? Object.fromEntries(WRITEUP_FIELDS.map((field) => [field, typeof finished[field] === "string" ? finished[field] : ""]))
    : null;
  const gateChanges = finished && typeof finished.gateChanges === "string" ? finished.gateChanges : null;
  process.stdout.write(`${JSON.stringify({ type: "result", mode: "work", writeup, gateChanges, session: "direct-api" })}\n`);
}

async function main() {
  const input = JSON.parse(process.env.DIRECT_API_INPUT || "{}");
  const apiKey = process.env.DIRECT_API_KEY || undefined;
  if (input.mode === "ask") {
    await runAsk(input, apiKey);
  } else {
    await runWork(input, apiKey);
  }
}

main().catch((err) => {
  process.stderr.write(`${(err && err.stack) || err}\n`);
  process.exitCode = 1;
});
