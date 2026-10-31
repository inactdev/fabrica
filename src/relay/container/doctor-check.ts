// `fabrica doctor`'s relay-side check (issue #186, second half): is the
// image the relay container runs from actually on this machine?
//
// It is a stock, digest-pinned Node image (launch.ts's RELAY_IMAGE) with
// nothing built on top - the relay runs straight from the bind-mounted
// checkout - so there is nothing to be out of date, only present or
// absent. Absent is a FAIL, not information: every real task starts a
// relay container before its worker runs, so a missing image means the
// first task of the day dies on `docker run`'s own pull error instead of
// on a preflight line naming the one command that fixes it (Client
// ruling, issue #186: a missing relay image fails doctor non-zero).

import { execFileSync } from "node:child_process";
import { RELAY_IMAGE } from "./launch.ts";

/** The same shape src/cli/doctor-command.ts's DoctorCheck has, declared
 * here rather than imported: a module under src/ has no business
 * depending on the CLI layer, and the two are structurally identical by
 * design (src/brain/adapters/doctor-checks.ts's AdapterCheck does the
 * same). */
export interface RelayCheck {
  ok: boolean;
  label: string;
  detail: string;
  fix?: string;
}

/** The doctor label this check reports under - exported for the same
 * reason src/brain/adapters/doctor-checks.ts exports its own two: the
 * repair step that puts this image on the machine
 * (src/cli/image-repair.ts) has to find this line among all of
 * doctor's, and must not do it with a second copy of the string. */
export const RELAY_IMAGE_LABEL = "relay image";

/** One command that puts an image on this machine - the structurally
 * identical shape src/brain/adapters/doctor-checks.ts declares for the
 * worker image, declared here rather than shared for the same reason
 * `RelayCheck` above is declared here rather than imported. */
export interface ImageCommand {
  command: string;
  args: string[];
  cwd?: string;
  image: string;
  shell: string;
}

/** The one definition of how the relay image gets onto this machine:
 * both the fix line below and the pull `fabrica up` / `fabrica doctor
 * --fix` now runs themselves come from here, so they can never be two
 * different commands.
 *
 * Pinned by digest, so the tag-less form is what this, `docker run` and
 * `docker pull` all name - and what makes `docker pull` the whole of
 * the fix: there is no version to choose and nothing to build. */
export function relayImagePull(): ImageCommand {
  return {
    command: "docker",
    args: ["pull", RELAY_IMAGE],
    image: RELAY_IMAGE,
    shell: `docker pull ${RELAY_IMAGE}`,
  };
}

/** True when the image is on this machine. `docker image inspect` only
 * ever looks locally - it never pulls - which is what makes this safe to
 * run in a preflight that promises to spend nothing. */
function imagePresent(image: string): boolean {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

export function relayImageStatus(present: (image: string) => boolean = imagePresent): RelayCheck {
  const label = RELAY_IMAGE_LABEL;
  return present(RELAY_IMAGE)
    ? { ok: true, label, detail: `${RELAY_IMAGE} is pulled` }
    : {
        ok: false,
        label,
        detail: `${RELAY_IMAGE} is not on this machine, so no task's relay can start`,
        // Still printed even now that `fabrica up` and `fabrica doctor
        // --fix` run it themselves: plain `fabrica doctor` stays
        // read-only (Client ruling 2026-10-30), so this line is the
        // only thing that tells the Client what would be done.
        fix: relayImagePull().shell,
      };
}
