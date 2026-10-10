// A fake Inspector for contract and src tests: answers instantly with the
// verdicts it was given, in order (the last one repeats), and starts
// nothing - no container, no GitHub. It records every call, so a test can
// prove which branch Fabrica asked it to judge. It reports itself
// installed unless told `{ installed: false }` - it never asks the real
// machine, so no test depends on whether `inspector` is on PATH.

import type { Inspection, Inspector } from "../../src/index.ts";
import { fixtureCheckExit } from "./fake-check-box.ts";

export interface FakeInspectorHandle extends Inspector {
  readonly calls: readonly { branch: string; workdir: string }[];
}

export function fakeInspector(
  verdicts: Inspection["verdict"] | Inspection["verdict"][] = "green",
  report: (verdict: Inspection["verdict"], call: number) => string = (verdict) => `fake Inspector: ${verdict}`,
  opts: { installed?: boolean } = {}
): FakeInspectorHandle {
  const list = Array.isArray(verdicts) ? verdicts : [verdicts];
  const calls: { branch: string; workdir: string }[] = [];
  const installed = opts.installed ?? true;
  return {
    calls,
    installed: () => installed,
    async inspect(request) {
      calls.push({ branch: request.branch, workdir: request.workdir });
      const verdict = list[Math.min(calls.length, list.length) - 1];
      return { verdict, report: report(verdict, calls.length) };
    },
  };
}

/** A fake Inspector that answers as the fixture's own check.sh says it
 * would - read, never run - so a test written against a red or green
 * fixture keeps its meaning under Inspector. */
export function fixtureInspector(opts: { installed?: boolean } = {}): FakeInspectorHandle {
  const calls: { branch: string; workdir: string }[] = [];
  const installed = opts.installed ?? true;
  return {
    calls,
    installed: () => installed,
    async inspect(request) {
      calls.push({ branch: request.branch, workdir: request.workdir });
      const green = fixtureCheckExit(request.workdir, "./check.sh") === 0;
      return { verdict: green ? "green" : "red", report: `fake Inspector: check.sh ${green ? "passed" : "failed"}` };
    },
  };
}
