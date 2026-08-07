// Extracts a structural "shape" from parsed `claude --output-format
// stream-json` lines - which keys are present and what JS type each holds
// - restricted to exactly the fields claude-code.ts's parseLines()/
// toTranscript() actually read (see that file's ClaudeStreamLine/
// ClaudeStreamBlock interfaces). Restricting to that allowlist is
// deliberate: an irrelevant field the real CLI adds or removes must never
// fail fake-claude-cli.test.ts's shape-parity test, only a field the
// adapter depends on.

export interface StreamJsonShape {
  lineTypes: Set<string>;
  result: Record<string, string> | null; // key -> typeof value, including "usage.<key>"
  blocks: Record<string, Record<string, string>>; // block type -> (key -> typeof value)
}

const RESULT_KEYS = ["is_error", "session_id", "total_cost_usd", "duration_ms", "result", "api_error_status"];
const USAGE_KEYS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
const BLOCK_KEYS: Record<string, string[]> = {
  text: ["text"],
  thinking: ["thinking"],
  tool_use: ["name", "input"],
  tool_result: ["content", "is_error"],
};

// shapeDiff() is driven entirely by the reference side, so an allowlist
// key the recorded sample never demonstrates is never compared against
// the fake at all. These are the only allowlist keys a real recording
// isn't expected to prove, each with the reason it can't be demanded of
// one. Anything else missing from a recording is a silently narrowed
// guard: coverageGaps() names it, fake-claude-cli.test.ts fails on it
// for the committed fixture, and record-real-cli-fixture.mjs refuses to
// overwrite the fixture with it.
export const UNPROVABLE_BY_RECORDING: Record<string, string> = {
  "thinking.thinking":
    "the real CLI emits a thinking block only when the model actually thinks, which no fixed recording prompt can demand",
  "tool_result.is_error":
    "the real CLI omits it unless the tool call failed, and the recording prompt deliberately succeeds",
};

function typeOf(value: unknown): string {
  return value === null ? "null" : typeof value;
}

export function extractShape(lines: unknown[]): StreamJsonShape {
  const lineTypes = new Set<string>();
  let result: Record<string, string> | null = null;
  const blocks: Record<string, Record<string, string>> = {};

  for (const raw of lines) {
    const line = raw as Record<string, unknown>;
    if (typeof line?.type !== "string") continue;
    lineTypes.add(line.type);

    if (line.type === "result") {
      const shape: Record<string, string> = {};
      for (const key of RESULT_KEYS) {
        if (key in line) shape[key] = typeOf(line[key]);
      }
      const usage = line.usage as Record<string, unknown> | undefined;
      if (usage) {
        for (const key of USAGE_KEYS) {
          if (key in usage) shape[`usage.${key}`] = typeOf(usage[key]);
        }
      }
      result = shape;
    }

    if (line.type === "assistant" || line.type === "user") {
      const message = line.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const block of message?.content ?? []) {
        if (typeof block?.type !== "string") continue;
        const keys = BLOCK_KEYS[block.type];
        if (!keys) continue;
        const shape = blocks[block.type] ?? (blocks[block.type] = {});
        for (const key of keys) {
          if (key in block) shape[key] = typeOf(block[key]);
        }
      }
    }
  }

  return { lineTypes, result, blocks };
}

// Every line type, result key and block-type/key pair present in
// `reference` (the real, recorded sample) must also be present in
// `candidate` (the fake), with the same JS type. A key `reference` never
// demonstrated having is not checked - the fixture only proves what it
// actually exercised, which is what coverageGaps() below is for.
export function shapeDiff(reference: StreamJsonShape, candidate: StreamJsonShape): string[] {
  const problems: string[] = [];

  for (const lineType of reference.lineTypes) {
    if (!candidate.lineTypes.has(lineType))
      problems.push(`line type "${lineType}": present in reference, missing in candidate`);
  }

  if (reference.result) {
    if (!candidate.result) {
      problems.push('reference has a "result" line but the candidate has none');
    } else {
      for (const [key, type] of Object.entries(reference.result)) {
        const candidateType = candidate.result[key];
        if (candidateType === undefined) problems.push(`result.${key}: present in reference, missing in candidate`);
        else if (candidateType !== type)
          problems.push(`result.${key}: reference is ${type}, candidate is ${candidateType}`);
      }
    }
  }

  for (const [blockType, refShape] of Object.entries(reference.blocks)) {
    const candidateShape = candidate.blocks[blockType];
    if (!candidateShape) {
      problems.push(`block type "${blockType}": present in reference, missing in candidate`);
      continue;
    }
    for (const [key, type] of Object.entries(refShape)) {
      const candidateType = candidateShape[key];
      if (candidateType === undefined)
        problems.push(`block "${blockType}".${key}: present in reference, missing in candidate`);
      else if (candidateType !== type)
        problems.push(`block "${blockType}".${key}: reference is ${type}, candidate is ${candidateType}`);
    }
  }

  return problems;
}

// What a recorded sample fails to demonstrate, and therefore what
// shapeDiff() would never compare if that sample were used as the
// reference. Empty means the recording exercises every allowlist key
// except the ones UNPROVABLE_BY_RECORDING explains away.
export function coverageGaps(shape: StreamJsonShape): string[] {
  const gaps: string[] = [];

  if (!shape.result) {
    gaps.push('no "result" line at all');
  } else {
    for (const key of [...RESULT_KEYS, ...USAGE_KEYS.map((k) => `usage.${k}`)]) {
      if (`result.${key}` in UNPROVABLE_BY_RECORDING) continue;
      if (!(key in shape.result)) gaps.push(`result.${key}`);
    }
  }

  for (const [blockType, keys] of Object.entries(BLOCK_KEYS)) {
    const blockShape = shape.blocks[blockType];
    for (const key of keys) {
      if (`${blockType}.${key}` in UNPROVABLE_BY_RECORDING) continue;
      if (!blockShape || !(key in blockShape)) gaps.push(`block ${blockType}.${key}`);
    }
  }

  return gaps;
}
