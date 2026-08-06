// Detects an undeclared change to the project's checks (CONTRACT rule 9:
// "It can't grade its own homework in the dark"). v1's one protected path
// is check.sh itself, and only when do() is using it as the check command
// (DEFAULT_CHECK_COMMAND) — the one file a worker could silently rewrite
// to fake a green gate. A registered project with a custom check command
// isn't covered yet; see README.md "Known v1 limitations."

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function checkScriptPath(workdir: string): string {
  return join(workdir, "check.sh");
}

/** The check script's content at the moment the ProductionLine was cut,
 * before any worker has touched it — the gate's honest before-state. */
export function snapshotGate(workdir: string): string {
  return readFileSync(checkScriptPath(workdir), "utf8");
}

/** True if check.sh's content differs from `before` — regardless of
 * whether a brain declared the change. Deciding whether that's allowed is
 * the caller's job (rule 9): declared changes are fine, undeclared ones
 * force the discarded-protected-path outcome, "no matter how good the
 * result looks" — recorded honestly, work kept on the branch; the merge
 * is blocked by CI, not here (README.md "Rule 9: blocked by CI, not by
 * Fabrica's own mark"). */
export function gateWasTouched(workdir: string, before: string): boolean {
  if (!existsSync(checkScriptPath(workdir))) return true;
  return readFileSync(checkScriptPath(workdir), "utf8") !== before;
}
