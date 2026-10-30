// One read: a whole diff in, a list of things to look at out.
//
// What the reader is, in the Client's own framing (inspector issue #34
// and its amendment): a flagger. It never blocks and never approves.
// There is no verdict in anything it returns and no severity on any
// finding - a clean read is an empty list, and everything it does flag
// goes to the worker as-is for the worker's own judgment. That is why
// the prompt below forbids a verdict rather than merely not asking for
// one: a reader that answered "looks good to me" would be approving,
// which is Inspector's job and the Client's, never this one's.

import { askCommandReader, askReader } from "./call.ts";
import type { CallOptions, ReaderMessages } from "./call.ts";
import type { ReaderFinding, ReaderReport, ResolvedReader } from "./types.ts";

/** Past this much diff the read is refused rather than trimmed. A
 * truncated read presented as a read is the one dishonest option here -
 * the whole point is that the *whole* diff is read - and a refusal is
 * free, because a failed read never blocks a delivery: it lands on the
 * record as `reader-failed` naming both numbers, and the task goes on.
 * Generous enough that no ordinary change meets it. */
export const MAX_DIFF_BYTES = 1_000_000;

/** How the record and the delivery name the model that did the reading:
 * the Client's own spelling from projects.toml, both halves, so a
 * `[reader]` changed later is still legible against an old read. */
export function readerLabel(reader: ResolvedReader): string {
  return `${reader.vendor}/${reader.model}`;
}

const SYSTEM_PROMPT = [
  "You are a code reader. A change has already passed an independent check and is about to be handed to a",
  "human reviewer. Your one job is to read the whole diff and flag what that reviewer should look at.",
  "",
  "You are not a gate. You do not approve and you do not block: nothing you say stops this change or lets",
  "it through. Do not give a verdict, a score, a severity or an overall opinion.",
  "",
  "Flag only things a reviewer would genuinely want to know: a bug, a case the change does not handle, a",
  "contradiction between the change and the code around it, something the change clearly meant to do and",
  "did not, a silently dropped error, an unsafe assumption. Do not flag style, formatting, naming taste, or",
  "anything a reader of the diff can already see for themselves. If the diff gives you nothing worth a",
  "reviewer's attention, say so by returning an empty list - that is a normal and expected answer.",
  "",
  'Answer with JSON and nothing else, in exactly this shape: {"findings": [{"file": "<path>", "finding":',
  '"<what is wrong, in one or two sentences>"}]}. Use the paths exactly as the diff names them. Return',
  '{"findings": []} when there is nothing to flag.',
].join("\n");

/** The same shape the prompt asks for, as a JSON Schema - for a reader
 * reached by a command that can be handed one (issue #315), so its
 * answer comes back already structured instead of fished out of prose.
 * The prompt above still asks in words as well: the two must agree, and
 * a vendor reached over HTTP is asked in words only, since this module
 * sends no provider-specific response-format field (the one request
 * shape it makes is the plain chat-completions one, nothing more).
 *
 * `findings` is required and `additionalProperties` closed, so an empty
 * list is something the model said and never something a parser assumed
 * - the same line `parseFindings` draws below. */
export const FINDINGS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "finding"],
        properties: {
          file: { type: "string", minLength: 1 },
          finding: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

/**
 * Reads one diff. Resolves with the report - including a clean one -
 * and throws an Error, written for the Client, for every way a read can
 * fail: a diff too large to send, an unreachable or refusing model, an
 * answer that cannot be read as findings. The caller records that as
 * `reader-failed` and delivers anyway.
 */
export async function readDiff(
  reader: ResolvedReader,
  diff: string,
  opts: CallOptions = {}
): Promise<ReaderReport> {
  const diffBytes = Buffer.byteLength(diff, "utf8");
  if (diffBytes === 0) {
    // Nothing to read is a clean read, not a failure: a round can
    // legitimately end green with an empty diff (a fix round whose
    // worker changed nothing), and calling a model about nothing would
    // spend money to be told nothing.
    return { model: readerLabel(reader), findings: [], diffBytes };
  }
  if (diffBytes > MAX_DIFF_BYTES) {
    throw new Error(
      `the diff is too large to read in one call (${diffBytes} bytes, ceiling ${MAX_DIFF_BYTES}). ` +
        `Nothing was read - the whole diff is what goes to the reader, so it is refused rather than trimmed.`
    );
  }

  const messages: ReaderMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Here is the whole diff of the change.\n\n${diff}` },
  ];
  // The one branch in this module about how the model is reached (issue
  // #315). Everything after it - the parsing, the report, the findings
  // that go to the machine, the delivery - is the same code either way,
  // which is the point: a project on a work account whose only access is
  // a command on the host gets the same read as one with a key.
  const answer =
    reader.via === "command"
      ? await askCommandReader(reader, messages, FINDINGS_JSON_SCHEMA, opts)
      : await askReader(reader, messages, opts);

  return { model: readerLabel(reader), findings: parseFindings(answer), diffBytes };
}

/**
 * The findings out of whatever the model actually said.
 *
 * Deliberately tolerant about the wrapping and strict about the
 * content: models fence JSON in backticks and add a sentence before it
 * however firmly they are asked not to, and refusing a read over that
 * would throw away a good answer. What is not tolerated is an entry
 * that does not name both a file and a finding - a half-finding handed
 * to a worker is an instruction to guess.
 *
 * Throws, with the model's own text quoted, when there is no findings
 * array to be found at all. That is a failed read, not a clean one: a
 * clean read has to be something the model said, never something the
 * parser gave up and assumed.
 */
export function parseFindings(answer: string): ReaderFinding[] {
  const json = extractJsonObject(answer);
  if (json === undefined) {
    throw new Error(`the reader's answer held no JSON object: ${oneLine(answer)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `the reader's answer was not valid JSON (${err instanceof Error ? err.message : String(err)}): ${oneLine(answer)}`
    );
  }

  const findings = (parsed as Record<string, unknown> | null)?.findings;
  if (!Array.isArray(findings)) {
    throw new Error(`the reader's answer held no "findings" array: ${oneLine(answer)}`);
  }

  return findings.map((entry, index) => {
    const record = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    const file = typeof record.file === "string" ? record.file.trim() : "";
    const finding = typeof record.finding === "string" ? record.finding.trim() : "";
    if (file.length === 0 || finding.length === 0) {
      throw new Error(
        `the reader's finding ${index + 1} is missing a file or a finding: ${oneLine(JSON.stringify(entry))}`
      );
    }
    return { file, finding };
  });
}

/** The outermost `{...}` in a blob of text, fences and prose and all.
 * Brace-counting rather than a regex, so a brace inside a finding's own
 * text can't end the object early; string literals are tracked for the
 * same reason, since a quoted brace is not a brace. */
function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Someone else's text, folded onto one line and capped, for a message
 * that has to stay readable in a status line and a delivery. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 400 ? `${flat.slice(0, 400)}...` : flat;
}
