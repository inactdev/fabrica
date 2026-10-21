// Turns the record into the shape the live view's page polls for. Every
// read goes through src/index.ts (Fabrica's one public entry point) and,
// for events, through `followTask` specifically - its line-by-line tail
// reader already skips a line that fails JSON.parse instead of throwing
// (src/foreman/follow.ts's `parseLine`, the same mechanism `fabrica watch`
// relies on), so one malformed line in events.jsonl can never take this
// page down. `readEvents`/`eventsByTask` are deliberately never used here:
// they read the whole file in one JSON.parse per line and are supposed to
// throw on corruption for `fabrica log`/`status`'s one-shot reads - a
// much bigger blast radius than this read-only viewer needs.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  daySpend,
  deliveryOf,
  describeTaskCost,
  describeMeters,
  earlyStopKindOf,
  finalMessageFor,
  followTask,
  formatUsd,
  hasAttempts,
  latestMeterReading,
  loadConfigOrProblem,
  quizEntriesOf,
  readTaskFile,
  refusalFor,
  standingOf,
  stateOf,
  taskSpend,
} from "../../src/index.ts";
import type {
  Caps,
  ConfigProblem,
  Delivery,
  FabricaEvent,
  FabricaTask,
  PauseRule,
  Receipt,
  TaskFollower,
  TranscriptEntry,
  WorkerWriteup,
  WriteupQuizEntry,
} from "../../src/index.ts";

/** How much of the task's own text stands in for a title before a
 * worker's write-up exists - long enough to be recognizable, short
 * enough to keep a list row to one line. */
const FALLBACK_TITLE_MAX_LENGTH = 60;

/** The states the page shows. Mostly a collapse of FabricaTask's own
 * richer union ("checking" folds into "working" - detail this tiny
 * dashboard deliberately doesn't surface), except "closed", which keeps
 * the Client's actual ruling rather than folding into generic "stopped":
 * a verdict is a resolved, known outcome, and reads as one. "stopped" is
 * reserved for the one state that really has no ruling behind it -
 * Inspector reaching no verdict at all (Client ruling, issue #26 review
 * finding: "keep 'stopped' only for a task that was actually stopped"). */
export type DisplayState =
  | "working"
  | "asked a question"
  | "delivered"
  | "failed"
  | "stopped"
  /** Issue #203: the Client stopped this task himself. Deliberately its
   * own word rather than folding into "stopped" above, which has meant
   * "Inspector reached no verdict" since issue #26 and is asserted as
   * such - two different outcomes reading as the same word on the same
   * page would be worse than a slightly longer label. (That earlier
   * ruling's own wording - keep "stopped" for a task that was actually
   * stopped - arguably now wants the refused label renamed instead;
   * that is the Client's to rule on, not something to change under a
   * ratified assertion's feet.) */
  | "stopped by you"
  | "closed (accept)"
  | "closed (wrong)"
  /** Defensive only: `stateOf` sets the raw "closed" state exclusively
   * from a verdict-recorded event whose own ruling is "accept" or
   * "wrong" (queries.ts), so `closedRuling` below should always be one
   * of those two whenever `state` is "closed". This exists so a caller
   * that somehow saw otherwise still gets a real string, never a crash. */
  | "closed";

export function displayState(state: FabricaTask["state"], closedRuling: "accept" | "wrong" | null = null): DisplayState {
  switch (state) {
    case "asking":
      return "asked a question";
    case "working":
    case "checking":
      return "working";
    case "delivered":
      return "delivered";
    case "failed":
      return "failed";
    case "closed":
      return closedRuling === "accept" ? "closed (accept)" : closedRuling === "wrong" ? "closed (wrong)" : "closed";
    case "refused":
      return "stopped";
    case "stopped":
      return "stopped by you";
  }
}

/** A task is history once nothing further is expected of it - every
 * closed verdict, a genuine stop, or an unresolved failure. */
export function isFinished(state: DisplayState): boolean {
  return (
    state === "failed" ||
    state === "stopped" ||
    state === "stopped by you" ||
    state === "closed (accept)" ||
    state === "closed (wrong)" ||
    state === "closed"
  );
}

/** The two states a task can be stopped from - what the review page's
 * "Running" section lists, and the only states the stop route itself
 * accepts (src/foreman/stop.ts's own RUNNING_STATES, which this agrees
 * with by construction: "checking" is projected onto "working" by
 * `displayState`, so one word covers both here). */
export function isRunning(state: DisplayState): boolean {
  return state === "working";
}

/** The ruling behind this task's most recent `verdict-recorded` event -
 * "fix" reopens the loop rather than closing it (rule 6), so only
 * "accept"/"wrong" are ever what makes `stateOf` report "closed" in the
 * first place; this reads the same event stateOf's own pass already
 * found, rather than re-deciding what counts as closed. */
