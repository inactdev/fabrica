// `fabrica update`: take new Fabrica code without losing a running chat
// session. Works out which copy is running the same way `fabrica
// doctor` does (`detectCopy`): a developer checkout (`.git` present)
// pulls with `git pull --ff-only origin master` - refused up front, with
// a clear message, if it isn't on master or has uncommitted changes; an
// installed copy (`.git` stripped by npm's own packing) re-runs the
// documented install command, `npm install -g github:inactdev/fabrica`.
//
// If the live view is listening on 127.0.0.1:7777 and its own
// /api/version disagrees with the commit just updated to, it is
// restarted; a current one is left running. The restart reuses the
// exact mechanism `fabrica up` already uses to start the live view
// (`spawnDetachedLiveView`), and stops the old one with the same `pkill
// -f "live-view/start.ts"` command `fabrica up` already prints as the
// documented way to stop it - deliberately not a new pidfile-based kill,
// so there is still exactly one answer to "how do I stop the live
// view", not two mechanisms that could drift apart.
//
// Prints one summary line: the commit before and after, whether the
// live view was restarted, and the exact next step - resuming the chat
// session with `fabrica up --continue`.

import { execFileSync, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.ts";
import { resolveRecordHome } from "./record-home.ts";
import { detectCopy, type CopyInfo } from "./doctor-command.ts";
import { spawnDetachedLiveView } from "./spawn-detached.ts";

export const UPDATE_USAGE = "fabrica update";

export const UPDATE_HELP = `Usage: ${UPDATE_USAGE}

Updates this copy of fabrica in place, then prints how to resume:

  1. A developer checkout (a .git folder present) runs:
       git pull --ff-only origin master
     Refused with a clear message first if it isn't on master, or has
     uncommitted changes. An installed copy re-runs the documented
     install command instead:
       npm install -g github:inactdev/fabrica
  2. If the live view is listening on 127.0.0.1:7777 and its own
     /api/version disagrees with the commit just updated to, it is
     restarted the same way fabrica up starts it; a current one is left
     running.
  3. Prints one summary line: the commit before and after, whether the
     live view was restarted, and the exact next step.

This command is denied to the chat agent - the Client runs it himself,
never an AI driving the Bash tool underneath its own running session.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

/** `fabrica update` takes no flags or positionals - anything given is
 * refused with the exact usage line, the same way `fabrica doctor`
 * refuses (doctor-command.ts's parseDoctorArgs). */
function parseUpdateArgs(argv: string[]): void {
  const [first] = argv;
  if (first === undefined) return;
  if (first.startsWith("-")) {
    throw new CliError("bad-usage", `fabrica update: unknown flag "${first}". Usage: ${UPDATE_USAGE}`);
  }
  throw new CliError("bad-usage", `fabrica update: unexpected argument "${first}" - update takes none. Usage: ${UPDATE_USAGE}`);
}

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIVE_VIEW_PORT = 7777;

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 12) : "unknown";
}

export interface ExternalCommandResult {
  ok: boolean;
  message: string;
}

function runGitPullFfOnly(root: string): ExternalCommandResult {
  const result = spawnSync("git", ["pull", "--ff-only", "origin", "master"], { cwd: root, stdio: "inherit" });
  if (result.error) return { ok: false, message: result.error.message };
  return (result.status ?? 1) === 0
    ? { ok: true, message: "" }
    : { ok: false, message: `git pull --ff-only origin master exited with status ${result.status}` };
}

function runNpmInstall(): ExternalCommandResult {
  const result = spawnSync("npm", ["install", "-g", "github:inactdev/fabrica"], { stdio: "inherit" });
  if (result.error) return { ok: false, message: result.error.message };
  return (result.status ?? 1) === 0
    ? { ok: true, message: "" }
    : { ok: false, message: `npm install -g github:inactdev/fabrica exited with status ${result.status}` };
}

/** The exact command `fabrica up` already prints as the documented way
 * to stop the live view - reused here rather than a new pidfile-based
 * kill, so there is still exactly one answer to "how do I stop it". A
 * non-zero exit (nothing matched) is not itself a failure - it just
 * means there was nothing left running to stop. */
function stopLiveView(): ExternalCommandResult {
  const result = spawnSync("pkill", ["-f", "live-view/start.ts"]);
  if (result.error) return { ok: false, message: result.error.message };
  return { ok: true, message: "" };
}

function probePortListening(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitUntil(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function fetchLiveViewCommit(port: number, timeoutMs = 2_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { commit?: string | null };
    return body.commit ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface RunUpdateCommandOptions {
  recordHome?: string;
  /** Test-only: replaces the real detectCopy(CHECKOUT, ...) call. */
  copy?: CopyInfo;
  /** Test-only seams for each external action, so tests never spawn a
   * real git/npm/pkill process. */
  gitStatusPorcelain?: (root: string) => string | null;
  gitPullFfOnly?: (root: string) => ExternalCommandResult;
  gitRevParseHead?: (root: string) => string | null;
  runInstallCommand?: () => ExternalCommandResult;
  detectInstalledCommit?: (root: string) => string | null;
  liveViewPort?: number;
  isLiveViewListening?: (host: string, port: number) => Promise<boolean>;
  fetchLiveViewCommit?: (port: number) => Promise<string | null>;
  stopLiveView?: () => ExternalCommandResult;
  startLiveView?: (opts: { recordHome: string; port: number }) => void;
  liveViewRestartTimeoutMs?: number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Returns the process exit code - never throws. */
export async function runUpdateCommand(argv: string[], opts: RunUpdateCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));

  try {
    parseUpdateArgs(argv);
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const recordHome = opts.recordHome ?? resolveRecordHome();
  const copy = opts.copy ?? detectCopy(CHECKOUT, (args) => git(CHECKOUT, args));
  const beforeCommit = copy.commit;
  let afterCommit: string | null;

  if (copy.kind === "dev-checkout") {
    if (copy.branch !== "master") {
      stderr(
        `fabrica update: this checkout is on "${copy.branch || "a detached HEAD"}", not master - switch to master first (git -C ${copy.root} checkout master).`
      );
      return 1;
    }
    const status = (opts.gitStatusPorcelain ?? ((root) => git(root, ["status", "--porcelain"])))(copy.root);
    if (status === null) {
      stderr(`fabrica update: could not read git status in ${copy.root}.`);
      return 1;
    }
    if (status.length > 0) {
      stderr("fabrica update: this checkout has uncommitted changes - commit or stash them first.");
      return 1;
    }
    const pull = (opts.gitPullFfOnly ?? runGitPullFfOnly)(copy.root);
    if (!pull.ok) {
      stderr(`fabrica update: git pull --ff-only origin master failed${pull.message ? ` (${pull.message})` : ""}.`);
      return 1;
    }
    afterCommit = (opts.gitRevParseHead ?? ((root) => git(root, ["rev-parse", "HEAD"])))(copy.root);
  } else {
    const install = (opts.runInstallCommand ?? runNpmInstall)();
    if (!install.ok) {
      stderr(`fabrica update: npm install -g github:inactdev/fabrica failed${install.message ? ` (${install.message})` : ""}.`);
      return 1;
    }
    afterCommit = (opts.detectInstalledCommit ?? ((root) => detectCopy(root, () => null).commit))(copy.root);
  }

  const port = opts.liveViewPort ?? LIVE_VIEW_PORT;
  const isListening = opts.isLiveViewListening ?? probePortListening;
  const fetchCommit = opts.fetchLiveViewCommit ?? fetchLiveViewCommit;
  const restartTimeoutMs = opts.liveViewRestartTimeoutMs ?? 10_000;
  const startLiveView = opts.startLiveView ?? ((o: { recordHome: string; port: number }) => spawnDetachedLiveView({ recordHome: o.recordHome }));

  let restarted = false;
  if (await isListening("127.0.0.1", port)) {
    const runningCommit = await fetchCommit(port);
    if (runningCommit !== afterCommit) {
      const stop = (opts.stopLiveView ?? stopLiveView)();
      if (!stop.ok) {
        stderr(
          `fabrica update: could not stop the running live view automatically${stop.message ? ` (${stop.message})` : ""} - stop it yourself with: pkill -f "live-view/start.ts", then run fabrica up again.`
        );
      } else {
        await waitUntil(async () => !(await isListening("127.0.0.1", port)), restartTimeoutMs);
        startLiveView({ recordHome, port });
        const started = await waitUntil(() => isListening("127.0.0.1", port), restartTimeoutMs);
        restarted = started && (await fetchCommit(port)) === afterCommit;
      }
    }
  }

  stdout(
    `fabrica update: ${short(beforeCommit)} -> ${short(afterCommit)} - live view ${restarted ? "restarted" : "not restarted"} - resume your session with: fabrica up --continue`
  );
  return 0;
}
