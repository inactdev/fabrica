// Putting a project's machine image on this machine, at the two moments
// nothing else does it: the start of a task, and `fabrica update` -
// issue #322's amendment, requirements 3 and 4.
//
// `fabrica doctor --fix` and `fabrica up` already build these, through
// image-repair.ts, off the per-project doctor line's own answer. That
// covers the Client sitting down to work. It does not cover the two
// cases the amendment names:
//
//   - **A task starting.** Issue #322's first attempt merged with every
//     project needing an image that could not be built, and a task on
//     such a project would have found out somewhere inside a round.
//     `requireMachineImage` is what turns that into a refusal before
//     anything is registered, in the build's own words. A project whose
//     image is already current costs one `docker image inspect` here;
//     one that needs building pays for the build once, and the next task
//     on that project pays nothing.
//   - **Code landing.** A merge that moves Fabrica's own layer makes
//     every project's image stale at once, so `fabrica update` builds
//     them all (`buildRegisteredMachineImages`) rather than leaving the
//     first task on each project to discover it.
//
// Two rules both of those obey:
//
//   - **One project's trouble is only that project's.** A build that
//     fails is reported against the project it belongs to and never
//     stops another from being built or started. `fabrica update` keeps
//     going and still succeeds; a task refuses on its own project only.
//   - **The decision is never made twice.** Whether an image needs
//     building is `machineImageCurrency`'s answer - the same one
//     `fabrica doctor`'s per-project line prints - never a second
//     opinion formed here.

import {
  BuildSecretsError,
  isLayered,
  loadConfigOrProblem,
  machineImageBuild,
  machineImageCurrency,
  machineImageFor,
  machineImageForProject,
  machineImageForTask,
  needsBuilding,
  type BaseUserProbe,
  type MachineImage,
} from "../index.ts";
import { runImageCommand, type ImageCommand } from "./image-repair.ts";

/** The seams a caller replaces to keep a test off the real daemon - the
 * same shape `DoctorProbes` has, and for the same reason. */
export interface MachineImageIo {
  /** The Dockerfile stamp an image carries, or null when there is no
   * such image. */
  stamp?: (image: string) => string | null;
  /** What an image's own configuration says it runs as - reached only
   * for a project whose `Dockerfile.inspector` names no final `USER`,
   * and then the answer the generated image has to end on. */
  baseUser?: BaseUserProbe;
  /** Runs one `docker build`, reporting rather than throwing. */
  run?: (cmd: ImageCommand, onOutput: (line: string) => void) => Promise<{ ok: boolean; detail: string }>;
  /** Where a build's own output goes while it runs. A build takes
   * minutes, and a terminal that says nothing for minutes is
   * indistinguishable from a hang. */
  onOutput?: (line: string) => void;
  /** Said once, before a build starts, so whoever is waiting knows what
   * for. Not called at all when the image is already current, which is
   * the ordinary case. */
  onBuilding?: (machine: MachineImage, command: ImageCommand) => void;
}

/** What `ensureMachineImage` did. `image` is always the image the
 * machine should work in, even when the build failed - the caller
 * decides whether to use it or refuse. */
export interface EnsureMachineImageResult {
  machine: MachineImage;
  image: string;
  /** False only for a build that ran and failed, or a Dockerfile that
   * cannot be read. A project on the shared image, or one whose image is
   * already current, is `true` with `built` false. */
  ok: boolean;
  built: boolean;
  /** Empty when `ok`. The build's own last word, never this module's
   * guess at what went wrong. */
  detail: string;
}

/**
 * Makes sure the image this project's machine works in is on this
 * machine, building it if it is missing or stale, and says what
 * happened.
 *
 * Never throws for a build that fails: a failed build is a reported
 * outcome with docker's own last line in `detail`, exactly as
 * `repairImages` treats one.
 */
export async function ensureMachineImage(
  recordHome: string,
  machine: MachineImage,
  io: MachineImageIo = {}
): Promise<EnsureMachineImageResult> {
  const base = { machine, image: machine.image };
  if (!isLayered(machine)) return { ...base, ok: true, built: false, detail: "" };

  const currency = machineImageCurrency(machine, io.stamp, io.baseUser);
  if (currency.state === "unreadable") return { ...base, ok: false, built: false, detail: unreadable(machine, currency.message) };
  if (!needsBuilding(currency)) return { ...base, ok: true, built: false, detail: "" };

  const run = io.run ?? runImageCommand;
  const onOutput = io.onOutput ?? (() => {});
  let command: ImageCommand;
  try {
    // Writing the generated Dockerfile is part of building it, so this
    // is the first point anything is written - the same arrangement that
    // keeps plain `fabrica doctor` read-only.
    command = machineImageBuild(recordHome, machine, io.baseUser);
  } catch (err) {
    // Issue #342: a build whose credential cannot be supplied refuses
    // here, in its own words - it is a different fault from an
    // unreadable Dockerfile, with a different fix (a line in brain.env,
    // not a restored file), and wrapping it in the sentence below would
    // send the Client looking at the wrong thing.
    if (err instanceof BuildSecretsError) {
      return { ...base, ok: false, built: false, detail: `${err.message} Fix: ${err.fix}.` };
    }
    // Composing the generated Dockerfile is the only thing that reads
    // the project's own file, so this is the same failure the
    // `"unreadable"` state above names - reached instead of it whenever
    // there is no existing image to have asked about first. Said the
    // same way either way.
    return { ...base, ok: false, built: false, detail: unreadable(machine, err instanceof Error ? err.message : String(err)) };
  }
  io.onBuilding?.(machine, command);
  const result = await run(command, onOutput);
  return { ...base, ok: result.ok, built: result.ok, detail: result.detail };
}

