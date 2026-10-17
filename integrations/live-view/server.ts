// A tiny HTTP server for watching what the factory is doing (issue #26),
// now with one deliberate exception (issue #202): every handler still
// only ever reads (`readFileSync`/`readdirSync`, directly or through
// src/index.ts) EXCEPT the one POST route below that records the
// Client's verdict from the phone review page - see "Recording a verdict
// from the phone" lower in this file, and this module's README, for why
// that one write is safe to allow here.
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
import { recordVerdictDecision, TASK_ID_PATTERN } from "../../src/index.ts";
import { runningCopyCommit } from "../../src/cli/doctor-command.ts";
import { loadConfigOrDefault } from "../../src/cli/load-config.ts";
import { spawnDetachedResume } from "../../src/cli/spawn-detached.ts";
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
  "/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", contentType: "text/css; charset=utf-8" },
  "/task.js": { file: "task.js", contentType: "text/javascript; charset=utf-8" },
  "/review.js": { file: "review.js", contentType: "text/javascript; charset=utf-8" },
};

const TRANSCRIPT_PATH = /^\/api\/tasks\/([^/]+)\/transcript$/;
const TASK_API_PATH = /^\/api\/tasks\/([^/]+)$/;
/** A task's own page (issue: "styling the live app better" - the live
 * transcript is too much to expand in place, so it gets a page of its
 * own). Matched against `TASK_ID_PATTERN` itself, not just `[^/]+`, so
 * nothing but a real task id ever reaches `task.html`. */
const TASK_PAGE_PATH = new RegExp(`^/tasks/(${TASK_ID_PATTERN.source.slice(1, -1)})$`);
/** The phone review page's one write (issue #202) - a loose capture, the
 * same shape as TASK_API_PATH/TRANSCRIPT_PATH above, not TASK_ID_PATTERN
 * embedded directly: the handler below decodes first and validates
 * against TASK_ID_PATTERN after, so a malformed id (e.g. a percent-
 * encoded path-traversal attempt) gets the same "Not a task id." 400
 * those routes give rather than falling through to this route not
 * matching at all and reporting a generic 405. */
const REVIEW_VERDICT_PATH = /^\/api\/review\/tasks\/([^/]+)\/verdict$/;
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
 * can run at once without colliding. `commit` defaults to this running
 * copy's real commit (src/cli/doctor-command.ts's `runningCopyCommit`,
 * the exact value `fabrica doctor`'s own "checkout" line reports) -
 * overridable so a test can make /api/version answer a fixed value
 * without depending on this checkout's real git state. */
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
}): Promise<LiveView> {
  const view = createRecordView(opts.recordHome);
  const commit = opts.commit ?? (() => runningCopyCommit(CHECKOUT));
  const server = createServer((req, res) => {
    handleRequest(req, res, view, commit, opts.recordHome, opts.fixEntryScript).catch((err) => {
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

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  view: ReturnType<typeof createRecordView>,
  commit: () => string | null,
  recordHome: string,
  fixEntryScript: string | undefined
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${HOST}`);

  // The one route that isn't a GET - everything else below this still
  // only ever reads. Checked before the blanket "only GET" rejection so
  // this single POST isn't caught by it.
  const verdictMatch = REVIEW_VERDICT_PATH.exec(url.pathname);
  if (req.method === "POST" && verdictMatch) {
    let taskId: string;
    try {
      taskId = decodeURIComponent(verdictMatch[1]);
    } catch {
      send(res, 400, "text/plain; charset=utf-8", "Not a task id.");
      return;
    }
    if (!TASK_ID_PATTERN.test(taskId)) {
      send(res, 400, "text/plain; charset=utf-8", "Not a task id.");
      return;
    }
    await handleRecordVerdict(req, res, recordHome, taskId, fixEntryScript);
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
    try {
      send(res, 200, "application/json", JSON.stringify({ rows: view.getReviewRows() }));
    } catch (err) {
      sendRecordError(res, err);
    }
    return;
  }

  if (url.pathname === "/api/version") {
    // What `fabrica up` compares its own running commit against, to
    // tell a live view running the current code from a stale one left
    // over from before a merge (issue: "fabrica up must never reuse a
    // live view running older code").
    send(res, 200, "application/json", JSON.stringify({ commit: commit() }));
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
    let taskId: string;
    try {
      taskId = decodeURIComponent(taskMatch[1]);
    } catch {
      send(res, 400, "text/plain; charset=utf-8", "Not a task id.");
      return;
    }
    if (!TASK_ID_PATTERN.test(taskId)) {
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
    let taskId: string;
    try {
      taskId = decodeURIComponent(transcriptMatch[1]);
    } catch {
      // Malformed percent-encoding (e.g. a lone "%") - decodeURIComponent
      // itself throws on this; not a task id either way.
      send(res, 400, "text/plain; charset=utf-8", "Not a task id.");
      return;
    }
    if (!TASK_ID_PATTERN.test(taskId)) {
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

/** The one shape both record-backed endpoints answer with when building
 * their response throws: still 200 (the server did its job; the record
 * read is what failed), carrying the exact sentence the Client asked for
 * so the page can show it instead of going blank or hanging. */
function sendRecordError(res: ServerResponse, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  send(res, 200, "application/json", JSON.stringify({ error: `could not read the record: ${message}` }));
}

/** Recording a verdict from the phone (issue #202). This is the one
 * write this server ever performs, and it is held to the same two
 * things CONTRACT rule 6 / `fabrica verdict` already are: identity and
 * an actual decision.
 *
 * Identity: a request carrying no `Tailscale-User-Login` header is
 * refused outright (403), before anything about its body is even read.
 * This server still only ever binds to loopback (HOST, above) - the one
 * legitimate way a real header lands here is a locally-running
 * `tailscale serve` adding it while proxying from the tailnet, per
 * Tailscale's own documented best practice ("it's best practice to only
 * have the service listen on localhost - otherwise any user that can
 * call your service directly...could trivially provide their own values
 * for these headers"). Nothing else about who is asking is checked -
 * which login it is, specifically - since v1's one Client is the only
 * identity this ever needs to recognize at all.
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
  fixEntryScript: string | undefined
): Promise<void> {
  const identity = req.headers[TAILSCALE_IDENTITY_HEADER];
  if (typeof identity !== "string" || identity.trim().length === 0) {
    send(
      res,
      403,
      "application/json",
      JSON.stringify({
        error: "no Tailscale identity on this request - a verdict can only be recorded through a connection carrying one.",
      })
    );
    return;
  }

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
    if (ruling === "fix") spawnDetachedResume({ recordHome, taskId, kind: "fix", entryScript: fixEntryScript });
    send(res, 200, "application/json", JSON.stringify({ ok: true, ruling }));
  } catch (err) {
    send(res, 400, "application/json", JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
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

function send(res: ServerResponse, status: number, contentType: string, body: string | Buffer): void {
  res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(body);
}
