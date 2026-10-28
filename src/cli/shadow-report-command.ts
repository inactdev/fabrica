// `fabrica shadow-report` (issue #204's amendment, Client ruling
// 2026-10-25): what the skip rules would have done, per project and per
// kind - would-close count, accepted, disagreed, days running.
//
// Read-only, like `fabrica status`: it reads the record and prints. There
// is no flag here that turns anything on, because there is nothing to
// turn on yet - shadow mode is the only mode built, nothing closes by
// rule, and the real path waits on the graduation proposal and on
// CONTRACT rule 6 being amended by the Client.

import { eventsByTask, formatShadowReport, shadowReport } from "../index.ts";
import { CliError } from "./errors.ts";
import { resolveRecordHome } from "./record-home.ts";

export const SHADOW_REPORT_USAGE = "fabrica shadow-report";

export const SHADOW_REPORT_HELP = `Usage: ${SHADOW_REPORT_USAGE}

What your projects' skip rules would have done, had they been allowed to
act. They are not: shadow mode is the only mode built, nothing closes or
merges by rule, and every task still waits on your verdict (CONTRACT
rule 6).

One block per project, one line per kind of change in its
\`.fabrica/skip-rules.toml\`:

  would-close   how many tasks that kind answered every condition safe on
  accepted      how many of those you then accepted - rule and you agreed
  disagreed     how many you ruled fix or wrong - the rule would have
                closed a task you did not accept, which is the number
                that says a kind is not ready
  running       how many days that kind has been recording

A rules file that could not be used is listed separately, with its own
reason - a \`mode = "live"\` that CONTRACT rule 6 does not yet permit, an
unknown condition, a file that will not parse. A project with no rules
file is simply absent: it never opted in, and nothing was evaluated or
recorded for it.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

export interface RunShadowReportCommandOptions {
  recordHome?: string;
  now?: number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Takes nothing, and refuses anything given rather than ignoring it -
 * the same shape `parseStatusArgs` uses, for the same reason: a silently
 * swallowed flag reads as one that was supported and did nothing. */
export function parseShadowReportArgs(argv: string[]): void {
  const [first] = argv;
  if (first === undefined) return;
  if (first.startsWith("-")) {
    throw new CliError("bad-usage", `fabrica shadow-report: unknown flag "${first}". Usage: ${SHADOW_REPORT_USAGE}`);
  }
  throw new CliError(
    "bad-usage",
    `fabrica shadow-report: unexpected argument "${first}" - shadow-report takes none. Usage: ${SHADOW_REPORT_USAGE}`
  );
}

/** Returns the process exit code - never throws. Always 0 when the
 * record could be read: a kind the Client disagreed with is a finding to
 * read, not a check that failed, exactly as `fabrica status` treats a
 * task whose worker is gone. */
export async function runShadowReportCommand(argv: string[], opts: RunShadowReportCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));

  try {
    parseShadowReportArgs(argv);
    const recordHome = opts.recordHome ?? resolveRecordHome();
    const report = shadowReport(eventsByTask(recordHome), opts.now ?? Date.now());
    for (const line of formatShadowReport(report)) stdout(line);
    return 0;
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
