// The round's half of the reviewer seam (src/reviewer/resolve.ts).
//
// `fabrica do` already refuses a project whose reviewer cannot be
// settled, before anything is registered and before any money is spent.
// This is the same question asked again at the one moment that actually
// matters - just before a round hands work to Inspector - so a resumed
// round, a fix round, and a library caller that never went through the
// CLI all refuse on exactly the same three grounds rather than handing
// Inspector a configuration that cannot work.
//
// Deliberately not resolved once in `createForeman`: that runs for
// `fabrica status`, `fabrica log`, the live view and every contract
// test, none of which call Inspector, and a half-configured reviewer
// has no business breaking them. Resolved here from `recordHome` plus
// the project's path - the same two values `resolveCheckCommand`
// already finds a project's own settings from.

import { ConfigError, DEFAULT_PAUSE_RULE, loadConfig } from "../config/index.ts";
import type { FabricaConfig } from "../config/index.ts";
import { declaresTestPaths } from "../inspector/index.ts";
import { resolveReviewer } from "../reviewer/index.ts";
import type { ResolvedReviewer } from "../reviewer/index.ts";
import { ForemanError } from "./errors.ts";

/** The reviewer this round should hand Inspector, or undefined when
 * none is configured and none is required. Throws
 * ForemanError("reviewer-not-ready"), with the message written for the
 * Client verbatim, when one is required and cannot be settled.
 *
 * `baseCommit` is what `.inspector.json` is read at: the commit the
 * task was cut from, never the worktree a Worker has already had its
 * hands on - a Worker must not be able to add or drop `testPaths` and
 * change who reviews its own work. */
export function requireReviewer(
  recordHome: string,
  workdir: string,
  projectPath: string,
  baseCommit: string
): ResolvedReviewer | undefined {
  const resolution = resolveReviewer({
    recordHome,
    config: configOrDefault(recordHome),
    projectPath,
    declaresTestPaths: declaresTestPaths(workdir, baseCommit),
    env: process.env,
  });
  if (resolution.kind === "refused") throw new ForemanError("reviewer-not-ready", resolution.message);
  return resolution.kind === "reviewer" ? resolution.reviewer : undefined;
}

/** A record home with no projects.toml has no reviewer and no projects -
 * not an error, the same way resolveCheckCommand treats it. */
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
