// Which image one project's machine works in (issue #322).
//
// Every machine used to run in one shared image, carrying a Node, the
// worker CLI and a Go toolchain. A project's own toolchain lives
// somewhere else entirely - in `Dockerfile.inspector`, the file Inspector
// builds its check box from - so a machine on, say, a Ruby project had no
// way to run the tests covering what it had just touched, and worked
// blind until Inspector judged it afterwards. inspector#47's stated
// intent was the opposite: one image is the base of both the box the work
// is written in and the box it is judged in.
//
// So: a project carrying a `Dockerfile.inspector` gets its own image,
// built from that file plus Fabrica's own layer (the worker CLI and the
// Node it runs on - src/brain/adapters/machine-layer.ts, which is where
// anything naming that CLI has to live). A project carrying none keeps
// the shared image, exactly as before.
//
// This module answers which image, and whether the one on this machine
// is current, and nothing else. It decides nothing and builds nothing:
// `fabrica doctor` turns the answer into a line per project,
// `src/cli/image-repair.ts` turns it into the build `--fix` and `fabrica
// up` run, and the round itself turns it into the image its worker and
// its self-test box start from. One answer with several readers, the
// same shape `src/workmode/` and `src/projecttoken/` have, and for the
// same reason: what the Client is told up front and what a round
// actually does must never be two different answers.
//
// Deliberately NOT here:
//
//   - **Any spawning of a build.** This hands back a command
//     (`ImageCommand`, the shape the two existing image checks already
//     use); the CLI layer runs it, reports it, and re-asks this module
//     afterwards.
//   - **Writing anything, outside `machineImageBuild`.** Plain `fabrica
//     doctor` is read-only (Client ruling 2026-10-30), and the generated
//     Dockerfile is written only by the step that is about to build it.
//   - **Any opinion about Inspector.** Fabrica reads the same source file
//     Inspector builds from; nothing here changes what Inspector does,
//     and nothing here depends on Inspector having run.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  DEFAULT_MACHINE_IMAGE,
  installedCliVersionIn,
  machineDockerfile,
  MACHINE_STAMP_ARG,
  pinnedCliVersion,
  readImageStamp,
  type ImageCommand,
} from "../brain/index.ts";
import { loadConfigOrProblem } from "../config/index.ts";
import type { FabricaConfig } from "../config/index.ts";
import { INSPECTOR_DOCKERFILE } from "../inspector/index.ts";
import { readEventsForTask } from "../record/index.ts";
import type { FabricaEvent } from "../record/index.ts";
import { workModeFor } from "../workmode/index.ts";

/** Every per-project image's tag starts with this, so one glance at
 * `docker image ls` says which images on this machine are Fabrica's
 * per-project ones. */
export const MACHINE_IMAGE_PREFIX = "fabrica-machine-";

/** How much of a project's folder name rides in its tag. The hash below
 * it is what actually identifies the project; this is only there so the
 * tag is readable. */
const SLUG_MAX_LENGTH = 40;

/** The doctor label one project's machine-image line carries - spelled
 * here, not at each reader, so the line `fabrica doctor` prints and the
 * line `--fix` looks for among all of doctor's can never be two
 * different strings (the same reasoning `WORKER_IMAGE_LABEL` exists
 * for). It sits right after that project's own line, so it reads as
 * part of it. */
export function machineImageLabel(projectName: string): string {
  return `project ${projectName} image`;
}

/**
 * Which image one project's machine works in.
 *
 * `inspectorDockerfile` is the file the image is layered on top of -
 * null for a project that has none, and then `image` is the shared one
 * and there is nothing per-project to build, check or rebuild.
 */
export interface MachineImage {
  /** The project this is about, as resolved on disk. */
  project: string;
  /** The image the machine's box and its self-test box both start from. */
  image: string;
  /** The project's own `Dockerfile.inspector`, or null when it has none.
   * For a work-mode project (issue #316) this is the copy in its terms
   * folder, since the repository is one nothing of ours may be added to
   * and carries no such file by design. */
  inspectorDockerfile: string | null;
  /** The `docker build` context. The repository, even when the
   * Dockerfile itself lives outside it: the `COPY` lines in the shape
   * `fabrica register` writes (`package.json`, `package-lock.json`,
   * `go.mod`) name paths in the repository, not in the terms folder. */
  context: string;
}

/** True when this project has an image of its own to build and keep
 * current - the one question every reader here asks first. */
export function isLayered(machine: MachineImage): boolean {
  return machine.inspectorDockerfile !== null;
}

