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
  tool_result: ["content", "is_error"], // is_error is only present when true - absence is a valid shape, not a gap.
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

// Every result key and block-type/key pair present in `reference` (the
// real, recorded sample) must also be present in `candidate` (the fake),
// with the same JS type. A key `reference` never demonstrated having is
// not checked - the fixture only proves what it actually exercised.
export function shapeDiff(reference: StreamJsonShape, candidate: StreamJsonShape): string[] {
  const problems: string[] = [];

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
