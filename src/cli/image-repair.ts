// `fabrica up` and `fabrica doctor --fix` put the two images a task
// needs onto this machine themselves, instead of printing a `docker`
// command for the Client to copy and run (Client ruling 2026-10-30).
// Plain `fabrica doctor` is deliberately not in that list: it stays the
// read-only preflight it has always been, and its FAIL lines keep
// naming the exact command, which is now also the exact command this
// runs.
//
// Nothing here decides *whether* an image needs replacing. The pins and
// the checks that read them are untouched: the worker image's
// Dockerfile stamp (src/brain/adapters/doctor-checks.ts) and the relay
// image's digest (src/relay/container/doctor-check.ts) are still the
// only answer to "is this current", and this module only ever runs the
// command the failing check itself printed, then asks that same check
// again. So a repair can never claim an image is current for a reason
// doctor would not also give.
//
// Why only those two: they are the two images every task needs on the
// machine before it can start, and each has exactly one command that
// supplies it. The "worker CLI" line is deliberately NOT a trigger -
// its fix is the same build, but a mismatch there means the image was
// built from this very Dockerfile and still has a different version
// inside, which a (layer-cached) rebuild cannot change. Triggering on
// it would cost `fabrica up` a multi-minute build and still block. It
// is re-asked after a build that happened for another reason, since the
// image under it moved.

import { spawn } from "node:child_process";
import {
  relayImagePull,
  RELAY_IMAGE_LABEL,
  workerImageBuild,
  WORKER_CLI_LABEL,
  WORKER_IMAGE_LABEL,
  type ImageCommand,
} from "../index.ts";
import { DOCKER_LABEL } from "./docker-daemon.ts";
// Types only, erased at compile time: this module is imported BY
// doctor-command.ts, so it must never depend on anything of
// doctor-command.ts's at runtime.
import type { DoctorCheck, DoctorProbes } from "./doctor-command.ts";

export type { ImageCommand };

/** What one repair did, for the caller to report or assert on. `ok`
 * false carries the command's own last word in `detail` - never this
 * module's guess at what went wrong. */
export interface ImageRepairOutcome {
  /** The doctor label this repaired - the label of the check that asked
   * for it, and of the check re-asked afterwards. */
  label: string;
  image: string;
  /** Past tense, as reported: what the command does to the image. */
  action: "built" | "pulled";
  ok: boolean;
  /** Empty when it worked. */
  detail: string;
}

/** Runs one image command, resolving rather than throwing - a failed
 * build is a reported outcome, not an exception the caller has to
 * catch. Every line the command writes (stdout or stderr - docker's own
 * build progress goes to stderr) is handed to `onOutput` the moment its
 * newline lands: a build takes minutes, and a terminal that says
 * nothing for minutes is indistinguishable from a hang. */
export function runImageCommand(
  cmd: ImageCommand,
  onOutput: (line: string) => void
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd.command, cmd.args, { cwd: cmd.cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, detail: err instanceof Error ? err.message : String(err) });
      return;
    }

    // The last line that said anything, kept so a failure can be
    // reported in the command's own words. Only the last one: docker's
    // own final line is the error, and a doctor/up outcome line is one
    // line.
    let lastSaid = "";
    const feed = (): ((chunk: string) => void) => {
      let pending = "";
      return (chunk: string) => {
        pending += chunk;
        for (;;) {
          const at = pending.indexOf("\n");
          if (at === -1) break;
          const line = pending.slice(0, at).replace(/\r$/, "");
          pending = pending.slice(at + 1);
          if (line.trim() !== "") lastSaid = line;
          onOutput(line);
        }
      };
    };
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", feed());
    }

    child.once("error", (err) => resolve({ ok: false, detail: err.message }));
    child.once("close", (code) =>
      resolve(
        code === 0
          ? { ok: true, detail: "" }
          : { ok: false, detail: lastSaid || `${cmd.command} ${cmd.args[0]} exited ${code}` }
      )
    );
  });
}

/** One image this run may have to supply: which doctor line asks for
 * it, what supplying it is called, and the command that does it. */
interface RepairPlan {
  label: string;
  action: ImageRepairOutcome["action"];
  /** Present continuous, for the line printed before the command runs. */
  doing: string;
  /** Resolved only for a plan that is actually wanted - the worker
   * build's own argv embeds a fresh hash of the Dockerfile, which there
   * is no reason to read when the relay image is the only thing
   * missing. */
  command: () => ImageCommand;
  /** Which doctor lines are re-asked once this command has run - its
   * own, plus any other line that reads the image it just replaced. */
  reprobe: string[];
}