function latestVerdictRuling(events: FabricaEvent[]): "accept" | "wrong" | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].name !== "verdict-recorded") continue;
    const ruling = (events[i].details as { ruling?: string } | undefined)?.ruling;
    if (ruling === "accept" || ruling === "wrong") return ruling;
  }
  return null;
}

/** One task, as every surface in this directory shows it. Issue #203
 * widened this to the full column set the list pages now render -
 * state, task, project, worker and model, network policy, trigger,
 * started, duration, cost (with its cap), checks, delivery, confidence -
 * every one of them derived from this task's own events (plus its
 * `issue`/`caps.json` task files), never from a live call anywhere. */
export interface TaskView {
  id: string;
  /** The write-up title once there is one, else the task text's first
   * line cut to ~60 characters - what a list row shows, nothing else. */
  title: string;
  project: string | null;
  state: DisplayState;
  taskText: string;
  attempt: number | null;
  costLabel: string;
  /** Issue #188: real, metered dollars only - what the per-task cap
   * binds on. `subscriptionUsd` is the separate, notional figure. */
  costUsd: number;
  subscriptionUsd: number;
  /** The per-task cap this task started under (`caps.json`) - absent
   * when none was set, which is what makes the page show the cost as
   * plain text with no meter (Client ruling, issue #203). */
  perTaskCapUsd?: number;
  prUrl: string | null;
  writeup: WorkerWriteup | null;
  finished: boolean;
  /** Whether a stop is even possible - see `isRunning`. */
  running: boolean;
  lastActivityMs: number;
  /** "Worker and model": the brain's name and its model, off the latest
   * receipt. Null before any attempt has produced one. */
  worker: string | null;
  /** See `networkPolicyLabel` - what the record can actually say about
   * this task's network, which today is its refusals or nothing. */
  networkPolicy: string;
  /** See `triggerLabel` - what started the round this task is on. */
  trigger: string;
  /** When the task was received. Null only in the brief window before
   * its first event has landed. */
  startedAtMs: number | null;
  /** How long the task has been running (an open task) or how long it
   * ran (a finished one) - never recomputed on the page, so one
   * definition serves both. */
  durationMs: number;
  /** See `checksLabel` - whatever most recently judged the work. */
  checks: string;
  /** `Delivery.outcome`, or null when there is no delivery to show. */
  delivery: string | null;
  /** `Delivery.confidence` - Fabrica/Inspector-derived, the ratified
   * field (CONTRACT rule 4), never the worker's own write-up
   * confidence, which is its own separate number shown on the review
   * page's card. Null with no delivery. */
  confidence: number | null;
}

export interface SpendView {
  /** Issue #188: real, metered dollars - what `perDayCapUsd` binds on. */
  dailyUsd: number;
  dailyLabel: string;
  /** The day's flat-rate subscription estimate - notional, shown
   * separately, never counted against `perDayCapUsd`. */
  dailySubscriptionUsd: number;
  dailySubscriptionLabel: string;
  perDayCapUsd?: number;
  perTaskCapUsd?: number;
}

export interface LiveViewState {
  now: number;
  spend: SpendView;
  tasks: TaskView[];
}

/** Issue #189's two subscription meters, for the phone review page -
 * the one number a flat-rate subscription's spend view cannot show,
 * since filling the week costs no dollars. Read through the same
 * functions the pause rule decides with, so the phone and `fabrica
 * status` can never show different numbers. */
export interface MetersView {
  /** Both meters in one phrase ("5h 7%, 7d 64%"), or "not read yet". */
  label: string;
  /** True when the pause rule would refuse a new start right now. */
  paused: boolean;
  /** Why, when `paused` - or why no reading could be used, when the
   * rule is currently refusing nothing on an unknown number. Empty when
   * both meters are read and under their thresholds. */
  detail: string;
}

/** One row of the phone review page (issue #202, extended by the
 * "show every task waiting on me" follow-up) - everything a tap on
 * accept/fix/wrong (or, for the two narrower kinds below, just wrong;
 * or, for an asking row, typing an answer) needs to show before
 * deciding. Every task this page shows is one `earlyStopKindOf`/
 * `state === "delivered"`/`state === "asking"` says is actually waiting
 * on the Client, nothing else. */
export type ReviewRow = DeliveredReviewRow | EarlyStopReviewRow | AskingReviewRow;

export interface DeliveredReviewRow {
  id: string;
  title: string;
  kind: "delivered";
  /** The pull request's own body, rendered through the exact same
   * `finalMessageFor` that built it (src/foreman/pr-body.ts) - never a
   * second hand-written copy of the Client's own template, so this page
   * can never show text that disagrees with the real pull request. */
  writeupBody: string;
  /** False when the write-up was invalid and `writeupBody` is Fabrica's
   * own fallback wording naming what was wrong, not the worker's words. */
  writeupOk: boolean;
  /** The worker's quiz (issue #98): three questions about what the
   * change did and why, each with its own one-line answer, for the owner
   * who did not read the diff. The page shows the questions with the
   * answers hidden until tapped. Empty for a task whose write-up predates
   * the field - the record is append-only, so nothing was backfilled. */
  quiz: WriteupQuizEntry[];
  inspectorStamp: string;
  /** Inspector's own report text, when the stamp is anything but green -
   * null when there's nothing more to say (green, or no Inspector
   * involved at all). */
  inspectorDetail: string | null;
  gateState: string;
  prUrl: string | null;
  lastActivityMs: number;
}