/** One wording for the one failure that is not docker's: the project's
 * own `Dockerfile.inspector` could not be read, so there is nothing to
 * build an image from. */
function unreadable(machine: MachineImage, message: string): string {
  return `${machine.inspectorDockerfile} cannot be read: ${message}`;
}

/** The message a task start refuses with. Names the project, the file
 * the image is built from, the build's own error and the one command
 * that would retry it - all four, because this is read by someone whose
 * task just would not start. */
export function machineImageRefusal(machine: MachineImage, detail: string): string {
  return (
    `${machine.project}'s machine image (${machine.image}, built from ${machine.inspectorDockerfile}) could not ` +
    `be built, so there is no box for this task to be written in: ${detail}. Nothing was started and no attempt ` +
    `was spent. Fix that file, or Fabrica's own layer, and try again - \`fabrica doctor\` reports this project's ` +
    `image, and \`fabrica doctor --fix\` builds it.`
  );
}

/**
 * The image a task on this project must work in, built if need be, or a
 * thrown refusal carrying the build's own error.
 *
 * Throws rather than returns, because every caller is a place where
 * there is nothing useful to do with a failure except stop: the
 * foreground of `fabrica do`, where it becomes the refusal the Client
 * reads, and each detached round's own entry point, where it becomes the
 * reason on the record.
 */
export async function requireMachineImage(recordHome: string, projectPath: string, io: MachineImageIo = {}): Promise<string> {
  return use(await ensureMachineImage(recordHome, machineImageForProject(recordHome, projectPath), io));
}

/** The same, for a round that knows only the task - a resumed round
 * after `fabrica answer`, a fix round after a `fix` verdict. Undefined
 * for a task whose record names no project yet, which is a task that
 * failed before its first round: there is no project to ask about, and
 * the adapter's own default image stands. */
export async function requireMachineImageForTask(
  recordHome: string,
  taskId: string,
  io: MachineImageIo = {}
): Promise<string | undefined> {
  const machine = machineImageForTask(recordHome, taskId);
  return machine === null ? undefined : use(await ensureMachineImage(recordHome, machine, io));
}

function use(result: EnsureMachineImageResult): string {
  if (!result.ok) throw new Error(machineImageRefusal(result.machine, result.detail));
  return result.image;
}

/** What one project's build came to, for `fabrica update`'s report. */
export interface MachineImageBuildReport {
  /** The project's name in projects.toml - what the Client calls it. */
  name: string;
  image: string;
  /** "built", "already current", "on the shared image", or the failure. */
  outcome: "built" | "current" | "shared" | "failed";
  detail: string;
}

/**
 * Builds every registered project's machine image that needs it -
 * requirement 3 of issue #322's amendment, run by `fabrica update` after
 * new code has landed.
 *
 * Why here and not through `repairImages`: that path starts from a full
 * `collectDoctorChecks` run, which asks GitHub about every project's app
 * installation and token. `fabrica update` has one question, and asking
 * it needs no network.
 *
 * A project whose build fails is one entry with `outcome: "failed"` and
 * docker's own last line; the loop carries on to the next project, and
 * the caller reports rather than aborts. A registry that will not parse
 * yields no entries - its own FAIL line is `fabrica doctor`'s to print.
 */
export async function buildRegisteredMachineImages(
  recordHome: string,
  io: MachineImageIo = {}
): Promise<MachineImageBuildReport[]> {
  const { config, problem } = loadConfigOrProblem(recordHome);
  if (problem) return [];

  const reports: MachineImageBuildReport[] = [];
  for (const [name, project] of Object.entries(config.projects)) {
    const machine = machineImageFor(config, project.path);
    if (!isLayered(machine)) {
      reports.push({ name, image: machine.image, outcome: "shared", detail: "" });
      continue;
    }
    const result = await ensureMachineImage(recordHome, machine, io);
    reports.push({
      name,
      image: machine.image,
      outcome: result.ok ? (result.built ? "built" : "current") : "failed",
      detail: result.detail,
    });
  }
  return reports;
}
