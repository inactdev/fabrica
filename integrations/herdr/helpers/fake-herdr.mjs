#!/usr/bin/env node
// A stand-in for the real `herdr` binary, used only by this directory's
// own tests. It does nothing real - it records every invocation it
// receives as one JSON line in the file named by FAKE_HERDR_LOG, so a
// test can assert exactly which calls the watcher made and in what
// order, then answers the four commands the watcher ever calls the same
// shape the real binary does (https://herdr.dev/llms-full.txt):
//
// - `tab create` prints the documented JSON response, with a
//   deterministic, incrementing pane/tab id pair counted from the log
//   itself (so two fake processes sharing one log still hand out
//   distinct, increasing ids).
// - `pane run`, `pane report-agent`, `pane release-agent` print a small
//   JSON ack - the watcher never reads their output, only tab create's.
//
// FAKE_HERDR_FAIL_SUBCOMMAND (e.g. "pane report-agent"), optionally with
// FAKE_HERDR_FAIL_TIMES (default 1), makes the first N calls matching
// that subcommand fail the way real Herdr documents a server error:
// exit 1 with a JSON error on stderr - so a test can prove a failing
// call is logged and the watcher keeps going.

import { appendFileSync, existsSync, readFileSync } from "node:fs";

const logPath = process.env.FAKE_HERDR_LOG;
const args = process.argv.slice(2);

function readLoggedCalls() {
  if (!logPath || !existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const priorCalls = readLoggedCalls();
const priorTabCreates = priorCalls.filter((call) => call.args[0] === "tab" && call.args[1] === "create").length;

if (logPath) appendFileSync(logPath, JSON.stringify({ args }) + "\n");

const subcommand = `${args[0] ?? ""} ${args[1] ?? ""}`;
const failSubcommand = process.env.FAKE_HERDR_FAIL_SUBCOMMAND;
if (failSubcommand && subcommand === failSubcommand) {
  const failTimes = Number(process.env.FAKE_HERDR_FAIL_TIMES ?? "1");
  const priorMatching = priorCalls.filter((call) => `${call.args[0]} ${call.args[1]}` === failSubcommand).length;
  if (priorMatching < failTimes) {
    process.stderr.write(JSON.stringify({ id: "cli:error", error: { message: `simulated failure for: ${args.join(" ")}` } }) + "\n");
    process.exit(1);
  }
}

if (args[0] === "tab" && args[1] === "create") {
  const n = priorTabCreates + 1;
  const labelIndex = args.indexOf("--label");
  const label = labelIndex >= 0 ? args[labelIndex + 1] : undefined;
  process.stdout.write(
    JSON.stringify({
      id: "cli:tab:create",
      result: {
        root_pane: { pane_id: `w1:p${n}` },
        tab: { tab_id: `w1:t${n}`, label },
        type: "tab_created",
      },
    }) + "\n"
  );
} else if (args[0] === "pane" && (args[1] === "run" || args[1] === "report-agent" || args[1] === "release-agent")) {
  process.stdout.write(JSON.stringify({ id: `cli:pane:${args[1]}`, result: {} }) + "\n");
}