const PLANS: RepairPlan[] = [
  {
    label: WORKER_IMAGE_LABEL,
    action: "built",
    doing: "building it now - this takes a few minutes",
    command: workerImageBuild,
    // The CLI line reads what is installed inside the very image this
    // just replaced, so its previous answer is about an image that no
    // longer exists.
    reprobe: [WORKER_IMAGE_LABEL, WORKER_CLI_LABEL],
  },
  {
    label: RELAY_IMAGE_LABEL,
    action: "pulled",
    doing: "pulling it now",
    command: relayImagePull,
    reprobe: [RELAY_IMAGE_LABEL],
  },
];

export interface RepairImagesOptions {
  /** Every check `collectDoctorChecks` has produced so far. Read, not
   * re-derived: the decision to repair is the failing check's own, so
   * there is no second probe here to disagree with it. */
  checks: DoctorCheck[];
  /** Re-asked after a repair - the same probes that produced `checks`,
   * so the line printed afterwards is the line doctor would print. */
  probes: DoctorProbes;
  /** Test-only seam replacing the real `docker` spawn. */
  runImageCommand?: (cmd: ImageCommand, onOutput: (line: string) => void) => Promise<{ ok: boolean; detail: string }>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface RepairImagesResult {
  /** `checks` with every re-asked check replaced in place, so the
   * report the caller prints describes the machine as it is now. The
   * same array contents when nothing was repaired. */
  checks: DoctorCheck[];
  /** One entry per command actually run, in the order they ran. Empty
   * when there was nothing to do. */
  outcomes: ImageRepairOutcome[];
}

/**
 * Builds the worker image and pulls the relay image, each only when its
 * own doctor check says it is missing or out of date, and reports what
 * it did. A command that fails is an outcome with `ok` false carrying
 * the command's own last word, never a thrown error, and the re-asked
 * check still FAILs with its own fix exactly as it would have without
 * this step - so a caller reads the same `DoctorCheck[]` either way and
 * needs no error handling of its own.
 */
export async function repairImages(opts: RepairImagesOptions): Promise<RepairImagesResult> {
  const stdout = opts.stdout ?? (() => {});
  const stderr = opts.stderr ?? (() => {});
  const run = opts.runImageCommand ?? runImageCommand;
  const failing = (label: string): DoctorCheck | undefined =>
    opts.checks.find((check) => check.label === label && !check.ok);

  // No daemon, nothing to build or pull with - and doctor's own docker
  // line already carries the one fix for that, so adding a second
  // failure saying the same thing in docker's words would only bury it.
  if (failing(DOCKER_LABEL)) return { checks: opts.checks, outcomes: [] };

  const wanted = PLANS.map((plan) => ({ plan, asked: failing(plan.label) })).filter(
    (candidate): candidate is { plan: RepairPlan; asked: DoctorCheck } => candidate.asked !== undefined
  );
  if (wanted.length === 0) return { checks: opts.checks, outcomes: [] };

  const outcomes: ImageRepairOutcome[] = [];
  const refreshed = new Map<string, DoctorCheck>();
  for (const { plan, asked } of wanted) {
    const command = plan.command();
    // What was wrong, in the check's own words, then the exact command
    // about to run - so a Client reading the terminal sees the same two
    // facts `fabrica doctor` would have printed, and is never left
    // guessing what is taking minutes.
    stdout(`${plan.label}: ${asked.detail} - ${plan.doing}.`);
    stdout(`  $ ${command.shell}`);
    const result = await run(command, (line) => stdout(`  ${line}`));
    outcomes.push({ label: plan.label, image: command.image, action: plan.action, ok: result.ok, detail: result.detail });
    if (result.ok) stdout(`${plan.label}: ${plan.action} ${command.image}.`);
    else stderr(`${plan.label}: could not be ${plan.action} - ${result.detail}`);
    // Re-asked whether it worked or not: a failed build leaves the same
    // FAIL in place, which is the honest line, and a build that
    // succeeded but somehow left the image unfit must say so rather
    // than be taken on this module's word.
    for (const label of plan.reprobe) {
      const fresh = reprobe(label, opts.probes);
      if (fresh) refreshed.set(label, fresh);
    }
  }

  return { checks: opts.checks.map((check) => refreshed.get(check.label) ?? check), outcomes };
}

/** The one probe behind a given doctor label, re-asked. Null for a
 * label nothing here knows how to re-ask, which cannot happen for the
 * three above and would leave the original check in place if it did. */
function reprobe(label: string, probes: DoctorProbes): DoctorCheck | null {
  if (label === WORKER_IMAGE_LABEL) return probes.workerImage();
  if (label === WORKER_CLI_LABEL) return probes.workerCli();
  if (label === RELAY_IMAGE_LABEL) return probes.relayImage();
  return null;
}