/** A task that never reached a delivery but is still waiting on a "wrong"
 * verdict to close it - Inspector's own refusal (`kind: "refused"`) or
 * whatever killed the task first, a crash/cap refusal/unplugged project
 * among them (`kind: "failed"`). `reason` is `earlyStopKindOf`'s own text
 * verbatim - the exact same string `fabrica status` shows for this same
 * task (src/cli/status-command.ts), so the two can never disagree. */
export interface EarlyStopReviewRow {
  id: string;
  title: string;
  kind: "refused" | "failed";
  reason: string;
  lastActivityMs: number;
}

/** A task that stopped on its clarifying questions (SPEC.md step 2,
 * issue #8) and is waiting on the Client's words, not on a verdict - so
 * this row carries no write-up, no stamp and no verdict buttons at all,
 * just the questions as asked and somewhere to answer them. `questions`
 * is the worker's own list, verbatim and in order, off the same
 * `"questions-asked"` event `fabrica answer` itself reads to build
 * `answers.md` - this page numbers them for display only, never
 * rewrites them. */
export interface AskingReviewRow {
  id: string;
  title: string;
  kind: "asking";
  questions: string[];
  lastActivityMs: number;
}

/** One accepted task's quiz on the /quiz page (issue #98) - the owner
 * revisiting what he already ruled on, so there is nothing to decide
 * here and no control to offer: the title, the three questions with
 * their answers, and when he accepted it. */
export interface QuizRow {
  id: string;
  title: string;
  quiz: WriteupQuizEntry[];
  /** When the "accept" verdict landed - what this page is ordered by. */
  acceptedAtMs: number;
}

/** How many accepted tasks' quizzes /quiz keeps (issue #98). */
export const QUIZ_HISTORY_LENGTH = 10;

/** One running task on the review page (issue #203) - enough to
 * recognize what is about to be stopped, and nothing that invites a
 * verdict, since a running task has nothing to rule on yet. The last
 * transcript line is the same detail `recordStopDecision` writes onto
 * the `stopped-by-owner` event, shown here first so the decision is
 * made looking at it rather than at nothing. */
export interface RunningRow {
  id: string;
  title: string;
  project: string | null;
  worker: string | null;
  costLabel: string;
  durationMs: number;
  lastActivityMs: number;
  lastActivity: string | null;
}

/** The worker's last transcript line as one short string, for a running
 * row. Read off the follower's own already-tailed transcript - never a
 * fresh read of transcript.log, which on a long-running task is exactly
 * the whole-file re-read per poll this directory's README forbids. */
function lastTranscriptLine(transcript: TranscriptEntry[]): string | null {
  const last = transcript[transcript.length - 1];
  if (!last) return null;
  const text = typeof last.text === "string" ? last.text.trim() : "";
  return text.length > 0 ? text : null;
}

/** "Inspector's stamp" - green/red/refused when this delivery was
 * actually handed to Inspector, else a plain label for the self-tested
 * (no Inspector installed) path, derived from the same `Delivery.outcome`
 * `fabrica status`'s own wording already covers (render.ts's
 * describeLiveness/isDeadEnd) - kept as its own tiny copy here for the
 * same reason this directory already keeps its own `taskTitle`/
 * `stateSymbol` copies: that function lives under src/cli/, and this
 * integration reaches Fabrica only through src/index.ts. */
export function inspectorStampLabel(delivery: Delivery | null): string {
  if (delivery === null) return "no delivery record";
  if (delivery.inspection) return delivery.inspection.verdict;
  if (delivery.outcome === "not-verified") return "not verified (worker's box could not run the check)";
  return "not inspected (self-tested, no Inspector)";
}

/** Detail text for a non-green stamp - Inspector's own report, worth
 * showing alongside the stamp itself; null when there's nothing more to
 * say (green, or no Inspector involved at all). */
export function inspectorReportDetail(delivery: Delivery | null): string | null {
  if (delivery?.inspection && delivery.inspection.verdict !== "green") return delivery.inspection.report;
  return null;
}

/** "The gate's state" (rule 9) as far as Fabrica's own record goes -
 * the worker's own declared intent (`Delivery.gateChanges`), never
 * anything Fabrica detected on its own (CONTRACT rule 9 is enforced by
 * CI against the real pull request, not by Fabrica - see AGENTS.md).
 * Empty string means the worker declared no change to the gate. */
