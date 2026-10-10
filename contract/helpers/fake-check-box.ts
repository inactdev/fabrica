// A fake for the worker's box when Fabrica self-tests a project (no
// Inspector): answers instantly with the result it was given and starts
// nothing - it never runs the check anywhere. It records every call.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BoxCheckResult, CheckBox } from "../../src/index.ts";

export interface FakeCheckBoxHandle {
  readonly box: CheckBox;
  readonly calls: readonly { workdir: string; command: string }[];
}

export function fakeCheckBox(result: BoxCheckResult = { ran: true, exitCode: 0, output: "fake box: ok" }): FakeCheckBoxHandle {
  const calls: { workdir: string; command: string }[] = [];
  return {
    calls,
    box: async (workdir, command) => {
      calls.push({ workdir, command });
      return result;
    },
  };
}

/** The `exit N` a fixture check script ends with, read - never run - so a
 * fake can answer the way the fixture's check would. Null when the script
 * is missing. */
export function fixtureCheckExit(workdir: string, command: string): number | null {
  const path = join(workdir, command.replace(/^\.\//, ""));
  if (!existsSync(path)) return null;
  const exits = [...readFileSync(path, "utf8").matchAll(/^\s*exit (\d+)\s*$/gm)];
  return exits.length > 0 ? Number(exits[exits.length - 1][1]) : 0;
}

/** A fake box that answers as the fixture's own check script says it
 * would - read, never run. A missing script is the box lacking the
 * command (exit 127); a command that names no script passes; a `sleep N`
 * line is waited out. */
export function fixtureCheckBox(): FakeCheckBoxHandle {
  const calls: { workdir: string; command: string }[] = [];
  return {
    calls,
    box: async (workdir, command) => {
      calls.push({ workdir, command });
      if (!command.includes("/")) return { ran: true, exitCode: 0, output: `fake box ran: ${command}` };
      const exitCode = fixtureCheckExit(workdir, command);
      // A `sleep N` in the fixture becomes a real wait, so a test can watch
      // a check in progress - still nothing is run.
      const sleep = exitCode === null ? undefined : /^\s*sleep (\d+)/m.exec(readFileSync(join(workdir, command.replace(/^\.\//, "")), "utf8"));
      if (sleep) await new Promise((resolve) => setTimeout(resolve, Number(sleep[1]) * 1000));
      return exitCode === null
        ? { ran: true, exitCode: 127, output: `sh: ${command}: not found` }
        : { ran: true, exitCode, output: `fake box: ${command} -> exit ${exitCode}` };
    },
  };
}
