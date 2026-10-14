// `fabrica up`: starts a working session from a registered project's
// folder in three steps - doctor's own checks, the live view (started
// detached and reused if already running), then the harness itself.
//
// Which harness and how to launch it is deliberately not named here:
// src/ outside src/brain/adapters/ may never mention a brain or a
// harness by name (CONTRACT rule 8's scan - see
// contract/rule8.no-favorite-brain.test.ts), and this command talks to
// the Client's own chat harness, not a Worker's brain, but the same
// rule applies to anything under src/ - see verify-hook-command.ts's
// identical reasoning for its own skill/<harness>/verify.ts. This file
// discovers a skill/<harness>/launch.ts by scanning skill/ at runtime
// instead.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CliError } from "./errors.ts";
import { resolveRecordHome } from "./record-home.ts";
import { runDoctorCommand, runningCopyCommit, type DoctorProbes } from "./doctor-command.ts";
import { spawnDetachedLiveView } from "./spawn-detached.ts";
import { findLiveViewProcess as locateLiveViewProcess, stopLiveViewProcess as terminateLiveViewProcess } from "./live-view-process.ts";

export const UP_USAGE = "fabrica up";

export const UP_HELP = `Usage: ${UP_USAGE}

Starts a working session from inside a registered project's folder, in
order:

  1. Runs the same checks as \`fabrica doctor\` - stops here, with the
     doctor output, if any check fails.
  2. Starts the live view in the background (http://localhost:7777)
     and opens it in your default browser - unless one is already
     listening there and running this exact copy's code (checked via
     its own /api/version), in which case its address is printed
     instead of opening a browser. One running older code (e.g. left
     over from before a merge) is stopped first and replaced with a
     fresh one - never reused, and never a second copy either way.
  3. Launches your chat harness in this folder, with HANDBOOK.md
     appended to its system prompt and this harness's own settings
     loaded through its own command-line flags - nothing is ever
     written into this folder.

When the harness exits, the live view keeps running - this prints one
line saying how to stop it.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

/** `fabrica up` takes no flags or positionals - anything given is
 * refused with the exact usage line, the same way verify-hook refuses
 * (src/cli/verify-hook-command.ts's parseVerifyHookArgs). */
export function parseUpArgs(argv: string[]): void {
  const [first] = argv;
  if (first === undefined) return;
  if (first.startsWith("-")) {
    throw new CliError("bad-usage", `fabrica up: unknown flag "${first}". Usage: ${UP_USAGE}`);
  }
  throw new CliError("bad-usage", `fabrica up: unexpected argument "${first}" - up takes none. Usage: ${UP_USAGE}`);
}

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HANDBOOK_PATH = join(CHECKOUT, "HANDBOOK.md");
const SKILL_DIR = join(CHECKOUT, "skill");
const INTEGRATIONS_DIR = join(CHECKOUT, "integrations");

/** The one address the live view is ever documented to listen on
 * (integrations/live-view/server.ts's own DEFAULT_PORT) - duplicated as
 * a literal here rather than imported, since src/ depends on nothing
 * under integrations/ (the dependency runs the other way: both
 * src/cli/ and integrations/ reach Fabrica only through src/index.ts). */
export const LIVE_VIEW_PORT = 7777;

function liveViewUrl(port: number): string {
  return `http://localhost:${port}`;
}

export interface HarnessLauncher {
  launch(opts: { cwd: string; settingsPath: string; appendSystemPrompt: string }): { exitCode: number } | Promise<{ exitCode: number }>;
  harnessAvailable(): boolean;
}

function missingLauncherExports(module: unknown): string[] {
  const candidate = module as Partial<HarnessLauncher> | null;
  const missing: string[] = [];
  if (typeof candidate?.launch !== "function") missing.push("launch");
  if (typeof candidate?.harnessAvailable !== "function") missing.push("harnessAvailable");
  return missing;
}

export interface HarnessLauncherLookup {
  launcher: HarnessLauncher | null;
  /** The skill/<harness>/ directory the launcher was found in - where
   * this harness's own settings.json lives too. Null exactly when
   * launcher is null. */
  harnessDir: string | null;
  loadFailures: { path: string; problem: string }[];
}

/** The first skill/<harness>/launch.ts that actually exports both
 * halves - the same "first usable one, skipped by name rather than
 * silently" shape as verify-hook-command.ts's loadHarnessVerifier,
 * duplicated rather than shared: the two loaders scan for a different
 * filename and shape, and loadHarnessVerifier is a settled, heavily
 * tested module this change has no reason to touch. */
