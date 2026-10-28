// A tiny HTTP server for watching what the factory is doing (issue #26),
// now with a few deliberate exceptions (issues #202, #203): every
// handler still only ever reads (`readFileSync`/`readdirSync`, directly
// or through src/index.ts) EXCEPT the four POST routes below. Three of
// them record the Client's own decisions from the phone review page -
// his verdict on a delivery, his answer to a worker's clarifying
// questions, and his decision to stop a running task - and the fourth
// records a quiz mark from review mode on /quiz, which is the one write
// here that is not a decision about work and is not identity-gated (see
// `handleQuizAnswer` for that reasoning). See "Recording a decision
// from the phone" lower in this file, and this module's README, for why
// those writes are safe to allow here. The stop route is the only one
// that reaches outside the record at all (it signals the task's own
// detached process), and it does so through src/cli/task-process.ts,
// which will not signal a pid it has not re-verified.
//
// It never binds anywhere but the loopback interface - HOST below is not
// a parameter anywhere, so there is no way to ask this server for
// anything else. Reaching it from a phone over Tailscale is a one-time,
// host-level `tailscale serve` step outside this repo (Tailscale's own
// docs: a Serve reverse-proxy target only ever supports
// `http://127.0.0.1` - loopback isn't a limitation to work around here,
// it's the one address this server is allowed to need).

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  onTaskAccepted,
  QuizError,
  recordAnswerDecision,
  recordQuizAnswer,
  recordStopDecision,
  recordVerdictDecision,
  TASK_ID_PATTERN,
} from "../../src/index.ts";
import { runningCopyCommit } from "../../src/cli/doctor-command.ts";
import { loadConfigOrDefault } from "../../src/cli/load-config.ts";
import { spawnDetachedResume } from "../../src/cli/spawn-detached.ts";
import { findTaskProcess, stopTaskProcess } from "../../src/cli/task-process.ts";
import { createRecordView } from "./record-view.ts";

export const DEFAULT_PORT = 7777;
/** Hardcoded, not a parameter anywhere in this module: there is no way to
 * ask this server to listen on anything but loopback. */
const HOST = "127.0.0.1";

const PUBLIC_DIR = fileURLToPath(new URL("./public", import.meta.url));
/** Two levels up from this file to the repo root - the same relative
 * depth src/cli/doctor-command.ts's own CHECKOUT is computed at, so
 * both land on the same path for the same checkout. */
const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const STATIC_FILES: Record<string, { file: string; contentType: string }> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/history": { file: "history.html", contentType: "text/html; charset=utf-8" },
  "/review": { file: "review.html", contentType: "text/html; charset=utf-8" },
  /** Issue #98: the accepted tasks' quizzes, for the owner to revisit. */
  "/quiz": { file: "quiz.html", contentType: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", contentType: "text/css; charset=utf-8" },
  "/task.js": { file: "task.js", contentType: "text/javascript; charset=utf-8" },
  "/review.js": { file: "review.js", contentType: "text/javascript; charset=utf-8" },
  "/quiz.js": { file: "quiz.js", contentType: "text/javascript; charset=utf-8" },
  /** The banner strip every page loads - see public/banner.js. */
  "/banner.js": { file: "banner.js", contentType: "text/javascript; charset=utf-8" },
};

const TRANSCRIPT_PATH = /^\/api\/tasks\/([^/]+)\/transcript$/;
const TASK_API_PATH = /^\/api\/tasks\/([^/]+)$/;
/** A task's own page (issue: "styling the live app better" - the live
 * transcript is too much to expand in place, so it gets a page of its
 * own). Matched against `TASK_ID_PATTERN` itself, not just `[^/]+`, so
 * nothing but a real task id ever reaches `task.html`. */
const TASK_PAGE_PATH = new RegExp(`^/tasks/(${TASK_ID_PATTERN.source.slice(1, -1)})$`);
/** The phone review page's two writes (issue #202, plus answering a
 * worker's questions) - a loose capture, the same shape as
 * TASK_API_PATH/TRANSCRIPT_PATH above, not TASK_ID_PATTERN embedded
 * directly: the handler below decodes first and validates against
 * TASK_ID_PATTERN after, so a malformed id (e.g. a percent-encoded
 * path-traversal attempt) gets the same "Not a task id." 400 those
 * routes give rather than falling through to this route not matching at
 * all and reporting a generic 405. */
