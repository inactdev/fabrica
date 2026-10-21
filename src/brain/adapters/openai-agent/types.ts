// Shapes shared between openai-compatible.ts (runs on the host, starts
// the box) and the .mjs files in this directory (run *inside* it, typed
// from here via JSDoc `import("./types.ts")` so nothing TypeScript is
// ever imported at runtime - the same split src/relay/container/types.ts
// uses, for the same reason: the box runs plain `node`, with no tsx and
// no node_modules).
//
// Nothing here is shared with contract/surface.ts. A direct-API worker's
// own plumbing is not a promise to the Client; the only promise is the
// `Brain` seam openai-compatible.ts implements.

/** Where a dollar figure for one API call comes from. Never a price
 * table in this repo: a per-million-token price that silently goes stale
 * would report invented money as `costBasis: "metered"`, which is
 * exactly the thing rule 10 must not do.
 *
 * - `"reported"` - the provider puts the real charge on its own usage
 *   object (`usage.cost`), so the figure is the provider's, not ours.
 * - `"free"` - a server the Client runs themselves, which bills nothing
 *   per call; $0.00 is the honest metered figure, not an unknown.
 *
 * A `"reported"` call whose response carries no `cost` is an unknown
 * cost, never a zero - the host turns that into a receipt rule 10
 * blocks on until it is recorded by hand. */
export type CostSource = "reported" | "free";

/** One API call's usage, as this agent reports it on its own stdout. */
export interface AgentUsage {
  /** The provider's own charge for this call, or null when it reported
   * none and the target is not a free one. */
  costUsd: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
}

/** Everything one chat-completions call needs to know about where it is
 * going. Its own interface, rather than the whole job, so anything that
 * needs to make one call - `fabrica doctor --live`'s probe, for
 * instance - needs no stub of a job it is not running. */
export interface ChatTarget {
  /** Base URL for the API, with its path prefix: `/chat/completions` is
   * appended to it. */
  endpoint: string;
  /** What goes in `Authorization: Bearer ...`, or null to send no
   * credential at all (which a local server accepts). For a worker box
   * this is always a per-call placeholder: the relay holds the real
   * credential and swaps it in on the way out. */
  apiKey: string | null;
  /** The model id, exactly as the target names it. */
  model: string;
}

/** What `main.mjs` reads out of the job file openai-compatible.ts writes
 * next to it. One file, not argv and not a pile of env vars, because the
 * brief alone can be tens of kilobytes - well past what an `--env-file`
 * line or a command line is a sensible home for. */
export interface AgentJob extends ChatTarget {
  /** "work" runs the tool loop; "ask" is SPEC.md step 2's single,
   * tool-free clarifying call (see `Brain.ask`). */
  mode: "work" | "ask";
  /** The brief, verbatim - standing question, write-up notice and all. */
  brief: string;
  /** Rule 10's remaining per-task budget for this one call, in dollars.
   * Never null in "work" mode: openai-compatible.ts refuses the call
   * outright before any box starts when it has no cap to pass (issue
   * #200). "ask" mode carries null - that call takes no cap through the
   * `Brain` seam at all, and is bounded by `askMaxTokens` instead. */
  maxSpendUsd: number | null;
  costSource: CostSource;
  /** Hard ceiling on API calls, so a loop that neither finishes nor
   * spends can still only run so long. */
  maxTurns: number;
  /** "ask" mode only: `max_tokens` for that one call. */
  askMaxTokens?: number;
  /** `reasoning_effort`, when the caller asked for one. Passed through
   * as-is; a provider that does not know the value is expected to
   * ignore it, which is also the `Brain` contract's own rule. */
  reasoningEffort?: string;
  /** Minted by the host every call. The agent writes this call's full
   * message history under `$HOME` keyed by this id, so a later call can
   * resume it - a direct-API provider holds no session of its own. */
  sessionId: string;
  /** A prior `sessionId` to continue instead of starting cold. */
  resumeSessionId?: string;
  /** The write-up tool's `parameters` schema, built on the host from
   * src/brain/writeup.ts so this directory never restates the field
   * list or the title limit. */
  writeupSchema: unknown;
  /** The write-up's required string fields and title limit, from the
   * same single source, for the agent's own check on submission. */
  writeupStringFields: string[];
  /** The write-up's *optional* string fields, from that same source.
   * Separate from the required list because the two are checked
   * differently: a missing one of these is not a problem, and an empty
   * one is dropped rather than reported. Carried over the job file so
   * this directory still restates no field name of its own. */
  writeupOptionalStringFields: string[];
  writeupTitleMaxLength: number;
  /** How many questions the write-up's quiz must hold - exactly this
   * many (issue #98). A number rather than a rule restated in the
   * agent, from the same single source as the title limit above. */
  writeupQuizLength: number;
  /** How much of one tool result is kept, in characters - for the model
   * and for the transcript alike. A check's full output can be
   * megabytes; a context window cannot. */
  maxToolOutputChars: number;
  /** Default timeout for the `bash` tool, in milliseconds. */
  bashTimeoutMs: number;
}

/** One line of the agent's stdout: NDJSON, one object per line, mapped
 * to transcript entries by the host the instant each newline lands
 * (issue #70's live transcript). */
export type AgentLine =
  | { t: "text"; text: string }
  | { t: "tool-call"; name: string; args: unknown }
  | { t: "tool-result"; name: string; text: string; isError: boolean }
  | { t: "usage"; turn: number; usage: AgentUsage; costSource: CostSource }
  | { t: "note"; text: string }
  | { t: "result"; result: AgentResult };

/** Why the loop stopped. */
export type AgentStopReason =
  /** The model called the write-up tool - the only clean finish. */
  | "submitted"
  /** The next call would have crossed `maxSpendUsd` (issue #200's cap,
   * metered as it goes: the call that crossed the line is paid for and
   * reported, and no further call is made). */
  | "budget-exhausted"
  | "max-turns"
  /** The model stopped calling tools and stopped asking for anything. */
  | "idle"
  /** The provider refused or failed and retries ran out. */
  | "api-error"
  /** "ask" mode's own clean finish: one call, one answer. */
  | "answered"
  /** The job itself carried no cap, so not one API call was made. The
   * host refuses this before any box starts (issue #200); the agent
   * checks it again so no way of starting it can spend uncapped money. */
  | "no-cap"
  /** Something inside the agent failed unexpectedly. The cost is
   * reported as unknown rather than zero, since a failure late in a
   * loop has already spent real money (rule 10: never count an
   * unmeasured spend as $0). */
  | "internal-error";

/** The agent's last line - everything the host cannot know until the
 * process has actually finished. */
export interface AgentResult {
  ok: boolean;
  stopReason: AgentStopReason;
  /** Every API call this process made that the provider actually
   * answered. Zero means nothing was done and nothing was spent, which
   * the host reports as a failed call rather than an empty delivery. */
  turnsCompleted: number;
  /** Sum of every call's reported cost. Null when any one of them was
   * unknown - never silently treated as zero (rule 10). */
  totalCostUsd: number | null;
  session: string;
  /** "work" mode: the write-up, when the model submitted a valid one. */
  writeup?: unknown;
  /** "work" mode: the worker's own rule 9 declaration, when it made one. */
  gateChanges?: string;
  /** "ask" mode: the clarifying questions, or an empty list. */
  questions?: string[];
  /** Set when `ok` is false: what went wrong, for the Client to read. */
  error?: string;
}
