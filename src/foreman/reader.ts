// The round's half of the code reader seam (src/reader/resolve.ts).
//
// WHERE THE REFUSAL LIVES, and why it is not here. The Client's ruling
// is "absent for a project: refuse at task start with the exact lines
// to add" - and task start is `fabrica do`, which is where every real
// task begins and where `src/cli/do-command.ts` refuses outright,
// before anything is registered and before any money is spent, exactly
// as it already does for a reviewer that cannot be settled.
//
// This function deliberately does NOT throw, which is the one place it
// differs from its sibling `requireReviewer`. A round that threw here
// would throw *after* its worker had already done the work and
// Inspector had already called it green - destroying a finished, green
// delivery over a configuration problem. That is worse than the thing
// the ruling protects against, and it contradicts the amendment's own
// standing answer about the reader: it never blocks. So an unsettleable
// reader comes back as a problem to report, and `reader-round.ts`
// records it as `reader-failed` at the moment the read was due - on the
// record, on the status row, on the delivery, and in `fabrica status`'s
// own count. Loud, and never a silent skip, without a green round being
// thrown away to say it.
//
// Deliberately not resolved once in `createForeman`, for the same
// reason the reviewer is not: that runs for `fabrica status`, `fabrica
// log`, the live view and every contract test, none of which read
// anything.

import { ConfigError, DEFAULT_PAUSE_RULE, loadConfig } from "../config/index.ts";
import type { FabricaConfig } from "../config/index.ts";
import { resolveReader } from "../reader/index.ts";
import type { ResolvedReader } from "../reader/index.ts";

/** Either the reader this round will hand its diff to once Inspector
 * turns it green, or the reason there isn't one - written for the
 * Client, since it is what the delivery will carry. */
export type RoundReader = { reader: ResolvedReader } | { problem: string };

export function readerForRound(recordHome: string, projectPath: string): RoundReader {
  const resolution = resolveReader({
    recordHome,
    config: configOrDefault(recordHome),
    projectPath,
    env: process.env,
  });
  return resolution.kind === "refused" ? { problem: resolution.message } : { reader: resolution.reader };
}

/** A record home with no projects.toml has no reader and no projects -
 * which `resolveReader` then reports, naming the file to create. Not an
 * error here, the same way `resolveCheckCommand` treats it. */
function configOrDefault(recordHome: string): FabricaConfig {
  try {
    return loadConfig(recordHome);
  } catch (err) {
    if (err instanceof ConfigError && err.code === "not-found") {
      return { caps: {}, pause: { ...DEFAULT_PAUSE_RULE }, projects: {} };
    }
    throw err;
  }
}