const REVIEW_VERDICT_PATH = /^\/api\/review\/tasks\/([^/]+)\/verdict$/;
const REVIEW_ANSWER_PATH = /^\/api\/review\/tasks\/([^/]+)\/answer$/;
/** Issue #203's one new write: stopping a running task. Same loose
 * capture and same decode-then-validate handling as the two above. */
const REVIEW_STOP_PATH = /^\/api\/review\/tasks\/([^/]+)\/stop$/;
/** The quiz's own write: the Client marking a question right or wrong in
 * review mode. Deliberately not under /api/review - it is not a decision
 * about a task's work, and it is not identity-gated the way the three
 * routes above are (see `handleQuizAnswer`). */
const QUIZ_ANSWER_PATH = /^\/api\/quiz\/answer$/;
/** Serve adds this to a proxied request's headers for the authenticated
 * tailnet user, and strips it from anything a client tried to send
 * itself (Tailscale's own docs: "to avoid header spoofing") - so its
 * mere presence is as much proof of identity as this server can check
 * without talking to Tailscale itself. Node lowercases every incoming
 * header name, so the comparison below is lowercase regardless of how
 * Serve capitalizes it on the wire. */
const TAILSCALE_IDENTITY_HEADER = "tailscale-user-login";
const VERDICT_RULINGS = new Set(["accept", "fix", "wrong"]);

export interface LiveView {
  readonly port: number;
  /** The underlying Node server, so a caller (a test, mainly) can
   * confirm for itself exactly what address it bound - not just trust
   * that this module asked for the right one. */
  readonly server: ReturnType<typeof createServer>;
  close(): Promise<void>;
}

/** Starts the live view. Always on 127.0.0.1 - HOST above is not a
 * parameter anywhere in this function's signature, so there is no way
 * for a caller to ask for anything else. `port` defaults to 7777 (the
 * documented address) but tests pass 0 for an OS-assigned one so many
 * can run at once without colliding.
 *
 * `commit` reads the commit of the copy of Fabrica on disk
 * (src/cli/doctor-command.ts's `runningCopyCommit`, the exact value
 * `fabrica doctor`'s own "checkout" line reports) - overridable so a
 * test can drive both commit endpoints without depending on this
 * checkout's real git state. It is called ONCE here, at startup, and
 * that captured string is what `/api/version` answers for this
 * process's whole life; `/api/checkout` calls it again per request. The
 * difference between those two answers is the whole point: it is what
 * tells a live view still executing yesterday's code from the checkout
 * that has since moved under it. Before this, `/api/version` re-read
 * the checkout per request, so it reported the code on disk rather than
 * the code it was running - and `fabrica up`/`fabrica update`, which
 * compare it against that same on-disk value, were comparing a value
 * against itself and could never find a stale live view at all. */
