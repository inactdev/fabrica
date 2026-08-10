// How the CLI learns the task id without do() ever exposing it early
// (see run-task.ts and the module README for why detachment needs this
// at all). doTask's very first act, before any Worker runs, is
// registerTask: it claims `<recordHome>/tasks/<id>/` and writes
// request.md verbatim (src/record/tasks.ts). This watches that
// directory from outside - the same append-only record
// `fabrica status`/`log`/`watch` read - rather than asking do()
// to report anything about itself.
//
// Matching by request.md's content, not by "whichever directory is
// newest", is what lets this ignore an unrelated task that some other
// `fabrica do` invocation happens to register in the same recordHome at
// the same moment. Known v1 limitation: two concurrent invocations
// with byte-identical task text against the same recordHome are not
// disambiguated - the id watching this returns picks whichever
// matching directory it observes first. Narrow enough in practice
// (same text, same day, same record home, truly concurrent) to accept
// rather than invent a correlation mechanism that would have to smuggle
// a marker into request.md - and request.md is the Client's words,
// verbatim, with nothing added (SPEC.md "The record").

import { mkdirSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { CliError } from "./errors.ts";

export interface WatchForTaskIdOptions {
  recordHome: string;
  taskText: string;
  /** Aborting releases the FSWatcher and timers; the returned promise
   * never settles after an abort. */
  signal?: AbortSignal;
  /** How long to wait before giving up. Registration is a handful of
   * synchronous fs calls with no network or Worker involved, so even a
   * slow disk should clear this in well under a second; generous
   * default to absorb a cold `tsx` startup in the spawned process. */
  timeoutMs?: number;
}

/** Resolves with the new task's id once its request.md lands with
 * exactly `taskText` in it. Rejects with CliError("registration-timeout")
 * if nothing matches before `timeoutMs`. */
export function watchForTaskId(opts: WatchForTaskIdOptions): Promise<string> {
  const { recordHome, taskText, signal, timeoutMs = 15_000 } = opts;
  const tasksDir = join(recordHome, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  const seen = new Set(readdirSync(tasksDir));

  return new Promise<string>((resolveTaskId, reject) => {
    let settled = false;
    let watcher: FSWatcher | null = null;
    let pollHandle: NodeJS.Timeout | null = null;
    let timeoutHandle: NodeJS.Timeout | null = null;

    const cleanup = () => {
      watcher?.close();
      if (pollHandle) clearInterval(pollHandle);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
    };

    if (signal) {
      if (signal.aborted) {
        settled = true;
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const check = () => {
      if (settled) return;
      let entries: string[];
      try {
        entries = readdirSync(tasksDir);
      } catch {
        return;
      }
      for (const id of entries) {
        if (seen.has(id)) continue;
        let content: string;
        try {
          content = readFileSync(join(tasksDir, id, "request.md"), "utf8");
        } catch {
          continue; // directory claimed, request.md not written yet - retry next tick
        }
        if (content === taskText) {
          settle(() => resolveTaskId(id));
          return;
        }
      }
    };

    // fs.watch is the fast path; the poll is a safety net for the rare
    // event coalescing that can drop a rapid mkdir-then-writeFile pair.
    try {
      watcher = watch(tasksDir, () => check());
    } catch {
      watcher = null;
    }
    pollHandle = setInterval(check, 100);
    timeoutHandle = setTimeout(() => {
      settle(() =>
        reject(
          new CliError(
            "registration-timeout",
            `fabrica do: the task did not register within ${Math.round(timeoutMs / 1000)}s. ` +
              `Check ${join(recordHome, "cli.log")} for what the background process reported.`
          )
        )
      );
    }, timeoutMs);

    check();
  });
}