export async function loadHarnessLauncher(skillDir: string = SKILL_DIR): Promise<HarnessLauncherLookup> {
  const loadFailures: { path: string; problem: string }[] = [];
  if (!existsSync(skillDir)) return { launcher: null, harnessDir: null, loadFailures };
  for (const name of readdirSync(skillDir)) {
    const harnessDir = join(skillDir, name);
    const launchPath = join(harnessDir, "launch.ts");
    if (!existsSync(launchPath)) continue;
    let module: unknown = null;
    try {
      // pathToFileURL, not a plain path string: import() parses its
      // argument as a URL, which truncates at a literal "#" or "?" in
      // the checkout's path - same reasoning as verify-hook-command.ts.
      module = await import(pathToFileURL(launchPath).href);
    } catch (err) {
      loadFailures.push({ path: launchPath, problem: `could not be loaded: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const missing = missingLauncherExports(module);
    if (missing.length === 0) return { launcher: module as HarnessLauncher, harnessDir, loadFailures };
    loadFailures.push({
      path: launchPath,
      problem: `loaded, but exports no ${missing.join(" and no ")} - a launch script needs both launch and harnessAvailable`,
    });
  }
  return { launcher: null, harnessDir: null, loadFailures };
}

/** An optional integration's own reaction to `fabrica up` starting a
 * session - e.g. mirroring this record home into some other tool,
 * started detached the same way the live view is, only when that other
 * tool's own environment sentinel says it's present and nothing of its
 * own is already running for this record home. Discovered the same way
 * loadHarnessLauncher discovers skill/<harness>/launch.ts - by scanning
 * a directory at runtime for a file exporting this shape - so that
 * which integrations exist, and what they each need to decide whether
 * to start, is never named here (CONTRACT rule 8's scan already governs
 * src/ this way for a harness's name; the same reasoning applies to
 * anything else under src/ that would otherwise have to name a
 * particular outside tool). Must do nothing, silently, unless its own
 * conditions are met - this is called unconditionally for every
 * discovered hook. */
export interface UpIntegrationHook {
  maybeStart(opts: { recordHome: string; env: NodeJS.ProcessEnv }): void | Promise<void>;
}

function missingUpIntegrationHookExports(module: unknown): string[] {
  const candidate = module as Partial<UpIntegrationHook> | null;
  return typeof candidate?.maybeStart !== "function" ? ["maybeStart"] : [];
}

export interface UpIntegrationHookLookup {
  hooks: UpIntegrationHook[];
  loadFailures: { path: string; problem: string }[];
}

/** Every integrations/<name>/up-hook.ts that actually exports
 * maybeStart - unlike loadHarnessLauncher's "first usable one" (only
 * one harness can be launched at a time), every usable hook here runs,
 * since any number of optional integrations could each want to react
 * to a session starting. */
export async function loadUpIntegrationHooks(integrationsDir: string = INTEGRATIONS_DIR): Promise<UpIntegrationHookLookup> {
  const loadFailures: { path: string; problem: string }[] = [];
  const hooks: UpIntegrationHook[] = [];
  if (!existsSync(integrationsDir)) return { hooks, loadFailures };
  for (const name of readdirSync(integrationsDir)) {
    const dir = join(integrationsDir, name);
    const hookPath = join(dir, "up-hook.ts");
    if (!existsSync(hookPath)) continue;
    let module: unknown = null;
    try {
      // pathToFileURL, not a plain path string - same reasoning as
      // loadHarnessLauncher: import() parses its argument as a URL.
      module = await import(pathToFileURL(hookPath).href);
    } catch (err) {
      loadFailures.push({ path: hookPath, problem: `could not be loaded: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const missing = missingUpIntegrationHookExports(module);
    if (missing.length === 0) {
      hooks.push(module as UpIntegrationHook);
      continue;
    }
    loadFailures.push({
      path: hookPath,
      problem: `loaded, but exports no ${missing.join(" and no ")} - an up-hook script needs maybeStart`,
    });
  }
  return { hooks, loadFailures };
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

async function waitUntilListening(
  isListening: (host: string, port: number) => Promise<boolean>,
  port: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isListening("127.0.0.1", port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** The inverse wait, used after stopping a stale live view: gives the
 * OS a moment to actually free the port before a fresh one tries to
 * bind it. If this times out, startFresh is still attempted - the
 * fresh process's own bind failure (if the old one truly never let go)
 * surfaces the same way any other "never started listening" case
 * already does, rather than this function inventing a second way to
 * report it. */
async function waitUntilNotListening(
  isListening: (host: string, port: number) => Promise<boolean>,
  port: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await isListening("127.0.0.1", port))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Asks an already-listening live view what commit it's running, via
 * its own `/api/version` (integrations/live-view/server.ts). Null
 * means "didn't answer that endpoint" - a connection error, a non-200,
 * a body with no usable `commit` string - and is treated identically
 * to "answered with a different commit": either way the live view
 * can't be trusted to be running today's code. A short timeout keeps a
 * hung, non-live-view listener from blocking `fabrica up` indefinitely. */
async function defaultFetchLiveViewVersion(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { commit?: unknown };
    return typeof body.commit === "string" ? body.commit : null;
  } catch {
    return null;
  }
}

/** Best-effort only: a failure to find an opener on this machine (no
 * `xdg-open`, no GUI at all) must never stop the session from
 * launching - the printed address is the real fallback either way. */
function defaultOpenBrowser(url: string): void {
  const { command, args } =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // same best-effort reasoning - nothing left to do here but fall
    // through to the printed address.
  }
}

export interface RunUpCommandOptions {
  recordHome?: string;
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Forwarded to runDoctorCommand verbatim - see its own DoctorProbes. */
  doctorProbes?: DoctorProbes;
  /** Test-only: a different port than the documented 7777, so a test
   * never has to bind the one address this command is actually
   * specified against. */
  liveViewPort?: number;
  /** Test-only seam for the port probe itself. */
  isLiveViewListening?: (host: string, port: number) => Promise<boolean>;
  /** Test-only seam replacing the real detached spawn. */
  startLiveView?: (opts: { recordHome: string; port: number }) => void;
  /** Test-only seam replacing the real OS browser opener. */
  openBrowser?: (url: string) => void;
  /** Test-only seam replacing the real call to an already-listening
   * live view's own /api/version. */
  fetchLiveViewVersion?: (port: number) => Promise<string | null>;
  /** Test-only seam replacing the real "what commit is this copy of
   * fabrica running as" lookup (doctor-command.ts's runningCopyCommit
   * over this checkout). */
  getRunningCommit?: () => string | null;
  /** Test-only seam replacing the real pid-file-or-command-line lookup
   * (live-view-process.ts's findLiveViewProcess) used before ever
   * stopping an already-listening live view. */
  findLiveViewProcess?: (recordHome: string) => { pid: number } | null;
  /** Test-only seam replacing the real SIGTERM
   * (live-view-process.ts's stopLiveViewProcess). */
  stopLiveViewProcess?: (pid: number) => void;
  /** How long to wait for the live view to actually start listening
   * before giving up and launching the harness anyway. */
  liveViewStartTimeoutMs?: number;
  /** Test-only: the skill/ directory scanned for a launch.ts, the same
   * seam verify-hook-command.ts's skillDir option provides. */
  skillDir?: string;
  /** Test-only: bypasses real harness discovery entirely, the same way
   * verify-hook-command.ts's harness option does. */
  launcher?: HarnessLauncher;
  /** Test-only: the HANDBOOK.md read for the appended system prompt. */
  handbookPath?: string;
  /** Test-only: the integrations/ directory scanned for a <name>/
   * up-hook.ts, the same seam skillDir provides for the harness
   * launcher. */
  integrationsDir?: string;
  /** Test-only: bypasses real up-hook discovery entirely, the same way
   * the launcher option does for the harness launcher. */
  upHooks?: UpIntegrationHook[];
  /** The environment every discovered up-hook is handed, for deciding
   * whether its own conditions are met. Defaults to this process's own
   * - overridable so a test can simulate running inside some other
   * tool's environment without actually needing to be run inside it. */
  env?: NodeJS.ProcessEnv;
}

/** Returns the process exit code - never throws. */
export async function runUpCommand(argv: string[], opts: RunUpCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));

  try {
    parseUpArgs(argv);
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const recordHome = opts.recordHome ?? resolveRecordHome();
  const cwd = opts.cwd ?? process.cwd();

  // Step 1: the same checks fabrica doctor runs, spending nothing.
  const doctorLines: string[] = [];
  const doctorExit = await runDoctorCommand([], {
    recordHome,
    probes: opts.doctorProbes,
    stdout: (line) => doctorLines.push(line),
    stderr: (line) => doctorLines.push(line),
  });
  if (doctorExit !== 0) {
    doctorLines.forEach((line) => stdout(line));
    stderr("fabrica up: doctor checks failed - fix the above, then try again.");
    return 1;
  }

  // Step 2: the live view - started detached, the same way fabrica do
  // backgrounds a task, unless one is already listening AND running
  // the same commit this copy of fabrica is. A live view running
  // older code (e.g. left over from before a merge) is stopped and
  // replaced rather than reused, exactly like a fresh start - see
  // src/cli/live-view-process.ts for why stopping it is never as
  // simple as "kill whatever holds the port."
  const port = opts.liveViewPort ?? LIVE_VIEW_PORT;
  const isListening = opts.isLiveViewListening ?? probePortListening;
  const startTimeoutMs = opts.liveViewStartTimeoutMs ?? 10_000;

  const startFreshLiveView = async () => {
    const startLiveView = opts.startLiveView ?? (() => spawnDetachedLiveView({ recordHome }));
    startLiveView({ recordHome, port });

    const started = await waitUntilListening(isListening, port, startTimeoutMs);
    if (started) {
      (opts.openBrowser ?? defaultOpenBrowser)(liveViewUrl(port));
      stdout(`Live view started - ${liveViewUrl(port)}`);
    } else {
      stderr(`fabrica up: the live view did not start listening on 127.0.0.1:${port} in time - continuing anyway.`);
      stdout(`Live view may still be starting - ${liveViewUrl(port)}`);
    }
  };

  if (await isListening("127.0.0.1", port)) {
    const fetchVersion = opts.fetchLiveViewVersion ?? defaultFetchLiveViewVersion;
    const getRunningCommit = opts.getRunningCommit ?? (() => runningCopyCommit(CHECKOUT));
    const remoteCommit = await fetchVersion(port);
    const ourCommit = getRunningCommit();
    const sameCommit = remoteCommit !== null && ourCommit !== null && remoteCommit === ourCommit;

    if (sameCommit) {
      stdout(`Live view already running - ${liveViewUrl(port)}`);
    } else {
      const findProcess = opts.findLiveViewProcess ?? locateLiveViewProcess;
      const found = findProcess(recordHome);
      if (!found) {
        stderr(
          `fabrica up: something is already listening on 127.0.0.1:${port}, but it doesn't look like the live view ` +
            `(no matching pid file or process found) - stop whatever that is yourself, then try again.`
        );
        return 1;
      }
      const stopProcess = opts.stopLiveViewProcess ?? terminateLiveViewProcess;
      stopProcess(found.pid);
      await waitUntilNotListening(isListening, port, startTimeoutMs);
      await startFreshLiveView();
    }
  } else {
    await startFreshLiveView();
  }

  // Step 2.5: any optional integration that wants to react to this
  // session starting - e.g. mirroring it into some other tool - the
  // same discovered-at-runtime, src/-never-names-it shape as the
  // harness launcher below. A hook that fails to load, or throws, never
  // stops the session from reaching the harness: it's best-effort,
  // same posture as the browser-open step above.
  const hookEnv = opts.env ?? process.env;
  const foundHooks = opts.upHooks
    ? { hooks: opts.upHooks, loadFailures: [] as { path: string; problem: string }[] }
    : await loadUpIntegrationHooks(opts.integrationsDir ?? INTEGRATIONS_DIR);
  for (const failure of foundHooks.loadFailures) stderr(`${failure.path} ${failure.problem}`);
  for (const hook of foundHooks.hooks) {
    try {
      await hook.maybeStart({ recordHome, env: hookEnv });
    } catch (err) {
      stderr(`fabrica up: an integration hook failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 3: the harness itself, in the foreground.
  const found = await loadHarnessLauncher(opts.skillDir ?? SKILL_DIR);
  for (const failure of found.loadFailures) stderr(`${failure.path} ${failure.problem}`);
  const launcher = opts.launcher ?? found.launcher;
  if (!launcher) {
    stderr("No usable per-harness launch script found under skill/ - nothing to run.");
    return 1;
  }
  const settingsPath = found.harnessDir ? join(found.harnessDir, "settings.json") : null;
  if (!settingsPath || !existsSync(settingsPath)) {
    stderr(`fabrica up: no settings.json found for this harness${found.harnessDir ? ` (looked in ${found.harnessDir})` : ""}.`);
    return 1;
  }

  let available: boolean;
  try {
    available = launcher.harnessAvailable();
  } catch (err) {
    stderr(`Checking for your chat agent failed: ${err instanceof Error ? err.message : String(err)}`);
    available = false;
  }
  if (!available) {
    stderr("Could not find or run your chat agent - is it installed and on your PATH?");
    return 1;
  }

  const appendSystemPrompt = readFileSync(opts.handbookPath ?? HANDBOOK_PATH, "utf8");
  const { exitCode } = await launcher.launch({ cwd, settingsPath, appendSystemPrompt });

  stdout(`Live view is still running at ${liveViewUrl(port)} - stop it with: pkill -f "live-view/start.ts"`);
  return exitCode;
}