export function startLiveView(opts: {
  recordHome: string;
  port?: number;
  commit?: () => string | null;
  /** Test-only: forwarded to spawnDetachedResume for a recorded "fix"
   * verdict, the same override `fabrica verdict`'s own
   * RunVerdictCommandOptions.entryScript provides - so a test can run a
   * real fix round against a fake entry script instead of spawning the
   * real brain adapter. Omitted, the real default fix-entry script runs,
   * exactly as a real `fabrica verdict <id> fix -m "..."` would. */
  fixEntryScript?: string;
  /** Test-only, the answer route's equivalent of `fixEntryScript` above -
   * the same override `fabrica answer`'s own
   * RunAnswerCommandOptions.entryScript provides. Omitted, the real
   * default answer-entry script runs, exactly as a real
   * `fabrica answer <id> -m "..."` would. */
  answerEntryScript?: string;
  /** Test-only: the same override for the quiz re-check round an
   * "accept" can start, so a test can prove the handoff happens without
   * a real worker reading a real checkout of master. */
  quizRecheckEntryScript?: string;
  /** Test-only: replaces the half of `stop` that signals a real
   * process, so a test can prove the route's identity gate, refusals
   * and recorded event without a real worker to kill. Omitted, the real
   * `findTaskProcess`/`stopTaskProcess` pair runs - which still signals
   * nothing it has not verified first (src/cli/task-process.ts). */
  stopProcess?: StopProcess;
}): Promise<LiveView> {
  const view = createRecordView(opts.recordHome);
  const readCheckoutCommit = opts.commit ?? (() => runningCopyCommit(CHECKOUT));
  // Captured exactly here, exactly once. Nothing in this module ever
  // re-reads it, so this value cannot drift toward the checkout's.
  const startupCommit = readCheckoutCommit();
  const version: Version = { startupCommit, readCheckoutCommit };
  const entryScripts = {
    fix: opts.fixEntryScript,
    answer: opts.answerEntryScript,
    quizRecheck: opts.quizRecheckEntryScript,
  };
  const stopProcess = opts.stopProcess ?? defaultStopProcess;
  const server = createServer((req, res) => {
    handleRequest(req, res, view, version, opts.recordHome, entryScripts, stopProcess).catch((err) => {
      if (res.headersSent) return;
      send(res, 500, "text/plain; charset=utf-8", `fabrica live: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? DEFAULT_PORT, HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (opts.port ?? DEFAULT_PORT);
      resolve({
        port,
        server,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

/** The two commits `/api/version` and `/api/checkout` answer with. One
 * is a string captured once at startup; the other is a function called
 * per request. Kept as one object so the difference between them is
 * visible at every call site rather than two similarly-named callbacks
 * threaded side by side. */
interface Version {
  /** The commit this server process's own code came from. */
  startupCommit: string | null;
  /** The commit the copy of Fabrica on disk is on right now. */
  readCheckoutCommit: () => string | null;
}

/** The two test-only entry-script overrides, one per detached round this
 * server can hand off (see startLiveView's own options). */
interface EntryScripts {
  fix: string | undefined;
  answer: string | undefined;
  /** The quiz re-check an accept can start (`startQuizRecheck`). */
  quizRecheck: string | undefined;
}

/** The process half of `stop` (issue #203): find the task's own
 * detached process and signal it. Reports the pid it actually signaled,
 * or null when none could be identified - never "assume it worked." */
export type StopProcess = (recordHome: string, taskId: string) => { pid: number | null };

/** The real thing: `findTaskProcess` first (which refuses to return a
 * pid it has not re-verified against the live process table), then one
 * SIGTERM with a SIGKILL queued behind it. A task whose process cannot
 * be identified - already exited, no pid file, a stale pid whose number
 * now belongs to something else - signals nothing at all, which is the
 * right outcome: the record already says the task is stopped, and
 * signaling an unverified pid is the one thing this must never do. */
const defaultStopProcess: StopProcess = (recordHome, taskId) => {
  const found = findTaskProcess(recordHome, taskId);
  if (!found) return { pid: null };
  return { pid: stopTaskProcess(found.pid) ? found.pid : null };
};

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  view: ReturnType<typeof createRecordView>,
  version: Version,
  recordHome: string,
  entryScripts: EntryScripts,
  stopProcess: StopProcess
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${HOST}`);

  // The only routes that aren't GETs - everything else below this still
  // only ever reads. Checked before the blanket "only GET" rejection so
  // these POSTs aren't caught by it.
  const verdictMatch = REVIEW_VERDICT_PATH.exec(url.pathname);
  const answerMatch = REVIEW_ANSWER_PATH.exec(url.pathname);
  const stopMatch = REVIEW_STOP_PATH.exec(url.pathname);
  if (req.method === "POST" && (verdictMatch || answerMatch || stopMatch)) {
    const taskId = decodeTaskId((verdictMatch ?? answerMatch ?? stopMatch)![1]);
    if (taskId === null) {
      send(res, 400, "text/plain; charset=utf-8", "Not a task id.");
      return;
    }
    if (verdictMatch) await handleRecordVerdict(req, res, recordHome, taskId, entryScripts);
    else if (answerMatch) await handleRecordAnswer(req, res, recordHome, taskId, entryScripts.answer);
    else handleStopTask(req, res, recordHome, taskId, stopProcess);
    return;
  }

  if (req.method === "POST" && QUIZ_ANSWER_PATH.test(url.pathname)) {
    await handleQuizAnswer(req, res, recordHome);
    return;
  }

  if (req.method !== "GET") {
    send(res, 405, "text/plain; charset=utf-8", "This server only ever reads - only GET is supported.");
    return;
  }

  if (url.pathname === "/api/review") {
    // The phone review page's own list (issue #202) - every task
    // currently "delivered", enriched with the pull request's write-up,
    // Inspector's stamp, and the gate's declared state. Same
    // try/sendRecordError shape as /api/state just below: a record read
    // that throws answers with the error as data rather than taking the
    // whole server down.
    //
    // `running` is a second, separate list (issue #203): the tasks the
    // stop control applies to. Kept apart from `rows` on purpose - those
    // are exactly the tasks waiting on the Client, and a running task is
    // the opposite of that (record-view.ts's getRunningRows).
    //
    // `identified` is how the page knows whether to draw the stop
    // control at all (Client ruling: absent from the page with no
    // identity, AND refused by the server without it). A browser script
    // cannot see the headers its own page was fetched with, so this one
    // GET - which arrives through the very same `tailscale serve` proxy
    // that adds the header to a POST - is where that fact has to come
    // from. It is a display hint and nothing more: the stop route makes
    // its own decision on its own request, and would refuse a POST from
    // a page that drew the button anyway.
    try {
      send(
        res,
        200,
        "application/json",
        JSON.stringify({
          rows: view.getReviewRows(),
          running: view.getRunningRows(),
          identified: identityOf(req) !== null,
          // Issue #189: the two subscription meters, shown on this page
          // because it is where the Client decides whether to spend a
          // round - and a flat-rate subscription's own windows are the
          // one budget the money figures elsewhere cannot show.
          meters: view.getMeters(),
        })
      );
    } catch (err) {
      sendRecordError(res, err);
    }
    return;
  }

  if (url.pathname === "/api/quiz") {
    // Every accepted task's quiz questions - all of them, not a recent
    // slice (they are already on the record, so the page keeps the lot) -
    // each with its status, its schedule, and the task and date it came
    // from. Read-only like every route above the POSTs, and wrapped the
    // same way /api/review is: a record read that throws answers with
    // the error as data rather than taking the server down.
    //
    // `askable` is computed server-side (src/quiz/questions.ts) rather
    // than left to the page: which question may be asked right now is
    // the repetition rule itself, and it has one tested home.
    try {
      send(res, 200, "application/json", JSON.stringify(view.getQuiz()));
    } catch (err) {
      sendRecordError(res, err);
    }
    return;
  }

  if (url.pathname === "/api/version") {
    // What THIS PROCESS is running - captured once at startup
    // (startLiveView) and never read again, so it keeps reporting the
    // code it was started from however far the checkout moves
    // afterwards. What `fabrica up` and `fabrica update` compare their
    // own running commit against, to tell a live view running the
    // current code from a stale one left over from before a merge.
    send(res, 200, "application/json", JSON.stringify({ commit: version.startupCommit }));
    return;
  }

  if (url.pathname === "/api/checkout") {
    // What is ON DISK right now - read fresh on every request, the same
    // way `fabrica doctor`'s own "checkout" line reads it. The page
    // compares this against /api/version above on load and on each poll,
    // so a banner appears within one poll of the checkout moving. A null
    // here (or there) means the comparison cannot be made at all, and
    // the page says nothing rather than guessing.
    send(res, 200, "application/json", JSON.stringify({ commit: version.readCheckoutCommit() }));
    return;
  }

  if (url.pathname === "/api/config-problem") {
    // A projects.toml that is there but will not parse. Its own endpoint
    // rather than a field on each page's state payload, because every
    // page must show it (Client ruling) and there are four of them with
    // three different scripts - one endpoint and one banner script
    // (public/banner.js) beats four renderers that have to stay in
    // step. Never an HTTP error: a broken config is not a broken
    // server, and the pages below it keep working from the record.
    send(res, 200, "application/json", JSON.stringify({ problem: view.getConfigProblem() }));
    return;
  }

  const staticFile = STATIC_FILES[url.pathname];
  if (staticFile) {
    send(res, 200, staticFile.contentType, readFileSync(join(PUBLIC_DIR, staticFile.file)));
    return;
  }

  // A task's own page - TASK_PAGE_PATH is built from TASK_ID_PATTERN
  // itself, so nothing but a real task id's shape ever reaches this; the
  // page's own script (task.js) reads the id back out of
  // `location.pathname` and asks the API routes below for its data.
  if (TASK_PAGE_PATH.test(url.pathname)) {
    send(res, 200, "text/html; charset=utf-8", readFileSync(join(PUBLIC_DIR, "task.html")));
    return;
  }

  if (url.pathname === "/api/state" || url.pathname === "/api/history") {
    // The main page (/) shows only open tasks - working, asked a
    // question, delivered - and is the default; /history shows only
    // finished ones (failed, stopped, closed). Both read the exact same
    // state (so spend and sort order never disagree between the two) and
    // just keep the half of `tasks` their own page is allowed to show -
    // the split is enforced here, server-side, not left to the page's own
    // JS to get right.
    //
    // Building this state calls straight into every reused query over
    // whatever is actually on disk (taskSpend, formatUsd, ...), none of
    // which validate an event's contents beyond its JSON shape - a line
    // that parses fine but holds something unexpected (e.g. a
    // "cost-recorded" event whose "usd" isn't really a number) can throw
    // deep inside one of those. The record itself is still there and
    // still readable next time; only this one read failed, so this
    // answers rather than letting that throw reach the server's request
    // listener and take the whole process down with it.
    const wantFinished = url.pathname === "/api/history";
    try {
      const state = view.getState();
      send(res, 200, "application/json", JSON.stringify({ ...state, tasks: state.tasks.filter((t) => t.finished === wantFinished) }));
    } catch (err) {
      sendRecordError(res, err);
    }
    return;
  }

  const taskMatch = TASK_API_PATH.exec(url.pathname);
  if (taskMatch) {
    const taskId = decodeTaskId(taskMatch[1]);
    if (taskId === null) {
      send(res, 400, "text/plain; charset=utf-8", "Not a task id.");
      return;
    }
    let task: ReturnType<typeof view.getTask>;
    try {
      task = view.getTask(taskId);
    } catch (err) {
      sendRecordError(res, err);
      return;
    }
    if (task === null) {
      send(res, 404, "text/plain; charset=utf-8", "No such task.");
      return;
    }
    send(res, 200, "application/json", JSON.stringify({ task }));
    return;
  }

  const transcriptMatch = TRANSCRIPT_PATH.exec(url.pathname);
  if (transcriptMatch) {
    const taskId = decodeTaskId(transcriptMatch[1]);
    if (taskId === null) {
      send(res, 400, "text/plain; charset=utf-8", "Not a task id.");
      return;
    }
    let transcript: ReturnType<typeof view.getTranscript>;
    try {
      transcript = view.getTranscript(taskId);
    } catch (err) {
      sendRecordError(res, err);
      return;
    }
    if (transcript === null) {
      send(res, 404, "text/plain; charset=utf-8", "No such task.");
      return;
    }
    send(res, 200, "application/json", JSON.stringify({ transcript }));
    return;
  }

  send(res, 404, "text/plain; charset=utf-8", "Not found.");
}

/** The task id a `([^/]+)` capture stands for, or null when it isn't one
 * - every route that takes a task id decodes and validates it the same
 * way: `decodeURIComponent` itself throws on malformed percent-encoding
 * (e.g. a lone "%"), and anything that decodes but isn't shaped like a
 * real task id (a percent-encoded path-traversal attempt, say) is just
 * as much "not a task id" as that is. */
function decodeTaskId(raw: string): string | null {
  let taskId: string;
  try {
    taskId = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return TASK_ID_PATTERN.test(taskId) ? taskId : null;
}

/** The one shape both record-backed endpoints answer with when building
 * their response throws: still 200 (the server did its job; the record
 * read is what failed), carrying the exact sentence the Client asked for
 * so the page can show it instead of going blank or hanging. */
function sendRecordError(res: ServerResponse, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  send(res, 200, "application/json", JSON.stringify({ error: `could not read the record: ${message}` }));
}

/** The authenticated tailnet user on this request, or null when there
 * isn't one. The one place that header is read: `refuseWithoutIdentity`
 * gates on it, and the stop route additionally records the login as part
 * of its own decision (issue #203 - the record says who made every
 * other decision, and a stop is one). */
function identityOf(req: IncomingMessage): string | null {
  const identity = req.headers[TAILSCALE_IDENTITY_HEADER];
  if (typeof identity !== "string") return null;
  const trimmed = identity.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Recording a decision from the phone - the identity half, shared by
 * both of this server's writes (issue #202's verdict, and answering a
 * worker's questions).
 *
 * A request carrying no `Tailscale-User-Login` header is refused
 * outright (403), before anything about its body is even read. This
 * server still only ever binds to loopback (HOST, above) - the one
 * legitimate way a real header lands here is a locally-running
 * `tailscale serve` adding it while proxying from the tailnet, per
 * Tailscale's own documented best practice ("it's best practice to only
 * have the service listen on localhost - otherwise any user that can
 * call your service directly...could trivially provide their own values
 * for these headers"). Nothing else about who is asking is checked -
 * which login it is, specifically - since v1's one Client is the only
 * identity this ever needs to recognize at all.
 *
 * `what` names the decision in the refusal's own words ("a verdict", "an
 * answer", "a stop"); true means the request was refused. */
function refuseWithoutIdentity(req: IncomingMessage, res: ServerResponse, what: string): boolean {
  if (identityOf(req) !== null) return false;
  send(
    res,
    403,
    "application/json",
    JSON.stringify({
      error: `no Tailscale identity on this request - ${what} can only be recorded through a connection carrying one.`,
    })
  );
  return true;
}

/** Recording a verdict from the phone (issue #202). One of this
 * server's two writes, held to the same two things CONTRACT rule 6 /
 * `fabrica verdict` already are: identity (above) and an actual
 * decision.
 *
 * Decision: calls the exact same `recordVerdictDecision` -
 * `spawnDetachedResume` pair `src/cli/verdict-command.ts` calls for
 * `fabrica verdict` itself - a bad ruling (unknown task, already closed,
 * a "fix" with no note, ...) fails the same way here as it would on the
 * command line, and a "fix" is handed off to the exact same detached
 * background round. */
async function handleRecordVerdict(
  req: IncomingMessage,
  res: ServerResponse,
  recordHome: string,
  taskId: string,
  entryScripts: EntryScripts
): Promise<void> {
  if (refuseWithoutIdentity(req, res, "a verdict")) return;

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    send(res, 400, "application/json", JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    return;
  }

  const { ruling, note } = (typeof body === "object" && body !== null ? body : {}) as { ruling?: unknown; note?: unknown };
  if (typeof ruling !== "string" || !VERDICT_RULINGS.has(ruling)) {
    send(res, 400, "application/json", JSON.stringify({ error: `"${String(ruling)}" is not a verdict. Use one of: accept, fix, wrong.` }));
    return;
  }
  if (note !== undefined && typeof note !== "string") {
    send(res, 400, "application/json", JSON.stringify({ error: "note must be a one-line string." }));
    return;
  }

  try {
    const caps = loadConfigOrDefault(recordHome).caps;
    recordVerdictDecision(recordHome, taskId, ruling as "accept" | "fix" | "wrong", note, { caps });
    if (ruling === "fix") spawnDetachedResume({ recordHome, taskId, kind: "fix", entryScript: entryScripts.fix });
    const quiz = ruling === "accept" ? startQuizRecheck(recordHome, taskId, entryScripts.quizRecheck) : undefined;
    send(res, 200, "application/json", JSON.stringify({ ok: true, ruling, ...(quiz ? { quiz } : {}) }));
  } catch (err) {
    send(res, 400, "application/json", JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}

/**
 * The quiz's bookkeeping on an accept - the exact same pair
 * `src/cli/verdict-command.ts`'s own `quizNoticeAfterAccept` runs, for
 * the same reason and in the same place in the sequence: an accepted
 * task's files may be the files an older accepted task's quiz questions
 * were written about, so those questions are marked and stop being asked
 * until a cheap re-check round rules on them (Client ruling: on each
 * accept, no schedule and no button).
 *
 * Never throws. The verdict is already on the record by the time this
 * runs, and the Client's ruling must not come back as a failure because
 * something about a quiz could not be read.
 */
function startQuizRecheck(
  recordHome: string,
  taskId: string,
  entryScript: string | undefined
): { marked: number; pending: number } | undefined {
  try {
    const { marked, pending } = onTaskAccepted(recordHome, taskId);
    if (pending > 0) spawnDetachedResume({ recordHome, taskId, kind: "quiz-recheck", entryScript });
    // Nothing to report when this change dated nothing and nothing was
    // already waiting - the ordinary case, and the response says exactly
    // what it said before the quiz had a memory.
    if (marked.length === 0 && pending === 0) return undefined;
    return { marked: marked.length, pending };
  } catch {
    return undefined;
  }
}

/**
 * Recording a quiz mark - this server's fourth write, and the one that is
 * deliberately NOT behind the `Tailscale-User-Login` gate the other three
 * are.
 *
 * The three above spend money or close a task; a mark only moves a
 * spaced-repetition clock. This server binds to loopback either way
 * (HOST, above), and requiring the header would make review mode
 * unusable in the one place it is actually used: `fabrica up` opens
 * `127.0.0.1:7777` in a browser on this machine, where no `tailscale
 * serve` proxy exists to add it. The cost of that choice, stated rather
 * than hidden: anything that can reach this port can skew the Client's
 * own quiz schedule. It would be visible on the record - every mark is an
 * event - and it buys an attacker nothing else.
 *
 * Which question is being marked is validated by `recordQuizAnswer`
 * itself (src/quiz/review.ts), so a question this record never held is
 * refused in its words rather than a second wording invented here.
 */
async function handleQuizAnswer(req: IncomingMessage, res: ServerResponse, recordHome: string): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    send(res, 400, "application/json", JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    return;
  }

  const { taskId, index, right } = (typeof body === "object" && body !== null ? body : {}) as {
    taskId?: unknown;
    index?: unknown;
    right?: unknown;
  };
  if (typeof taskId !== "string" || !TASK_ID_PATTERN.test(taskId)) {
    send(res, 400, "application/json", JSON.stringify({ error: "Not a task id." }));
    return;
  }
  if (typeof index !== "number" || typeof right !== "boolean") {
    send(
      res,
      400,
      "application/json",
      JSON.stringify({ error: 'a mark needs a question and a result - send {"taskId": "...", "index": 0, "right": true}.' })
    );
    return;
  }

  try {
    const question = recordQuizAnswer(recordHome, taskId, index, right);
    send(res, 200, "application/json", JSON.stringify({ ok: true, question }));
  } catch (err) {
    const status = err instanceof QuizError ? 400 : 500;
    send(res, status, "application/json", JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}

/** Answering a worker's clarifying questions from the phone - this
 * server's second write, and the only one that isn't a verdict at all:
 * a task in the "asking" state is waiting on the Client's own words
 * (SPEC.md step 2, issue #8), which is exactly what a phone is good for.
 *
 * Identity: the same `Tailscale-User-Login` gate as the verdict route
 * above, for the same reasons and with the same 403 - an answer becomes
 * part of the brief a worker is handed and spends real money resuming
 * the task, so it is every bit as much a decision as a ruling is.
 *
 * Decision: calls the exact same `recordAnswerDecision` -
 * `spawnDetachedResume({ kind: "answer" })` pair
 * `src/cli/answer-command.ts` calls for `fabrica answer` itself. A bad
 * answer (unknown task, nothing pending to answer, a clarification
 * round already spent, a cap refusal, empty text) fails here with the
 * identical message it would print on the command line, before anything
 * is handed off; a good one records the round synchronously and leaves
 * the work itself to the same detached background process (issue #123),
 * so this responds immediately rather than holding the phone's
 * connection open for a whole production round. */
async function handleRecordAnswer(
  req: IncomingMessage,
  res: ServerResponse,
  recordHome: string,
  taskId: string,
  answerEntryScript: string | undefined
): Promise<void> {
  if (refuseWithoutIdentity(req, res, "an answer")) return;

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    send(res, 400, "application/json", JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    return;
  }

  // Only the shape is checked here; whether the answer is actually
  // usable - an option the question doesn't have, "other" with no words
  // behind it - is `recordAnswerDecision`'s own call, so it is refused in
  // exactly the words `fabrica answer` would use rather than a second
  // wording invented here. `option` (issue #176) is the number of the
  // choice tapped, 1-based as the record lists them; without one the
  // answer is the Client's own words, which is what this route has
  // always taken.
  const { answer, option } = (typeof body === "object" && body !== null ? body : {}) as {
    answer?: unknown;
    option?: unknown;
  };
  if (typeof answer !== "string") {
    send(res, 400, "application/json", JSON.stringify({ error: "an answer needs text - send {\"answer\": \"<your words>\"}." }));
    return;
  }
  if (option !== undefined && (typeof option !== "number" || !Number.isInteger(option) || option < 1)) {
    send(
      res,
      400,
      "application/json",
      JSON.stringify({ error: 'an option is the choice\'s number - send {"option": 1} or leave it out.' })
    );
    return;
  }

  try {
    const caps = loadConfigOrDefault(recordHome).caps;
    const decision = recordAnswerDecision(recordHome, taskId, answer, {
      caps,
      ...(option === undefined ? {} : { option }),
    });
    // A correction to a question whose round has already finished has
    // nothing to resume - the same rule `fabrica answer` itself follows.
    if (decision.resume) {
      spawnDetachedResume({ recordHome, taskId, kind: "answer", entryScript: answerEntryScript });
    }
    send(res, 200, "application/json", JSON.stringify({ ok: true, resumed: decision.resume, duplicate: decision.duplicate }));
  } catch (err) {
    send(res, 400, "application/json", JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}

/**
 * Stopping a running task from the phone (issue #203) - this server's
 * third write, and the only one that reaches outside the record at all.
 *
 * Identity: the same `Tailscale-User-Login` gate as the verdict and
 * answer routes, with the same 403 and the same one-line message. A stop
 * ends work that is costing money and discards whatever the worker was
 * part-way through, so it is at least as much a decision as a ruling.
 * The login is additionally recorded, which neither of the other two
 * routes does: those write a ruling or an answer the Client composed,
 * while this writes only "it was stopped", and by whom is the rest of
 * that sentence.
 *
 * No body is read at all - there is nothing to say beyond "stop", and
 * the one confirmation the Client gives happens on the page before the
 * request is ever sent (Client ruling: "one confirmation tap before
 * firing").
 *
 * Order: record first, signal second. `recordStopDecision` refuses a
 * task that isn't running with a 400 naming the state it is actually in
 * - the page hides the control for those, but a page can be stale, and
 * refusing is a better answer than stopping something that finished an
 * hour ago. Once the event lands the task is terminal, whatever happens
 * to the process next: the Client's decision is the fact (Client
 * ruling), so a process that cannot be found - already exited, or a pid
 * this module refused to trust - is reported honestly in the response
 * rather than turned into a failure that would leave the record
 * disagreeing with him.
 */
function handleStopTask(
  req: IncomingMessage,
  res: ServerResponse,
  recordHome: string,
  taskId: string,
  stopProcess: StopProcess
): void {
  if (refuseWithoutIdentity(req, res, "a stop")) return;
  const by = identityOf(req)!;

  let stoppedFrom: string;
  try {
    stoppedFrom = recordStopDecision(recordHome, taskId, by).stoppedFrom;
  } catch (err) {
    send(res, 400, "application/json", JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    return;
  }

  const { pid } = stopProcess(recordHome, taskId);
  send(res, 200, "application/json", JSON.stringify({ ok: true, stoppedFrom, signaled: pid !== null, pid }));
}

/** A small, capped JSON body reader - this server otherwise never reads
 * a request body at all, so there is no existing helper for this. Capped
 * well above any real one-line note, purely so a malformed or hostile
 * request can't hold a connection open buffering an unbounded body. */
function readJsonBody(req: IncomingMessage, maxBytes = 8192): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (data.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** The one place in this module that writes a response's headers - every
 * route above answers through here, including the refusals and the 500
 * fallback, which is what makes `Cache-Control: no-store` true of
 * everything this server sends rather than of the routes someone
 * remembered to set it on.
 *
 * Why no-store on literally every response, pages and scripts included:
 * nothing here is fingerprinted. `index.html`, `app.js`, `review.js`,
 * `task.js`, `quiz.js`, `banner.js` and `style.css` are read off the checkout on
 * each request (STATIC_FILES, above), at paths that never change, so a
 * browser that cached one by URL goes on running code the checkout has
 * since replaced - with no version in the path to tell it otherwise. That
 * is the same staleness the banner exists to surface (`/api/version` vs
 * `/api/checkout`), except a cached `banner.js` is the layer that would
 * have reported it. The JSON API is the simpler case: it is a live view
 * of a record that changes under it by the second, and `/api/review`'s
 * answers decide what the Client rules on.
 *
 * Unconditional on purpose - no route may opt out, and
 * `integrations/live-view/server.test.ts` pins both halves: one request of
 * every response shape carries the header, and this is still the only
 * header-writing call site in the file. A caching rule worth having here
 * is one no future route can be written around. */
function send(res: ServerResponse, status: number, contentType: string, body: string | Buffer): void {
  res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(body);
}
