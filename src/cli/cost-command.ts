// `fabrica cost <taskId> <usd>` (issue #11, Client ruling 2026-10-08):
// the owner records, by hand, the real cost of a task's unmeasured
// attempts. While a spending cap is set, an unmeasured cost blocks every
// new start (SPEND UNKNOWN - tasks blocked); this is the one way to
// clear it, and only with a real figure. Owner-only: a harness's session
// config denies it to an AI driver, next to verdict and answer.

import { createForeman, formatUsd } from "../index.ts";
import { CliError } from "./errors.ts";
import { resolveRecordHome } from "./record-home.ts";

export const COST_USAGE = "fabrica cost <taskId> <usd>";

export const COST_HELP = `Usage: ${COST_USAGE}

Records, by hand, the real cost of every attempt of a task whose cost
was never measured. While a spending cap is set, any such attempt
blocks all new work ("SPEND UNKNOWN - tasks blocked" in \`fabrica
status\`) - look the figure up with your provider, then record it here
to unblock. Refuses a task with nothing unmeasured, so a block only
clears when a real cost is recorded.

Owner-only: never for an AI driver to run.

  <taskId>  The unmeasured task's id, as \`fabrica status\` names it.
  <usd>     The real dollar amount, zero or more, e.g. 0.42.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

export interface RunCostCommandOptions {
  recordHome?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const DOLLARS = /^\d+(\.\d+)?$/;

export function parseCostArgs(argv: string[]): { taskId: string; usd: number } {
  if (argv.length !== 2) {
    throw new CliError(
      "bad-usage",
      `fabrica cost: expected a task id and a dollar amount, got ${argv.length} argument(s). Usage: ${COST_USAGE}`
    );
  }
  const [taskId, amount] = argv;
  if (!DOLLARS.test(amount)) {
    throw new CliError(
      "bad-usage",
      `fabrica cost: "${amount}" is not a cost - give the real dollar amount, zero or more, with no "$", ` +
        `e.g. \`fabrica cost ${taskId} 0.42\`.`
    );
  }
  return { taskId, usd: Number(amount) };
}

/** Returns the process exit code - never throws. */
export async function runCostCommand(argv: string[], opts: RunCostCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));

  try {
    const { taskId, usd } = parseCostArgs(argv);
    const recordHome = opts.recordHome ?? resolveRecordHome();
    await createForeman({ recordHome }).recordCost(taskId, usd);
    stdout(`Recorded ${formatUsd(usd)} as the real cost of ${taskId}'s unmeasured attempts.`);
    return 0;
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
