// The top-level `fabrica --help` text and command registration. A new
// subcommand slots in as one more entry in COMMANDS and one more entry
// in this help text - nothing here needs reshaping to add one, the way
// status/log/watch (#12) each went in.

export const COMMANDS = [
  "register",
  "do",
  "verdict",
  "answer",
  "cost",
  "doctor",
  "status",
  "log",
  "watch",
  "await",
  "shadow-report",
  "deny-and-log-edit",
  "verify-hook",
  "up",
  "update",
  "tests-map",
] as const;

export const TOP_LEVEL_HELP = `fabrica - hand in a task; get it done in isolation, verified, honestly.

Usage: fabrica <command> [args]

Commands:
  register <path> [--check "<command>" --image <docker image>]
      Set a repository up for Fabrica and register it - run this once
      per project, before the first task. Writes .inspector.json and
      check.sh, runs your check inside the image, then opens a pull
      request for you to merge. The one command that pushes. Without
      those two flags it proposes an .inspector.json instead, on
      stdout, and writes nothing.
  do "<task text>" --project <path-or-name>
      Run a task against a project. If it's materially ambiguous, prints
      one question with its options and stops - answer with
      \`fabrica answer\`. Otherwise runs detached: prints the task id and
      returns immediately.
  answer <taskId> [--option <n>] [--question <id>] [-m "<text>"]
      Answer a task's clarifying question and resume it: pick an option
      by number, or answer in your own words with -m (which is what the
      last option, "other", means). --question names which question you
      are answering, which is how you correct an answer you already gave.
  verdict <taskId> <accept|fix|wrong> [-m "<note>"]
      Record your ruling on a delivered task - closes it (accept/wrong)
      or sends a correction back to the same worker (fix).
  cost <taskId> <usd>
      Owner-only. Record the real cost of a task whose spend was never
      measured - clears a SPEND UNKNOWN block on new work.
  doctor [--live]
      Check, spending nothing, that this machine can run tasks - one
      line per check, OK or FAIL with the exact fix. --live also makes
      one tiny real call with the worker token.
  status
      One line per open task: id, project, state, age, cost. Flags a
      delivered task as awaiting your verdict, and says when unmeasured
      spend is blocking new work.
  log <taskId> [--transcript]
      Print one task's full event history; --transcript adds the raw
      agent output.
  watch <taskId>
      Follow a task while it runs: heartbeats live, transcript in
      batches. Stopping this (Ctrl-C) never stops the work.
  await <taskId>
      Wait until the task needs you - delivered, asking a question, or
      failed - then exit with exactly one line naming which.
  shadow-report
      What your projects' skip rules would have done, per project and
      kind: would-close count, accepted, disagreed, days running.
      Shadow mode only - nothing closes by rule, every task still waits
      on your verdict.
  verify-hook
      Prove whether this directory's session config actually blocks and
      logs an edit, instead of assuming it does.
  deny-and-log-edit
      Not for typing by hand - what a harness's session config runs
      automatically to deny and log a blocked edit.
  up [-c|--continue]
      Start a working session from this project's folder: doctor's
      checks, the live view (reused if already running), then your
      chat harness itself, with the handbook appended to its system
      prompt. --continue also resumes the most recent conversation in
      this folder - what \`fabrica update\` tells you to run afterward.
      Denied to the chat agent itself - only you can run it.
  update
      Take in new Fabrica code without losing a running \`fabrica up\`
      session: pulls (a developer checkout) or reinstalls (an
      installed copy), restarts the live view only if it's now stale,
      and prints one summary line. Denied to the chat agent itself -
      only you can run it.
  tests-map [<path>] [--force]
      Write a project's tests.map - which tests cover which files -
      from its colocated foo.ts / foo.test.ts convention. Every later
      task's brief names the tests its touched files map to, and every
      delivery reports which of them ran and which touched files the
      map covers with nothing. Hand-edit it afterwards. Denied to the
      chat agent itself - only you can run it.

Run "fabrica <command> --help" for a command's own usage.
`;
