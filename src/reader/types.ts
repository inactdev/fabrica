// The shapes of a settled code reader and of what one read produces.
// Internal to src/ - none of this is a promise Fabrica makes the
// Client, so none of it belongs in contract/surface.ts; `[reader]`'s
// own written-down shape (ReaderConfig) lives with the rest of
// projects.toml, in src/config.

/** A reader settled enough to call: which model, where, and with what.
 * Unlike a reviewer - which is handed to Inspector as two flags for
 * Inspector to dial itself - Fabrica makes this call, so it needs the
 * endpoint too, and that is why `baseUrl` is required here and
 * optional there. */
export interface ResolvedReader {
  vendor: string;
  model: string;
  /** `<VENDOR>_API_KEY` and its value. Never printed and never put in
   * any environment: it goes into one request's `Authorization` header
   * and nowhere else. */
  apiKeyVar: string;
  apiKey: string;
  /** `<VENDOR>_BASE_URL` and its value - the chat-completions endpoint
   * root, without the `/chat/completions` suffix. Required: Fabrica
   * dials this itself, holds no vendor-to-endpoint table, and has no
   * business holding one (the same reasoning that keeps every vendor
   * name out of this module). */
  baseUrlVar: string;
  baseUrl: string;
}

/** The two answers "who reads this project" can have. There is
 * deliberately no `none`: the reader is wired into every task, so a
 * project Inspector runs on either has one or is refused. */
export type ReaderResolution =
  | { kind: "reader"; reader: ResolvedReader }
  | { kind: "refused"; message: string };

/** One thing the reader flagged. Nothing here ranks or filters: there
 * is no severity field, because the ruling is that every finding goes
 * to the worker as-is and the worker's own judgment decides (it may
 * decline one, with a reason). */
export interface ReaderFinding {
  /** Repository-relative path the finding is about, as the reader named
   * it. Free text: it is shown to a worker and to a reviewer, never
   * resolved against the filesystem or used to open anything. */
  file: string;
  /** What the reader thinks is wrong, in its own words. */
  finding: string;
}

/** What the worker said about one finding it was handed. A finding the
 * worker acted on carries no entry; a finding it declined carries the
 * reason it gave, which rides into the delivery beside the finding. */
export interface ReaderDecline {
  /** Which finding, numbered exactly as the worker's own brief numbered
   * them: 1-based. One numbering end to end - the brief the worker
   * read, the file it wrote back, the record, and the delivery the
   * Client reads - so nobody has to translate between two. */
  finding: number;
  reason: string;
}

/** One completed read: what was flagged, and by which model. This is
 * what lands on the record and on the delivery (inspector issue #34:
 * "the findings and the model used are on the record and in the
 * delivery"). */
export interface ReaderReport {
  /** `"<vendor>/<model>"` - how the read names the model that produced
   * it, in the Client's own spelling from projects.toml. */
  model: string;
  /** Empty means a clean read: nothing was flagged, so no fix round
   * ran and the record says so. */
  findings: ReaderFinding[];
  /** How many bytes of diff were read. Recorded so a surprisingly
   * empty read on a large change is visible as such. */
  diffBytes: number;
}

/** A read that never produced findings, with the reason written for the
 * Client. Never blocks a delivery and is never silent: it lands on the
 * record, on the status row, on the delivery, and in `fabrica status`'s
 * own count. */
export interface ReaderFailure {
  model: string;
  error: string;
}

/** The one shape a round's reader stage hands back. */
export type ReaderOutcome =
  | { kind: "clean"; report: ReaderReport }
  | {
      kind: "flagged";
      report: ReaderReport;
      declines: ReaderDecline[];
      /** Anything about the worker's own answer that could not be read
       * (`ParsedDeclines.problem`) - carried rather than dropped,
       * because the alternative is a delivery that reads as "the worker
       * acted on everything" when nobody knows that. */
      declineProblem?: string;
    }
  | { kind: "failed"; failure: ReaderFailure };

/** One finding as the delivery shows it: the reader's own words, plus
 * the worker's reason for declining it where it declined one. */
export interface ReadFinding extends ReaderFinding {
  declined?: string;
}

/** The read, as the delivery and the record both report it. Declared
 * here rather than in `contract/surface.ts` for the same reason
 * `src/inspector/types.ts` widens `Delivery` at all: the contract is a
 * path `rule9-gate.yml` protects, and what a flagger found is Fabrica's
 * own bookkeeping about a change, not a new promise about a seam. */
export interface ReaderOnDelivery {
  /** `"<vendor>/<model>"` - which model read the diff. */
  model: string;
  /** `clean` found nothing (so no fix round ran), `flagged` found
   * something (so one did), `failed` never produced findings at all -
   * which never blocks the delivery and is never silent. */
  state: "clean" | "flagged" | "failed";
  /** Empty for `clean` and for `failed`. */
  findings: ReadFinding[];
  /** `failed` only: the reason, written for the Client. */
  error?: string;
  /** Anything about the worker's own answer that could not be read. */
  note?: string;
}