export function gateStateLabel(delivery: Delivery | null): string {
  if (delivery === null) return "unknown";
  const declared = delivery.gateChanges.trim();
  return declared.length > 0 ? declared : "untouched";
}

/** Whichever event last carried `details.project` - mirrors
 * src/cli/render.ts's `projectFromEvents` (a fix round's own
 * work-started/delivered events carry it too, so the latest wins). Kept
 * as its own small copy rather than imported: that function lives under
 * src/cli/, the CLI's own presentation layer, and this integration reaches
 * Fabrica only through src/index.ts, never into src/cli/. */
function projectFromEvents(events: FabricaEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const details = events[i].details as { project?: string } | undefined;
    if (details?.project) return details.project;
  }
  return null;
}

/** Mirrors src/cli/render.ts's `prUrlFromEvents` for the same reason as
 * `projectFromEvents` above - the last "pr-opened" event wins. */
function prUrlFromEvents(events: FabricaEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].name !== "pr-opened") continue;
    const details = events[i].details as { url?: string } | undefined;
    if (details?.url) return details.url;
  }
  return null;
}

/** The worker's own structured write-up (title/what/why/how/deviations),
 * carried on a "delivered" event's own `details` (src/foreman/do.ts and
 * verdict.ts, alongside `delivery`) rather than on the ratified `Delivery`
 * shape itself - `Delivery` is CONTRACT rule 4's contract type, and this
 * is presentation-only metadata the contract never promised. Absent until
 * an attempt's write-up was valid; the latest "delivered" event wins,
 * same as `prUrlFromEvents`. */
function writeupFromEvents(events: FabricaEvent[]): WorkerWriteup | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].name !== "delivered") continue;
    const writeup = (events[i].details as { writeup?: WorkerWriteup } | undefined)?.writeup;
    if (writeup) return writeup;
  }
  return null;
}

/** The questions a task stopped on - the latest `"questions-asked"`
 * event's own `details.questions` (src/foreman/ask.ts's `AskedDetails`),
 * which is the same event `recordAnswerDecision` reads to build the
 * clarification round in `answers.md`, so the page can never show a
 * question the recorded answer won't be filed against. Latest wins, the
 * same way `prUrlFromEvents`/`writeupFromEvents` above take the last of
 * their own event. Anything but an array of strings reads as no
 * questions rather than throwing - this page is a viewer, and
 * `stateOf` already decided the task is asking. */
export function questionsFromEvents(events: FabricaEvent[]): string[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].name !== "questions-asked") continue;
    const questions = (events[i].details as { questions?: unknown } | undefined)?.questions;
    if (Array.isArray(questions)) return questions.filter((q): q is string => typeof q === "string");
    return [];
  }
  return [];
}

/** The short label a list row shows: the worker's own write-up title once
 * there is one, otherwise the task text's first line cut to about 60
 * characters - never both, and never the full task text on the row
 * itself. */
export function taskTitle(taskText: string, writeupTitle: string | undefined): string {
  if (writeupTitle && writeupTitle.trim()) return writeupTitle.trim();
  const firstLine = taskText.split("\n", 1)[0].trim();
  if (firstLine.length <= FALLBACK_TITLE_MAX_LENGTH) return firstLine || "(no task text)";
  return `${firstLine.slice(0, FALLBACK_TITLE_MAX_LENGTH).trimEnd()}…`;
}

/** The highest attempt number mentioned by any event this task has
 * produced so far - a finished attempt's own receipt, or the heartbeat/
 * check-run of one still in flight. Null before any attempt has started
 * (e.g. a task still "asking"). */
function latestAttempt(events: FabricaEvent[]): number | null {
  let max: number | null = null;
  for (const event of events) {
    let attempt: unknown;
    if (event.name === "receipt-recorded") attempt = (event.details as { receipt?: { attempt?: number } } | undefined)?.receipt?.attempt;
    else if (event.name === "heartbeat" || event.name === "check-run") attempt = (event.details as { attempt?: number } | undefined)?.attempt;
    if (typeof attempt === "number" && (max === null || attempt > max)) max = attempt;
  }
  return max;
}

function lastActivityMs(events: FabricaEvent[]): number {
  const last = events[events.length - 1];
  return last ? Date.parse(last.occurredAt) : 0;
}

/** When the Client accepted this task - the most recent "accept" verdict
 * event's own timestamp, or null when he never accepted it. Read from
 * that event rather than from the task's last activity: /quiz is ordered
 * by when the owner accepted the work, and an accepted task can still
 * record something afterwards (a hand-recorded cost, say). */
function acceptedAtMs(events: FabricaEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.name !== "verdict-recorded") continue;
    if ((event.details as { ruling?: string } | undefined)?.ruling !== "accept") continue;
    const parsed = Date.parse(event.occurredAt);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** When this task was first received - its own first event, which
 * `registerTask` always writes as "task-received". Null for the brief
 * window where a task folder exists but no event has landed yet (the
 * same window `discoverTaskIds` exists to cover). */
