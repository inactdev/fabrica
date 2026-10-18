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
  const label = "relay image";
  // Pinned by digest, so the tag-less form is what both this check and
  // `docker run` name; `docker pull <image>@sha256:...` is the exact
  // command that puts it there.
  return present(RELAY_IMAGE)
    ? { ok: true, label, detail: `${RELAY_IMAGE} is pulled` }
    : {
        ok: false,
        label,
        detail: `${RELAY_IMAGE} is not on this machine, so no task's relay can start`,
        fix: `docker pull ${RELAY_IMAGE}`,
      };
}
