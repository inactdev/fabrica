#!/usr/bin/env node
// A stand-in for the real `herdr` binary, used only by this directory's
// own tests. It does nothing real - it records every invocation it
// receives as one JSON line in the file named by FAKE_HERDR_LOG, so a
// test can assert exactly which calls the watcher made and in what
// order, then prints a deterministic pane id for "pane split" (counted
// from the log itself, so two fake processes sharing one log still hand
// out distinct, increasing ids).

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

const priorSplits = readLoggedCalls().filter((call) => call.args[0] === "pane" && call.args[1] === "split").length;

if (logPath) appendFileSync(logPath, JSON.stringify({ args }) + "\n");

if (args[0] === "pane" && args[1] === "split") {
  process.stdout.write(`pane-${priorSplits + 1}\n`);
}