function startedAtMs(events: FabricaEvent[]): number | null {
  const first = events[0];
  if (!first) return null;
  const parsed = Date.parse(first.occurredAt);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The most recent attempt's receipt - the one place the record says
 * which worker and model actually ran, and whether its check was green
 * (`contract/surface.ts`'s `Receipt`). Read from this task's own events,
 * never through `receiptsOf`, which would re-read and re-parse
 * events.jsonl once per task on every 2-second poll (this module's
 * header, and the README's own note on why a poll must never re-read a
 * whole file). Both carriers are checked: an attempt that ended with no
 * delivery is on the record only as its own "receipt-recorded" event,
 * while a delivery carries the whole list. */
function latestReceipt(events: FabricaEvent[]): Receipt | null {
  let latest: Receipt | null = null;
  for (const event of events) {
    const details = event.details as { receipt?: unknown; receipts?: unknown } | undefined;
    const candidates: unknown[] = [];
    if (details?.receipt !== undefined) candidates.push(details.receipt);
    const list = details?.receipts;
    if (Array.isArray(list)) candidates.push(...list);
    for (const candidate of candidates) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const receipt = candidate as Receipt;
      if (typeof receipt.attempt !== "number") continue;
      if (latest === null || receipt.attempt >= latest.attempt) latest = receipt;
    }
  }
  return latest;
}

/** "Worker and model" - the brain's own name and the model it reported,
 * off the latest receipt. Null before any attempt has produced one (a
 * task still asking, or one whose first attempt hasn't finished). */
function workerLabel(receipt: Receipt | null): string | null {
  if (!receipt) return null;
  const brain = typeof receipt.brain === "string" ? receipt.brain.trim() : "";
  const model = typeof receipt.model === "string" ? receipt.model.trim() : "";
  if (!brain && !model) return null;
  if (!model) return brain;
  if (!brain) return model;
  return `${brain} · ${model}`;
}

/**
 * "Network policy," as far as Fabrica's record can actually say.
 *
 * The reference adapter really does choose one per call
 * (`src/brain/adapters/claude-code.ts`'s `prepareNetwork`: a
 * relay-backed isolated network when a worker token is present,
 * `"allowed"` when there is none) - but nothing records it. `Brain.work`
 * and `BrainWorkResult` are ratified contract shapes with nowhere to
 * carry it, and that adapter's relay points its own "network-refused"
 * bookkeeping at a throwaway scratch record home precisely because
 * `Brain.ask`/`work` take no task id at all - a gap its own header
 * states rather than hides.
 *
 * So this reports the one network fact the record holds: the refusals
 * attributed to this task. "not recorded" is deliberately not "allowed"
 * or "isolated" - this page never shows a policy it cannot know, and
 * will show a real one the day one is recorded.
 */
function networkPolicyLabel(events: FabricaEvent[]): string {
  const refusals = events.filter((event) => event.name === "network-refused");
  if (refusals.length === 0) return "not recorded";
  const hosts = new Set<string>();
  for (const refusal of refusals) {
    const host = (refusal.details as { host?: unknown } | undefined)?.host;
    if (typeof host === "string" && host.length > 0) hosts.add(host);
  }
  const named = hosts.size > 0 ? ` (${[...hosts].join(", ")})` : "";
  return `${refusals.length} refused${named}`;
}

/** "Trigger" - what started the round this task is on, which is the only
 * part of that question the record can answer differently for different
 * tasks (every task begins as one `fabrica do`): a first run, the
 * Client's answer to a clarifying question resuming it, or his Nth
 * "fix". The explicitly-named issue (`--issue <N>`, persisted as the
 * task's own "issue" file) rides along when there is one, since that is
 * the other half of "who asked for this". */
function triggerLabel(events: FabricaEvent[], issue: string | null): string {
  let base = "do";
  let fixRounds = 0;
  for (const event of events) {
    if (event.name === "answers-given") base = "answer";
    else if (event.name === "verdict-recorded" && (event.details as { ruling?: string } | undefined)?.ruling === "fix") {
      fixRounds += 1;
      base = `fix ${fixRounds}`;
    }
  }
  const named = issue !== null && /^\d+$/.test(issue.trim()) ? ` #${issue.trim()}` : "";
  return `${base}${named}`;
}

/** "Checks" - whatever most recently judged this task's work, in one
 * short word. A single forward pass, so the latest judgement wins
 * whichever kind it was: the worker's own box running the project's
 * check ("check-run", which lands twice per attempt - `phase: "started"`
 * then the result) or Inspector's independent verdict
 * ("inspection-finished"), which IS the check in Inspector mode (issue
 * #64: Fabrica runs none itself). "—" until something has judged
 * anything. */
function checksLabel(events: FabricaEvent[]): string {
  let label = "—";
  for (const event of events) {
    if (event.name === "check-run") {
      const details = event.details as { phase?: string; green?: boolean; notVerified?: string } | undefined;
      if (details?.phase === "started") label = "running";
      else if (typeof details?.notVerified === "string") label = "not verified";
      else if (typeof details?.green === "boolean") label = details.green ? "green" : "red";
    } else if (event.name === "inspection-finished") {
      const verdict = (event.details as { verdict?: string } | undefined)?.verdict;
      if (typeof verdict === "string") label = `inspector: ${verdict}`;
    } else if (event.name === "inspection-skipped") {
      label = "self-tested (no Inspector)";
    }
  }
  return label;
}

/** The task's current delivery, derived from the events already in hand
 * rather than through `deliveryOf` - same reasoning as `latestReceipt`
 * above (a per-task re-read of events.jsonl on every poll), and the same
 * rule `deliveryOf` itself applies: a fix round's Inspector refusal that
 * lands after a delivery supersedes it, so there is nothing to show. */
function deliveryFromEvents(events: FabricaEvent[]): Delivery | null {
  let delivery: Delivery | null = null;
  for (const event of events) {
    if (event.name === "delivered") {
      delivery = (event.details as { delivery?: Delivery } | undefined)?.delivery ?? null;
    } else if (
      event.name === "inspection-finished" &&
      (event.details as { verdict?: string } | undefined)?.verdict === "refused"
    ) {
      delivery = null;
    }
  }
  return delivery;
}

/** The caps this task actually started under (`caps.json`, written once
 * at registration - src/foreman/ask.ts), falling back to the record
 * home's current `projects.toml` for a task registered before that file
 * existed. The fallback is the same number `caps.ts` would enforce
 * today; the file is the number it was enforcing then, which is what a
 * cost meter should be read against. */
function capsAtStart(recordHome: string, taskId: string, currentCaps: Caps): Caps {
  const raw = readTaskFile(recordHome, taskId, "caps.json");
  if (raw === null) return currentCaps;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return currentCaps;
    const { perTaskUsd, perDayUsd } = parsed as { perTaskUsd?: unknown; perDayUsd?: unknown };
    return {
      ...(typeof perTaskUsd === "number" && Number.isFinite(perTaskUsd) ? { perTaskUsd } : {}),
      ...(typeof perDayUsd === "number" && Number.isFinite(perDayUsd) ? { perDayUsd } : {}),
    };
  } catch {
    // A viewer never fails over a malformed convenience file - the
    // enforced number is still what the caps themselves say.
    return currentCaps;
  }
}

