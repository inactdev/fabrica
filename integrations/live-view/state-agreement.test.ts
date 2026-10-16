// Issue #183: "one diary reader" - `stateOf` (src/foreman/queries.ts) is
// the single function `fabrica status`, `fabrica watch`, `fabrica await`,
// and the live view's reader (createRecordView) all derive a task's state
// from, rather than each working it out from the event log on its own.
// This proves agreement by driving the same fixture records through all
// four real entry points - not by re-asserting that they import the same
// function, which a parallel private copy added later could still defeat.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, registerTask } from "../../src/record/index.ts";
import { eventsByTask, stateOf } from "../../src/index.ts";
import type { FabricaTask } from "../../src/index.ts";
import { runStatusCommand } from "../../src/cli/status-command.ts";
import { runWatchCommand } from "../../src/cli/watch-command.ts";
import { runAwaitCommand } from "../../src/cli/await-command.ts";
import { formatTerminalNotice } from "../../src/cli/render.ts";
import { createRecordView, displayState } from "./record-view.ts";
import type { DisplayState } from "./record-view.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-state-agreement-"));
}

interface Fixture {
  label: string;
  /** The canonical state `stateOf` must report for this fixture - the
   * ground truth every surface below is checked against. */
  state: FabricaTask["state"];
  liveViewState: DisplayState;
  /** The exact line `fabrica await` prints, or null when this state isn't
   * one `await` waits for (it keeps polling - "working"/"checking"). */
  awaitNotice: (id: string) => string | null;
  build: (recordHome: string, id: string) => void;
}

const FIXTURES: Fixture[] = [
  {
    label: "asking",
    state: "asking",
    liveViewState: "asked a question",
    awaitNotice: (id) => `${id} asked a question - answer with fabrica answer ${id}`,
    build: (recordHome, id) => {
      appendEvent(recordHome, { taskId: id, name: "questions-asked", details: { questions: ["q?"] } });
    },
  },
  {
    label: "working",
    state: "working",
    liveViewState: "working",
    awaitNotice: () => null,
    build: (recordHome, id) => {
      appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });
    },
  },
  {
    label: "checking",
    state: "checking",
    // The live view's dashboard collapses "checking" into "working" on
    // purpose (record-view.ts's own displayState) - a legitimate, declared
    // projection of the same raw state, not a disagreement with it.
    liveViewState: "working",
    awaitNotice: () => null,
    build: (recordHome, id) => {
      appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });
      appendEvent(recordHome, { taskId: id, name: "check-run", details: { attempt: 1, phase: "started" } });
    },
  },
  {
    label: "delivered",
    state: "delivered",
    liveViewState: "delivered",
    awaitNotice: (id) => `${id} delivered - awaiting your verdict`,
    build: (recordHome, id) => {
      appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });
      appendEvent(recordHome, { taskId: id, name: "delivered", details: { outcome: "done" } });
    },
  },
  {
    label: "failed (ask-failed, no delivery)",
    state: "failed",
    liveViewState: "failed",
    awaitNotice: (id) => `${id} failed - see fabrica log ${id}`,
    build: (recordHome, id) => {
      appendEvent(recordHome, { taskId: id, name: "ask-failed", details: { error: "no credentials" } });
    },
  },
  {
    label: "refused (Inspector reached no verdict)",
    state: "refused",
    liveViewState: "stopped",
    awaitNotice: (id) => `${id} was refused by Inspector - see fabrica log ${id}`,
    build: (recordHome, id) => {
      appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });
      appendEvent(recordHome, { taskId: id, name: "inspection-finished", details: { verdict: "refused" } });
    },
  },
  {
    label: "closed (accept)",
    state: "closed",
    liveViewState: "closed (accept)",
    awaitNotice: (id) => `${id} is already closed`,
    build: (recordHome, id) => {
      appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });
      appendEvent(recordHome, { taskId: id, name: "delivered", details: { outcome: "done" } });
      appendEvent(recordHome, { taskId: id, name: "verdict-recorded", details: { ruling: "accept" } });
    },
  },
  {
    label: "closed (wrong)",
    state: "closed",
    liveViewState: "closed (wrong)",
    awaitNotice: (id) => `${id} is already closed`,
    build: (recordHome, id) => {
      appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });
      appendEvent(recordHome, { taskId: id, name: "delivered", details: { outcome: "done" } });
      appendEvent(recordHome, { taskId: id, name: "verdict-recorded", details: { ruling: "wrong" } });
    },
  },
];