/** The tag one project's machine image is built under. Derived from the
 * project's resolved path, not from its name in projects.toml: a round
 * knows the path it is working on long before (and sometimes without)
 * knowing which registry entry names it, and two registrations of the
 * same path must not produce two images. The folder name rides along
 * unhashed so the tag is readable; the hash is what makes two projects
 * whose folders are both called "api" two different images. */
export function machineImageTag(projectPath: string): string {
  const resolved = realpath(projectPath);
  const slug =
    basename(resolved)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_MAX_LENGTH)
      .replace(/-+$/, "") || "project";
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return `${MACHINE_IMAGE_PREFIX}${slug}-${hash}:latest`;
}

/**
 * Which image this project's machine uses, read off a config the caller
 * already holds.
 *
 * A project whose terms live outside its repository is asked about that
 * folder instead of about the repository, the same way `fabrica
 * doctor`'s own project line and the round's own start gate are - the
 * repository has no `Dockerfile.inspector` by design, and reading it
 * there would put every work-mode project back on the shared image
 * without saying so.
 */
export function machineImageFor(config: FabricaConfig, projectPath: string): MachineImage {
  const project = realpath(projectPath);
  const termsDir = workModeFor(config, project).terms;
  const candidate = join(termsDir ?? project, INSPECTOR_DOCKERFILE);
  const layered = existsSync(candidate);
  return {
    project,
    image: layered ? machineImageTag(project) : DEFAULT_MACHINE_IMAGE,
    inspectorDockerfile: layered ? candidate : null,
    context: project,
  };
}

/**
 * The same answer for a caller that holds only the record home - every
 * round, and `fabrica doctor`'s repair step.
 *
 * A record home with no projects.toml, or one that will not parse, reads
 * as "no work mode", exactly as `resolveModelChoice` treats it: the
 * commands that could act on a broken config file refuse on it long
 * before here (`fabrica do`), and a project's repository-level
 * `Dockerfile.inspector` is still found without any registry at all.
 */
export function machineImageForProject(recordHome: string, projectPath: string): MachineImage {
  const { config } = loadConfigOrProblem(recordHome);
  return machineImageFor(config, projectPath);
}

/**
 * The image a task's own rounds use, for a caller that holds only the
 * record home and a task id - a resumed round after `fabrica answer`, a
 * fix round after a `fix` verdict, both of which run in a fresh process
 * and re-derive everything they need from the record.
 *
 * Null when the record names no project for this task, which is a task
 * that failed before its first round ever started. The project comes
 * from whichever event last carried it - the same rule `fabrica status`,
 * the live view and the quiz re-check all read a task's project with.
 */
export function machineImageForTask(recordHome: string, taskId: string): MachineImage | null {
  const project = projectOf(readEventsForTask(recordHome, taskId));
  return project === null ? null : machineImageForProject(recordHome, project);
}

function projectOf(events: FabricaEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const details = events[i].details as { project?: string } | undefined;
    if (details?.project) return details.project;
  }
  return null;
}

/** The generated Dockerfile for a layered project: its own
 * `Dockerfile.inspector` verbatim, then Fabrica's layer. Throws for a
 * project with no such file - a caller has to have asked `isLayered`
 * first, since there is no such thing as "the generated Dockerfile" for
 * a project on the shared image. */
export function machineDockerfileFor(machine: MachineImage): string {
  const source = machine.inspectorDockerfile;
  if (source === null) {
    throw new Error(`${machine.project} has no ${INSPECTOR_DOCKERFILE}, so it has no machine image of its own to build.`);
  }
  return machineDockerfile({ inspectorDockerfile: readFileSync(source, "utf8"), source });
}

/** The stamp an image built from `text` carries: the hash of the whole
 * generated Dockerfile, which holds the project's own file and Fabrica's
 * layer (both version pins included). So it moves when either input
 * moves, and only then. */
