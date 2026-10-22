// The shapes of Fabrica's record: the append-only event log plus the
// per-task folders it is the single source of truth for.
// SPEC.md "The record": events.jsonl is authoritative; everything else
// (request.md, answers.md, brief.md, plan.md, delivery.md, verdict,
// transcript.log) is a convenience view of it.

// The base record shapes are ratified in contract/surface.ts. Fabrica's
// own additions to that closed set - Inspector's trigger and result
// events, and the Client's own "stopped-by-owner" - extend it in
// src/inspector/types.ts, the single place that widening happens.
import type { FabricaEvent, FabricaEventName } from "../inspector/types.ts";
export type { FabricaEvent, FabricaEventName };

/** Input to appendEvent: `occurredAt` is stamped by the record, never the caller. */
export type NewFabricaEvent = Omit<FabricaEvent, "occurredAt">;

/**
 * The files a task folder holds (SPEC.md "The record"). `request.md`
 * is the Client's words verbatim, written once and never appended to;
 * `answers.md` holds one section per clarification round; `brief.md` is
 * assembled from request plus every answer, and is the document a Worker
 * actually receives.
 */
export type TaskFile =
  | "request.md"
  | "answers.md"
  | "brief.md"
  | "plan.md"
  | "delivery.md"
  | "verdict"
  | "transcript.log"
  /** Inspector's own `.inspector/latest.json`, copied in before the
   * worktree it lived in is destroyed - see src/foreman/inspection.ts. */
  | "inspector-latest.json"
  /** The run file latest.json's "run" field named, under `.inspector/runs/`. */
  | "inspector-run.json"
  /** The issue the chat agent named explicitly at `fabrica do` time
   * (`do(..., { issue })`), plain text, written once at registration -
   * never derived from task text, which is re-read from request.md
   * instead. A bare number for an issue in the project's own
   * repository, `owner/repo#N` for one explicitly pointed elsewhere.
   * See src/foreman/task-issue.ts's `storedClosesIssue`. */
  | "issue"
  /** That issue's own title and body, fetched once at registration and
   * frozen for the life of the task - what every round's brief carries,
   * so a task worded "do issue #N as written" never has to ask what #N
   * says. See src/foreman/task-issue.ts. */
  | "issue.md"
  /** Which model this task asked for and where that came from (issue
   * #184), as JSON - `src/foreman/model.ts`'s `ModelChoice`, written
   * once at registration. Every later round re-derives the worker's
   * model from here rather than from a parameter it never receives,
   * the same way `issue` is re-read. */
  | "model.json"
  /** The caps (rule 10) this task actually started under, as JSON,
   * written once at registration - so a cost meter shown weeks later
   * reports the ceiling the task was held to rather than whatever
   * projects.toml happens to say when it is read (issue #203). */
  | "caps.json"
  /** The pid of the detached process running this task's current round,
   * written by that process itself (src/cli/task-process.ts) - the only
   * pid `stop` will ever consider signaling, and never trusted without
   * re-verifying it against the real process table first. */
  | "worker.pid";