/** `fabrica status`'s own line format (render.ts's formatStatusLine)
 * always opens with `${id}  ${project}  ${state}  ${age} old` regardless
 * of which branch follows - this pulls the state field back out rather
 * than re-deriving it. */
function statusStateFor(lines: string[], id: string): string | undefined {
  const line = lines.find((l) => l.startsWith(`${id}  `));
  return line?.split(/ {2,}/)[2];
}

for (const fixture of FIXTURES) {
  test(`stateOf agreement (${fixture.label}): status, watch, await, and the live view all agree with stateOf`, async () => {
    const recordHome = tempRecordHome();
    const id = registerTask(recordHome, `fixture: ${fixture.label}`).id;
    fixture.build(recordHome, id);

    const events = eventsByTask(recordHome).get(id)!;
    const expected = stateOf(events);
    assert.equal(expected, fixture.state, "fixture's own declared state matches stateOf - sanity check");
    const hasDelivery = events.some((e) => e.name === "delivered");

    // status: closed tasks drop off the listing entirely (by design);
    // every other state shows up with stateOf's own word as its state field.
    const statusLines: string[] = [];
    const statusExit = await runStatusCommand([], { recordHome, stdout: (l) => statusLines.push(l) });
    assert.equal(statusExit, 0);
    if (expected === "closed") {
      assert.equal(statusStateFor(statusLines, id), undefined, "a closed task is not listed by status");
    } else {
      assert.equal(statusStateFor(statusLines, id), expected);
    }

    // watch: a single poll (pre-aborted signal) always runs once. The one
    // terminal notice it can print is the exact shared render.ts function
    // every surface - including this test - reads it from.
    const watchLines: string[] = [];
    const abortedController = new AbortController();
    abortedController.abort();
    const watchExit = await runWatchCommand([id], {
      recordHome,
      signal: abortedController.signal,
      installSigintHandler: false,
      stdout: (l) => watchLines.push(l),
    });
    assert.equal(watchExit, 0);
    const expectedTerminalNotice = formatTerminalNotice(expected, { taskId: id, hasDelivery });
    if (expectedTerminalNotice !== null) {
      assert.ok(
        watchLines.includes(expectedTerminalNotice),
        `watch should have printed the shared terminal notice for "${expected}"`
      );
    }
    if (expected === "checking") {
      assert.ok(
        watchLines.some((l) => l.startsWith("checking,")),
        "watch should say a checking task is checking"
      );
    }

    // await: exits immediately either way, since the signal is already
    // aborted - printing the notice for an awaitable state, or nothing for
    // one it would otherwise keep polling on ("working"/"checking").
    const awaitLines: string[] = [];
    const awaitAbortedController = new AbortController();
    awaitAbortedController.abort();
    const awaitExit = await runAwaitCommand([id], {
      recordHome,
      signal: awaitAbortedController.signal,
      stdout: (l) => awaitLines.push(l),
    });
    assert.equal(awaitExit, 0);
    const expectedAwaitNotice = fixture.awaitNotice(id);
    assert.deepEqual(awaitLines, expectedAwaitNotice === null ? [] : [expectedAwaitNotice]);

    // the live view's reader.
    const task = createRecordView(recordHome).getTask(id);
    assert.ok(task, "the live view knows about this task");
    assert.equal(task!.state, fixture.liveViewState);
    assert.equal(displayState(expected), expected === "closed" ? "closed" : fixture.liveViewState);
  });
}