export function machineImageStamp(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Where a project's generated Dockerfile is written before it is built.
 * Under the record home rather than in the project: nothing Fabrica
 * generates belongs in the Client's repository, and this file is an
 * input to a build, not something to commit. */
export function machineDockerfilePath(recordHome: string, machine: MachineImage): string {
  return join(recordHome, "images", `${machine.image.replace(/[:/]/g, "-")}.Dockerfile`);
}

/**
 * The one command that puts a project's machine image on this machine -
 * the same `ImageCommand` shape the shared worker image and the relay
 * image already hand back, so `src/cli/image-repair.ts` runs, prints and
 * reports all three identically.
 *
 * Writing the generated Dockerfile is part of building it, and happens
 * here: this function is only ever called for a build that is actually
 * about to run (the plan's own `command()`, resolved on demand), which is
 * what keeps plain `fabrica doctor` read-only.
 */
export function machineImageBuild(recordHome: string, machine: MachineImage): ImageCommand {
  const text = machineDockerfileFor(machine);
  const path = machineDockerfilePath(recordHome, machine);
  mkdirSync(join(recordHome, "images"), { recursive: true });
  writeFileSync(path, text);
  const args = [
    "build",
    "--build-arg",
    `${MACHINE_STAMP_ARG}=${machineImageStamp(text)}`,
    "-t",
    machine.image,
    "-f",
    path,
    machine.context,
  ];
  return {
    command: "docker",
    args,
    image: machine.image,
    shell: `docker ${args.join(" ")}`,
  };
}

/** One project's machine-image line, plus the one fact the repair step
 * needs that a line cannot carry: whether building is what would fix it.
 *
 * `needsBuild` is false for a CLI version that disagrees with the pin
 * inside an otherwise current image, for the same reason the shared
 * image's "worker CLI" line is not a repair trigger: the image was built
 * from this very Dockerfile and still has a different version inside, so
 * a (layer-cached) rebuild cannot change it, and triggering on it would
 * cost `fabrica up` a multi-minute build and still block. */
export interface MachineImageCheck {
  ok: boolean;
  label: string;
  detail: string;
  fix?: string;
  needsBuild: boolean;
}

/** What doctor's fix line says for an image that has to be built. Not a
 * `docker build` command, which is what the other two images print:
 * there is no generated Dockerfile for such a command to point at until
 * the build itself writes one, and plain doctor must not write it. */
const BUILD_FIX = "fabrica doctor --fix (or fabrica up), which generates the Dockerfile and builds it";

/**
 * Whether the image this project's machine uses is on this machine and
 * current, as one doctor line.
 *
 * The CLI version inside it is part of the same line (the issue's own
 * clarification: the worker CLI version check applies to every
 * per-project image), read from the CLI itself inside that image and
 * compared against the one pin - never inferred from the fact that a
 * build succeeded. It is only asked once the image is known current,
 * because starting a container from a stale or missing image to ask it a
 * question would answer about an image that is being replaced.
 */
export function machineImageStatus(
  label: string,
  machine: MachineImage,
  probes: {
    stamp?: (image: string) => string | null;
    installedCli?: (image: string) => string | null;
    pinnedCli?: () => string | null;
  } = {}
): MachineImageCheck {
  const stamp = probes.stamp ?? readImageStamp;
  const installedCli = probes.installedCli ?? installedCliVersionIn;
  const pinnedCli = probes.pinnedCli ?? (() => pinnedCliVersion());

  if (!isLayered(machine)) {
    return {
      ok: true,
      label,
      detail: `${machine.image} - the shared image, since this project commits no ${INSPECTOR_DOCKERFILE}`,
      needsBuild: false,
    };
  }

  const from = `${machine.image}, built from ${machine.inspectorDockerfile}`;
  const found = stamp(machine.image);
  if (found === null) return { ok: false, label, detail: `${from} - not built`, fix: BUILD_FIX, needsBuild: true };
  if (found === "") {
    return { ok: false, label, detail: `${from} - carries no Dockerfile stamp, so whether it is current is unknown`, fix: BUILD_FIX, needsBuild: true };
  }
  let wanted: string;
  try {
    wanted = machineImageStamp(machineDockerfileFor(machine));
  } catch (err) {
    // The project's own file became unreadable between the two reads
    // (deleted, or permissions). Reported as what it is rather than as
    // a stale image: a build would fail on the same thing.
    return {
      ok: false,
      label,
      detail: `${from} - its ${INSPECTOR_DOCKERFILE} cannot be read: ${err instanceof Error ? err.message : String(err)}`,
      fix: `restore ${machine.inspectorDockerfile}`,
      needsBuild: false,
    };
  }
  if (found !== wanted) {
    return {
      ok: false,
      label,
      detail: `${from} - out of date, since either that file or Fabrica's own layer changed after it was built`,
      fix: BUILD_FIX,
      needsBuild: true,
    };
  }

  const have = installedCli(machine.image);
  const want = pinnedCli();
  if (have !== null && want !== null && have !== want) {
    return {
      ok: false,
      label,
      detail: `${from} - built and current, but it has worker CLI ${have} installed where ${want} is pinned`,
      fix: BUILD_FIX,
      needsBuild: false,
    };
  }
  const cli =
    have === null
      ? "its worker CLI version could not be read"
      : want === null
        ? `worker CLI ${have} installed, no version pinned`
        : `worker CLI ${have}, the pinned version`;
  return { ok: true, label, detail: `${from} - built and current, ${cli}`, needsBuild: false };
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
