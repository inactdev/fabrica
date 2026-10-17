// @ts-check
// What the box actually runs (through bootstrap.mjs): reads the job file
// the host wrote beside this directory's copy, runs the loop, and writes
// one JSON object per line to stdout. The host maps those lines to
// transcript entries the instant each newline lands, and reads the final
// "result" line for everything only the finished process can know -
// cost, the write-up, why it stopped.
//
// Nothing is printed to stdout except NDJSON: it is a protocol, not a
// log. Anything this process itself needs to say goes to stderr, which
// the host surfaces only when something went wrong.

import { readFileSync } from "node:fs";
import { runAsk, runWork } from "./loop.mjs";

/** @typedef {import("./types.ts").AgentJob} AgentJob */
/** @typedef {import("./types.ts").AgentLine} AgentLine */

/** @param {AgentLine} line */
function emit(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

const jobPath = process.argv[2];
if (jobPath === undefined) {
  process.stderr.write("fabrica-agent: no job file was given\n");
  process.exitCode = 2;
} else {
  /** @type {AgentJob} */
  let job;
  try {
    job = JSON.parse(readFileSync(jobPath, "utf8"));
  } catch (err) {
    process.stderr.write(`fabrica-agent: could not read the job file ${jobPath}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
    throw err;
  }

  // The cap is the whole point of this adapter (issue #200), so it is
  // checked on both sides of the box boundary: the host refuses before
  // any container starts, and this refuses before any API call, so no
  // path through this file can spend uncapped money even if it were
  // started by hand.
  if (job.mode === "work" && (typeof job.maxSpendUsd !== "number" || !Number.isFinite(job.maxSpendUsd) || job.maxSpendUsd <= 0)) {
    emit({
      t: "result",
      result: {
        ok: false,
        stopReason: "no-cap",
        turnsCompleted: 0,
        totalCostUsd: 0,
        session: job.sessionId ?? "",
        error: "this worker will not call a paid model API without a per-call spending cap, and the job carried none",
      },
    });
    process.exitCode = 1;
  } else {
    try {
      const result =
        job.mode === "ask"
          ? await runAsk(job, emit, {})
          : await runWork(job, emit, { root: process.cwd() });
      emit({ t: "result", result });
      process.exitCode = result.ok ? 0 : 1;
    } catch (err) {
      // An unexpected failure still reports itself in the protocol, so
      // the task's record says what happened rather than showing a
      // process that produced nothing.
      emit({
        t: "result",
        result: {
          ok: false,
          stopReason: "internal-error",
          turnsCompleted: 0,
          totalCostUsd: null,
          session: job.sessionId ?? "",
          error: err instanceof Error ? `${err.message}` : String(err),
        },
      });
      process.exitCode = 1;
    }
  }
}