/** The caps and the pause rule this viewer reads - and, when
 * projects.toml is there but will not parse, the problem to show
 * instead of a number.
 *
 * It used to rethrow that case, which turned the whole page into one
 * "could not read the record" line: a config problem reported as a
 * record problem, with the task list - which needs no config at all -
 * collateral damage. A viewer degrades loudly instead (Client ruling):
 * the defaults, plus a banner naming the file and the line.
 * `loadConfigOrProblem` is the shared reader for exactly this posture;
 * everything that spends money still refuses outright on the same file
 * (see its own doc comment). */
function readConfig(recordHome: string): { caps: Caps; pause: PauseRule; problem: ConfigProblem | null } {
  const { config, problem } = loadConfigOrProblem(recordHome);
  return { caps: config.caps, pause: config.pause, problem };
}

/** Every task id the record home knows about, from the one place they are
 * ever created (SPEC.md "The record": `tasks/<id>/`) - never from
 * events.jsonl, so a task whose very first event hasn't landed yet (the
 * brief window inside `registerTask` between creating its folder and
 * appending "task-received") still shows up rather than looking lost. */
function discoverTaskIds(recordHome: string): string[] {
  try {
    return readdirSync(join(recordHome, "tasks"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Holds one `TaskFollower` per task for this record home's whole process
 * lifetime, so a 2Hz poll costs the bytes appended since the last one
 * (the same reasoning as `fabrica watch` - see src/record/tail.ts) rather
 * than re-reading every task's history from byte zero every time. */
export function createRecordView(recordHome: string) {
  const followers = new Map<string, TaskFollower>();

  function followerFor(taskId: string): TaskFollower {
    let follower = followers.get(taskId);
    if (!follower) {
      follower = followTask(recordHome, taskId);
      followers.set(taskId, follower);
    }
    return follower;
  }

  function getState(now: number = Date.now()): LiveViewState {
    const { caps } = readConfig(recordHome);
    const ids = discoverTaskIds(recordHome);

    const perTask = ids.map((id) => {
      const { events } = followerFor(id).read();
      return { id, events };
    });

    const allEvents = perTask.flatMap(({ events }) => events);
    const { meteredUsd: dailyUsd, subscriptionUsd: dailySubscriptionUsd } = daySpend(allEvents, now);

    const tasks: TaskView[] = perTask.map(({ id, events }) => buildTaskView(id, events, caps, now));

    tasks.sort((a, b) => b.lastActivityMs - a.lastActivityMs);

    return {
      now,
      spend: {
        dailyUsd,
        dailyLabel: formatUsd(dailyUsd),
        dailySubscriptionUsd,
        dailySubscriptionLabel: formatUsd(dailySubscriptionUsd),
        ...(caps.perDayUsd !== undefined ? { perDayCapUsd: caps.perDayUsd } : {}),
        ...(caps.perTaskUsd !== undefined ? { perTaskCapUsd: caps.perTaskUsd } : {}),
      },
      tasks,
    };
  }

  function buildTaskView(id: string, events: FabricaEvent[], caps: Caps, now: number = Date.now()): TaskView {
    const spend = taskSpend(events, id);
    const rawState = stateOf(events);
    const state = displayState(rawState, rawState === "closed" ? latestVerdictRuling(events) : null);
    const taskText = (readTaskFile(recordHome, id, "request.md") ?? "").trim();
    const writeup = writeupFromEvents(events);
    const finished = isFinished(state);
    const startedAt = startedAtMs(events);
    const lastActivity = lastActivityMs(events);
    const taskCaps = capsAtStart(recordHome, id, caps);
    const delivery = deliveryFromEvents(events);
    return {
      id,
      title: taskTitle(taskText, writeup?.title),
      project: projectFromEvents(events),
      state,
      taskText,
      attempt: latestAttempt(events),
      costLabel: describeTaskCost(spend, hasAttempts(events, id)),
      costUsd: spend.meteredUsd,
      subscriptionUsd: spend.subscriptionUsd,
      ...(taskCaps.perTaskUsd !== undefined ? { perTaskCapUsd: taskCaps.perTaskUsd } : {}),
      prUrl: prUrlFromEvents(events),
      writeup,
      finished,
      running: isRunning(state),
      lastActivityMs: lastActivity,
      worker: workerLabel(latestReceipt(events)),
      networkPolicy: networkPolicyLabel(events),
      trigger: triggerLabel(events, readTaskFile(recordHome, id, "issue")),
      startedAtMs: startedAt,
      // An open task's duration runs to now; a finished one's stops at
      // whatever it last recorded, so it doesn't keep counting forever.
      durationMs: startedAt === null ? 0 : Math.max(0, (finished ? lastActivity : now) - startedAt),
      checks: checksLabel(events),
      delivery: delivery?.outcome ?? null,
      confidence: typeof delivery?.confidence === "number" ? delivery.confidence : null,
    };
  }

  /** One task's full view, for the per-task page (/tasks/<id>) - null for
   * a task id this record home has never heard of. Reuses the same
   * `buildTaskView` `getState` uses, so the list and the detail page never
   * disagree on one task's own fields. */
  function getTask(taskId: string, now: number = Date.now()): TaskView | null {
    if (!discoverTaskIds(recordHome).includes(taskId)) return null;
    const { events } = followerFor(taskId).read();
    return buildTaskView(taskId, events, readConfig(recordHome).caps, now);
  }

  /** The worker's transcript for one task, tailing as it grows - null for
   * a task id this record home has never heard of. Reuses the same
   * follower `getState` uses, so the two never fall out of step. */
  function getTranscript(taskId: string): TranscriptEntry[] | null {
    if (!discoverTaskIds(recordHome).includes(taskId)) return null;
    return followerFor(taskId).read().transcript;
  }

  /** The phone review page's rows (issue #202, extended to show every
   * task waiting on the Client, not only delivered ones) - a "delivered"
   * task gets its full card (the pull request's write-up, Inspector's
   * stamp, the gate's declared state), a task that stopped on its
   * clarifying questions gets its questions and somewhere to answer
   * them, and a task Inspector refused or that failed before any work
   * started gets a narrower card naming the one reason and the one
   * verdict ("wrong") that closes it - `earlyStopKindOf`
   * (src/foreman/queries.ts) decides the last of those, the exact same
   * function `fabrica status` calls for the same task, so the two
   * surfaces can never show a task the other doesn't, or a different
   * reason for the one they agree on. Reads each task's own events
   * through the same per-task follower cache `getState`/`getTask`/
   * `getTranscript` already share, rather than re-reading the record a
   * second, independent way. */
  function getReviewRows(now: number = Date.now()): ReviewRow[] {
    const { caps } = readConfig(recordHome);
    const rows: ReviewRow[] = discoverTaskIds(recordHome).flatMap((id): ReviewRow[] => {
      const { events } = followerFor(id).read();
      const task = buildTaskView(id, events, caps, now);

      // Waiting on the Client's words rather than on a ruling - the one
      // row kind here that isn't a verdict at all.
      if (task.state === "asked a question") {
        return [{ id, title: task.title, kind: "asking", questions: questionsFromEvents(events), lastActivityMs: task.lastActivityMs }];
      }

      if (task.state === "delivered") {
        const delivery = deliveryOf(recordHome, id);
        const message = finalMessageFor(task.writeup ?? undefined, task.title);
        return [
          {
            id,
            title: task.title,
            kind: "delivered",
            writeupBody: message.body,
            writeupOk: message.ok,
            quiz: quizEntriesOf(task.writeup),
            inspectorStamp: inspectorStampLabel(delivery),
            inspectorDetail: inspectorReportDetail(delivery),
            gateState: gateStateLabel(delivery),
            prUrl: task.prUrl,
            lastActivityMs: task.lastActivityMs,
          },
        ];
      }

      const stop = earlyStopKindOf(events);
      if (!stop) return [];
      return [{ id, title: task.title, kind: stop.kind, reason: stop.reason, lastActivityMs: task.lastActivityMs }];
    });

    rows.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
    return rows;
  }

  /** The review page's second, separate list (issue #203): the tasks
   * currently running, which is where the one write action this page
   * gained - stop - can actually apply. Deliberately NOT folded into
   * `getReviewRows` above: those rows are exactly the set `fabrica
   * status` flags as waiting on the Client, an agreement
   * `state-agreement.test.ts` pins task-for-task, and a running task is
   * the opposite of waiting on him. Keeping them apart means the stop
   * control can exist without widening what "waiting on you" means. */
  function getRunningRows(now: number = Date.now()): RunningRow[] {
    const { caps } = readConfig(recordHome);
    const rows: RunningRow[] = discoverTaskIds(recordHome).flatMap((id): RunningRow[] => {
      const { events, transcript } = followerFor(id).read();
      const task = buildTaskView(id, events, caps, now);
      if (!task.running) return [];
      return [
        {
          id,
          title: task.title,
          project: task.project,
          worker: task.worker,
          costLabel: task.costLabel,
          durationMs: task.durationMs,
          lastActivityMs: task.lastActivityMs,
          lastActivity: lastTranscriptLine(transcript),
        },
      ];
    });
    rows.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
    return rows;
  }

  /** The /quiz page (issue #98): the last ten accepted tasks' quizzes,
   * newest acceptance first, for the owner to revisit after he has
   * already ruled. A task with no quiz is skipped rather than listed
   * empty - a write-up recorded before the field existed has none, and
   * the record is append-only, so nothing was backfilled. An accepted
   * task whose write-up is somehow malformed is skipped by the same
   * rule, through the same `quizEntriesOf`.
   *
   * Deliberately not folded into `getReviewRows`: these are exactly the
   * tasks that are NOT waiting on him, which is the one thing that list
   * means (the same reasoning `getRunningRows` is kept separate for). */
  function getQuizRows(): QuizRow[] {
    const { caps } = readConfig(recordHome);
    const rows: QuizRow[] = discoverTaskIds(recordHome).flatMap((id): QuizRow[] => {
      const { events } = followerFor(id).read();
      const acceptedAt = acceptedAtMs(events);
      if (acceptedAt === null) return [];
      const task = buildTaskView(id, events, caps);
      if (task.state !== "closed (accept)") return [];
      const quiz = quizEntriesOf(task.writeup);
      if (quiz.length === 0) return [];
      return [{ id, title: task.title, quiz, acceptedAtMs: acceptedAt }];
    });
    rows.sort((a, b) => b.acceptedAtMs - a.acceptedAtMs);
    return rows.slice(0, QUIZ_HISTORY_LENGTH);
  }

  /** Issue #189: the two subscription meters as the record last saw
   * them, with what the pause rule makes of them. Reads every task's
   * events through the same per-task follower cache the rest of this
   * module uses - the windows belong to the Client's account, not to
   * one task, so the latest reading anywhere is the current one. */
  function getMeters(now: number = Date.now()): MetersView {
    const allEvents = discoverTaskIds(recordHome).flatMap((id) => followerFor(id).read().events);
    const standing = standingOf(latestMeterReading(allEvents), now);
    if (!standing.usable) {
      return {
        label: describeMeters(standing),
        paused: false,
        detail: `the pause rule is refusing nothing: ${standing.unknownBecause}`,
      };
    }
    const refusal = refusalFor(standing, readConfig(recordHome).pause);
    return {
      label: describeMeters(standing),
      paused: refusal !== undefined,
      detail: refusal?.message ?? "",
    };
  }

  /** The one thing wrong with this record home's projects.toml that
   * every page has to show, or null when there is nothing wrong with it
   * (including "there isn't one", which is ordinary - see `readConfig`).
   * Its own accessor rather than a field on each page's state payload:
   * five pages share one banner script (public/banner.js) and one
   * endpoint, instead of four renderers each having to carry it. */
  function getConfigProblem(): ConfigProblem | null {
    return readConfig(recordHome).problem;
  }

  return { getState, getTask, getTranscript, getReviewRows, getRunningRows, getQuizRows, getMeters, getConfigProblem };
}

export type RecordView = ReturnType<typeof createRecordView>;
