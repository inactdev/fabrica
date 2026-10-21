import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, appendTaskFile, readEventsForTask, readTaskFile, registerTask } from "../../src/record/index.ts";
import { createForeman } from "../../src/index.ts";
import { fakeBrain } from "../../src/brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { fixtureInspector } from "../../contract/helpers/fake-inspector.ts";
import { startLiveView } from "./server.ts";

const FAKE_VERDICT_FIX_ENTRY = fileURLToPath(new URL("../../src/cli/helpers/fake-verdict-fix-entry.ts", import.meta.url));
const FAKE_ANSWER_ENTRY = fileURLToPath(new URL("../../src/cli/helpers/fake-answer-entry.ts", import.meta.url));
/** A real connection carrying Tailscale's own identity header - this is
 * what `tailscale serve` adds while proxying a request in from the
 * tailnet (server.ts); a test fetch has to set it by hand since nothing
 * here is actually proxied through Serve. */
const IDENTITY_HEADERS = { "Tailscale-User-Login": "client@example.com" };

async function deliveredTask(recordHome: string) {
  return createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain(),
  });
}

/** A real task stopped on its clarifying questions (SPEC.md step 2) -
 * driven through the same `do()` a real one is, so the record carries
 * the real `"questions-asked"` event (project and attempt count
 * included) a later answer round re-derives everything from, not a
 * hand-appended imitation of it. */
async function askingTask(recordHome: string) {
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("build me an app", {
    project: makeFixtureRepo("exit 0"),
    brain: fakeBrain({ askQuestions: ["What database should this use?", "Behind a flag?"] }),
  });
  assert.equal(task.state, "asking");
  return task;
}

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-live-view-server-test-"));
}

/** Every regular file under `dir`, with its size and mtime, so a test can
 * prove a batch of requests touched none of them - including files
 * created after the snapshot, which a plain "nothing changed" diff on
 * existing paths alone would miss. */
function snapshotTree(dir: string): Record<string, { size: number; mtimeMs: number }> {
  const out: Record<string, { size: number; mtimeMs: number }> = {};
  const walk = (current: string) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const stat = statSync(full);
        out[full] = { size: stat.size, mtimeMs: stat.mtimeMs };
      }
    }
  };
  walk(dir);
  return out;
}

test("startLiveView: /api/version reports this running copy's own commit - the real detectCopy-based computation by default", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/version`);
    assert.equal(res.status, 200);
    const body = await res.json();
    // This test runs inside this project's own git checkout, so the
    // real commit is whatever HEAD currently is - the same ground
    // truth src/cli/doctor-command.ts's own "checkout" line reports.
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(body.commit, head);
  } finally {
    await view.close();
  }
});

test("startLiveView: /api/version reports exactly whatever the commit override returns, overriding the real git lookup", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0, commit: () => "fixed-test-commit" });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/version`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { commit: "fixed-test-commit" });
  } finally {
    await view.close();
  }
});

// The bug this whole change started from. /api/version used to call its
// commit reader per request, so a live view process started before a
// merge answered with the commit the CHECKOUT had since moved to - the
// code on disk, not the code it was running. `fabrica up` and `fabrica
// update` compare that answer against their own read of the same
// on-disk value, so the comparison was a value against itself and could
// never find a stale live view at all. The commit is now captured once,
// at startup, and never read again.
test("startLiveView: /api/version keeps reporting the startup commit after the checkout moves under it", async () => {
  let onDisk = "commit-at-start";
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0, commit: () => onDisk });
  try {
    const base = `http://127.0.0.1:${view.port}`;
    assert.deepEqual(await (await fetch(`${base}/api/version`)).json(), { commit: "commit-at-start" });

    // The merge. Same running process, new code on disk.
    onDisk = "commit-after-merge";

    assert.deepEqual(
      await (await fetch(`${base}/api/version`)).json(),
      { commit: "commit-at-start" },
      "/api/version must report the code this process is running, not the code on disk"
    );
    // And a second request is not where it quietly catches up either.
    assert.deepEqual(await (await fetch(`${base}/api/version`)).json(), { commit: "commit-at-start" });

    // /api/checkout is the one that moves - that disagreement is the
    // whole signal a page's banner and fabrica up/update act on.
    assert.deepEqual(await (await fetch(`${base}/api/checkout`)).json(), { commit: "commit-after-merge" });
  } finally {
    await view.close();
  }
});

test("startLiveView: /api/checkout reads the checkout fresh on every request", async () => {
  let onDisk: string | null = "first";
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0, commit: () => onDisk });
  try {
    const base = `http://127.0.0.1:${view.port}`;
    assert.deepEqual(await (await fetch(`${base}/api/checkout`)).json(), { commit: "first" });
    onDisk = "second";
    assert.deepEqual(await (await fetch(`${base}/api/checkout`)).json(), { commit: "second" });
    // A reader that cannot say answers null rather than guessing - the
    // page then shows no banner at all, since there is nothing to
    // compare.
    onDisk = null;
    assert.deepEqual(await (await fetch(`${base}/api/checkout`)).json(), { commit: null });
  } finally {
    await view.close();
  }
});

test("startLiveView: /api/checkout, like /api/version, uses the real detectCopy-based computation by default", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0 });
  try {
    const body = await (await fetch(`http://127.0.0.1:${view.port}/api/checkout`)).json();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(body.commit, head);
  } finally {
    await view.close();
  }
});

test("startLiveView: /api/version reports null, not a crash, when the commit override itself returns null", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0, commit: () => null });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/version`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { commit: null });
  } finally {
    await view.close();
  }
});

// A projects.toml that will not parse used to make this viewer throw out
// of `getState`, which turned every page into one "could not read the
// record" line - a config problem reported as a record problem, with the
// task list (which needs no config at all) taken down with it. Client
// ruling: show the parse error, with the path and the line, and keep the
// list working from the record.
test("startLiveView: an unparseable projects.toml is reported with its path and line, and the task list still works", async () => {
  const recordHome = tempRecordHome();
  const task = await deliveredTask(recordHome);
  writeFileSync(join(recordHome, "projects.toml"), `[caps]\nperDayUsd = 5\nthis is not [valid toml\n`);

  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const base = `http://127.0.0.1:${view.port}`;

    const res = await fetch(`${base}/api/config-problem`);
    assert.equal(res.status, 200, "a broken config file is not a broken server");
    const { problem } = await res.json();
    assert.ok(problem, "the parse error must be reported, never swallowed");
    assert.equal(problem.path, join(recordHome, "projects.toml"));
    assert.equal(problem.line, 3);
    assert.match(problem.message, /not valid TOML/);
    assert.ok(problem.message.includes(join(recordHome, "projects.toml")), problem.message);

    // Every page's own data still comes back, with the task in it.
    for (const path of ["/api/state", "/api/review"]) {
      const body = await (await fetch(`${base}${path}`)).json();
      assert.equal(body.error, undefined, `${path} reported a record error for a config problem: ${body.error}`);
    }
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.deepEqual(
      state.tasks.map((t: { id: string }) => t.id),
      [task.id]
    );
    // The caps fall back to "none set", which is exactly why the banner
    // above has to exist: nothing else on the page distinguishes that
    // from a deliberate choice.
    assert.equal(state.spend.perDayCapUsd, undefined);
  } finally {
    await view.close();
  }
});

test("startLiveView: a projects.toml that reads fine reports no problem at all", async () => {
  const recordHome = tempRecordHome();
  writeFileSync(join(recordHome, "projects.toml"), "[caps]\nperDayUsd = 5\n");
  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const body = await (await fetch(`http://127.0.0.1:${view.port}/api/config-problem`)).json();
    assert.deepEqual(body, { problem: null });
  } finally {
    await view.close();
  }
});

// No projects.toml at all is ordinary, not a problem - a record home
// that has never had one registered still shows its tasks, and a banner
// there would be noise, not information.
test("startLiveView: a record home with no projects.toml reports no problem", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0 });
  try {
    const body = await (await fetch(`http://127.0.0.1:${view.port}/api/config-problem`)).json();
    assert.deepEqual(body, { problem: null });
  } finally {
    await view.close();
  }
});

// The banner strip is one script shared by all four pages (see
// public/banner.js's own header). A page that forgot to load it would
// silently show no banner at all, which is the exact failure this change
// exists to remove - so every page's own source is checked for it.
test("startLiveView: banner.js is served, and every page loads it", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0 });
  try {
    const base = `http://127.0.0.1:${view.port}`;
    const script = await fetch(`${base}/banner.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    const source = await script.text();
    // It polls both halves of the staleness comparison and the config
    // problem - the three facts a banner can be about.
    for (const endpoint of ["/api/version", "/api/checkout", "/api/config-problem"]) {
      assert.ok(source.includes(endpoint), `banner.js never asks ${endpoint}`);
    }
    assert.match(source, /fabrica update/, "the stale banner must name the command that fixes it");

    const taskPagePath = `/tasks/${"20260101-x-aa"}`;
    for (const path of ["/", "/history", "/review", taskPagePath]) {
      const page = await (await fetch(`${base}${path}`)).text();
      assert.match(page, /<script src="\/banner\.js"><\/script>/, `${path} does not load banner.js`);
    }
  } finally {
    await view.close();
  }
});

// banner.js keeps a hand-duplicated copy of display.ts's own
// stalenessNotice/configProblemNotice wording, the same way app.js
// duplicates formatAge (a plain script with no build step cannot import
// across the src/ts boundary). This pins the two sentences so the copy
// that actually runs in a browser cannot drift from the tested one.
test("banner.js: the two banner sentences match the tested display.ts copies word for word", () => {
  const source = readFileSync(fileURLToPath(new URL("./public/banner.js", import.meta.url)), "utf8");
  assert.ok(
    source.includes("This page is served by an older copy of Fabrica: the server is running ${shortCommit(serverCommit)}, "),
    "banner.js's stale sentence no longer matches display.ts's stalenessNotice"
  );
  assert.ok(
    source.includes("the checkout is on ${shortCommit(checkoutCommit)}. Run \\`fabrica update\\` to restart it."),
    "banner.js's stale sentence no longer matches display.ts's stalenessNotice"
  );
  assert.ok(
    source.includes("projects.toml could not be read, so caps and projects are unknown: ${message}"),
    "banner.js's config sentence no longer matches display.ts's configProblemNotice"
  );
});

test("startLiveView: binds only to 127.0.0.1, never to every interface", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0 });
  try {
    const address = view.server.address();
    assert.ok(address && typeof address === "object", "expected a bound TCP address");
    assert.equal((address as { address: string }).address, "127.0.0.1");
  } finally {
    await view.close();
  }
});

test("startLiveView: serves /api/state without crashing when the record home does not exist at all", async () => {
  const recordHome = join(tempRecordHome(), "never-created");
  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/state`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.tasks, []);
  } finally {
    await view.close();
  }
});

test("startLiveView: serves /api/state without crashing when the record home exists but is empty", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/state`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.tasks, []);
    assert.equal(body.spend.dailyUsd, 0);
  } finally {
    await view.close();
  }
});

test("startLiveView: serves the static page and rejects everything but GET", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0 });
  try {
    const page = await fetch(`http://127.0.0.1:${view.port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/);

    const notFound = await fetch(`http://127.0.0.1:${view.port}/no-such-route`);
    assert.equal(notFound.status, 404);

    const posted = await fetch(`http://127.0.0.1:${view.port}/api/state`, { method: "POST" });
    assert.equal(posted.status, 405);
  } finally {
    await view.close();
  }
});

// Every response this server sends is `Cache-Control: no-store`. The
// page, its scripts and its stylesheet are read from the checkout on
// each request and there are no fingerprinted bundles, so a browser
// holding on to any of them is showing code or state that has already
// moved - the exact failure the staleness banner exists to make
// impossible, undone one layer lower by a cached app.js. The JSON API is
// the same story with a shorter fuse: it is a live view of the record.
//
// The header is set in one place (server.ts's `send`), which is what
// makes it true of every route including the error answers. This test is
// the behavioural half of pinning that: it sweeps one request of each
// response SHAPE - a page, a script, a stylesheet, the task page served
// off its own route, every JSON endpoint, and the 400/403/404/405
// refusals - rather than trusting that one checked route stands for the
// rest.
test("startLiveView: every response carries Cache-Control: no-store - pages, scripts, stylesheet, JSON and refusals alike", async () => {
  const recordHome = tempRecordHome();
  const taskId = registerTask(recordHome, "a task to read back").id;
  appendTaskFile(recordHome, taskId, "transcript.log", "working\n");

  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const base = `http://127.0.0.1:${view.port}`;
    const checked: Array<{ what: string; res: Response }> = [];

    // Pages, scripts, stylesheet - the static table - plus the task page,
    // which is served off its own route and so could have been written
    // without `send`.
    for (const path of [
      "/",
      "/history",
      "/review",
      "/app.js",
      "/task.js",
      "/review.js",
      "/banner.js",
      "/style.css",
      `/tasks/${taskId}`,
    ]) {
      checked.push({ what: `GET ${path}`, res: await fetch(`${base}${path}`) });
    }

    // Every JSON endpoint, including the two that answer a known task.
    for (const path of [
      "/api/state",
      "/api/history",
      "/api/review",
      "/api/version",
      "/api/checkout",
      "/api/config-problem",
      `/api/tasks/${taskId}`,
      `/api/tasks/${taskId}/transcript`,
    ]) {
      checked.push({ what: `GET ${path}`, res: await fetch(`${base}${path}`) });
    }

    // The refusals. A cached 404 or 403 is its own small trap - a page
    // that was briefly wrong about a route or an identity would keep
    // being wrong until the browser let go of it.
    checked.push({ what: "404 unknown route", res: await fetch(`${base}/no-such-route`) });
    checked.push({ what: "404 unknown task", res: await fetch(`${base}/api/tasks/20260101-ghost-zz`) });
    checked.push({ what: "400 bad task id", res: await fetch(`${base}/api/tasks/..%2f..%2fetc/transcript`) });
    checked.push({ what: "405 non-GET", res: await fetch(`${base}/api/state`, { method: "POST" }) });
    checked.push({
      what: "403 no identity",
      res: await fetch(`${base}/api/review/tasks/${taskId}/verdict`, {
        method: "POST",
        body: JSON.stringify({ ruling: "accept" }),
      }),
    });

    for (const { what, res } of checked) {
      await res.text(); // drain, so no connection is left open behind this
      assert.equal(res.headers.get("cache-control"), "no-store", `${what} did not answer with Cache-Control: no-store`);
    }
    // A guard on the sweep itself: an empty or half-built list would make
    // every assertion above vacuously pass.
    assert.ok(checked.length >= 22, `only ${checked.length} responses were checked - the sweep lost routes`);
    assert.deepEqual(
      checked.filter(({ res }) => res.status === 500).map(({ what }) => what),
      [],
      "a route answered 500 - the sweep is measuring the error handler, not the route"
    );
  } finally {
    await view.close();
  }
});

// The structural half, and the one that actually holds the line: the
// sweep above can only cover the routes that exist today, so it would say
// nothing about a route added next year that wrote its own headers. One
// function writes response headers in this module, so there is no route
// that can be written without inheriting no-store - this reads the
// server's own source to keep that true, the same way
// src/foreman/no-host-check.test.ts scans for a host check.
test("server.ts writes response headers in exactly one place, so no route can be added that skips no-store", () => {
  const source = readFileSync(fileURLToPath(new URL("./server.ts", import.meta.url)), "utf8");

  const writeHeadCalls = [...source.matchAll(/\.writeHead\s*\(/g)];
  assert.equal(writeHeadCalls.length, 1, `expected exactly one writeHead call in server.ts, found ${writeHeadCalls.length}`);
  assert.equal(
    [...source.matchAll(/\.setHeader\s*\(|\.appendHeader\s*\(/g)].length,
    0,
    "server.ts sets a header outside `send` - every response's headers must come from that one helper"
  );
  assert.match(
    source,
    /function send\([^)]*\)[^{]*\{\s*res\.writeHead\(status, \{ "Content-Type": contentType, "Cache-Control": "no-store" \}\);/,
    "`send` no longer sets Cache-Control: no-store unconditionally alongside the content type"
  );
});

test("startLiveView: a task id that fails the id pattern is refused before it ever reaches the filesystem", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0 });
  try {
    // A literal "/" smuggled in as "%2f" so it survives routing as one
    // path segment, then decodes back to a slash - exactly what a path-
    // traversal attempt through this parameter would look like.
    const res = await fetch(`http://127.0.0.1:${view.port}/api/tasks/..%2f..%2fetc/transcript`);
    assert.equal(res.status, 400);
  } finally {
    await view.close();
  }
});

test("startLiveView: a task's live transcript tails as it grows", async () => {
  const recordHome = tempRecordHome();
  const taskId = registerTask(recordHome, "stream me").id;
  appendTaskFile(recordHome, taskId, "transcript.log", `${JSON.stringify({ occurredAt: "t0", kind: "stdout", text: "first" })}\n`);

  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const first = await (await fetch(`http://127.0.0.1:${view.port}/api/tasks/${taskId}/transcript`)).json();
    assert.deepEqual(
      first.transcript.map((e: { text: string }) => e.text),
      ["first"]
    );

    appendTaskFile(recordHome, taskId, "transcript.log", `${JSON.stringify({ occurredAt: "t1", kind: "stdout", text: "second" })}\n`);

    const second = await (await fetch(`http://127.0.0.1:${view.port}/api/tasks/${taskId}/transcript`)).json();
    assert.deepEqual(
      second.transcript.map((e: { text: string }) => e.text),
      ["first", "second"]
    );
  } finally {
    await view.close();
  }
});

test("startLiveView: an event with a valid JSON shape but unexpected contents never kills the server - it answers with an error, and keeps answering after", async () => {
  const recordHome = tempRecordHome();
  const taskId = registerTask(recordHome, "confuse the ledger").id;
  // A real receipt, so this task "has attempts" and its cost is actually
  // rendered (describeTaskCost only calls formatUsd down that path) -
  // then a "cost-recorded" event whose "usd" is a string, not a number:
  // valid JSON, wrong type. taskSpend's reduce has no type guard on it,
  // so "meteredUsd" silently becomes a string ("0" + the string, via "+"),
  // and formatUsd's usd.toFixed(2) throws once something downstream
  // actually tries to format it - deep inside reused library code this
  // integration never parses itself.
  appendEvent(recordHome, {
    taskId,
    name: "receipt-recorded",
    details: {
      receipt: {
        task: taskId,
        attempt: 1,
        brain: "x",
        model: "y",
        startedAt: new Date().toISOString(),
        durationMs: 1,
        costUsd: 0.42,
        costUnknown: false,
        session: null,
        reasoningEffort: null,
        checks: null,
        outcome: "delivered",
      },
    },
  });
  appendEvent(recordHome, { taskId, name: "cost-recorded", details: { usd: "oops", attempts: [1] } });

  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const first = await fetch(`http://127.0.0.1:${view.port}/api/state`);
    assert.equal(first.status, 200, "the server must still answer, not hang up or crash");
    const firstBody = await first.json();
    assert.match(firstBody.error, /^could not read the record: /);

    // The crux of the ask: a second request right after must still get a
    // real answer - the process is still alive and the server is still
    // listening, not just that this one response object looked fine.
    const second = await fetch(`http://127.0.0.1:${view.port}/api/state`);
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.match(secondBody.error, /^could not read the record: /);
  } finally {
    await view.close();
  }
});

test("startLiveView: an unknown task id's transcript is a 404, not a crash", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/tasks/20260101-ghost-zz/transcript`);
    assert.equal(res.status, 404);
  } finally {
    await view.close();
  }
});

test("startLiveView: /api/state only ever lists open tasks, /api/history only ever lists finished ones", async () => {
  const recordHome = tempRecordHome();

  const working = registerTask(recordHome, "still working").id;
  appendEvent(recordHome, { taskId: working, name: "work-started", details: { project: "/p" } });

  const asking = registerTask(recordHome, "asked something").id;
  appendEvent(recordHome, { taskId: asking, name: "questions-asked", details: { questions: ["q?"] } });

  const delivered = registerTask(recordHome, "delivered something").id;
  appendEvent(recordHome, { taskId: delivered, name: "work-started", details: { project: "/p" } });
  appendEvent(recordHome, { taskId: delivered, name: "delivered", details: { outcome: "done" } });

  const failed = registerTask(recordHome, "failed to ask").id;
  appendEvent(recordHome, { taskId: failed, name: "ask-failed", details: { error: "no credentials" } });

  const closed = registerTask(recordHome, "closed out").id;
  appendEvent(recordHome, { taskId: closed, name: "work-started", details: { project: "/p" } });
  appendEvent(recordHome, { taskId: closed, name: "delivered", details: { outcome: "done" } });
  appendEvent(recordHome, { taskId: closed, name: "verdict-recorded", details: { ruling: "accept" } });

  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const openBody = await (await fetch(`http://127.0.0.1:${view.port}/api/state`)).json();
    const openIds = openBody.tasks.map((t: { id: string }) => t.id).sort();
    assert.deepEqual(openIds, [asking, delivered, working].sort());

    const historyBody = await (await fetch(`http://127.0.0.1:${view.port}/api/history`)).json();
    const historyIds = historyBody.tasks.map((t: { id: string }) => t.id).sort();
    assert.deepEqual(historyIds, [closed, failed].sort());
  } finally {
    await view.close();
  }
});

test("startLiveView: /history serves the history page", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0 });
  try {
    const page = await fetch(`http://127.0.0.1:${view.port}/history`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/);
  } finally {
    await view.close();
  }
});

test("startLiveView: /api/tasks/<id> answers a known task's full view, and 404s an unknown one", async () => {
  const recordHome = tempRecordHome();
  const taskId = registerTask(recordHome, "look at me directly").id;
  appendEvent(recordHome, { taskId, name: "work-started", details: { project: "/p" } });

  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const found = await fetch(`http://127.0.0.1:${view.port}/api/tasks/${taskId}`);
    assert.equal(found.status, 200);
    const body = await found.json();
    assert.equal(body.task.id, taskId);
    assert.equal(body.task.project, "/p");

    const notFound = await fetch(`http://127.0.0.1:${view.port}/api/tasks/20260101-ghost-zz`);
    assert.equal(notFound.status, 404);
  } finally {
    await view.close();
  }
});

test("startLiveView: a task id that fails the id pattern is refused on /api/tasks/<id> too", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/tasks/..%2f..%2fetc`);
    assert.equal(res.status, 400);
  } finally {
    await view.close();
  }
});

test("startLiveView: /tasks/<id> serves the task page for a real task id's shape, and falls through to 404 otherwise", async () => {
  const recordHome = tempRecordHome();
  const taskId = registerTask(recordHome, "give me my own page").id;

  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const page = await fetch(`http://127.0.0.1:${view.port}/tasks/${taskId}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/);

    // Not shaped like a real task id (TASK_ID_PATTERN) - never reaches
    // task.html, same as any other unknown route.
    const notATaskId = await fetch(`http://127.0.0.1:${view.port}/tasks/not-a-real-id`);
    assert.equal(notATaskId.status, 404);
  } finally {
    await view.close();
  }
});

test("startLiveView: /api/review lists a delivered task with its write-up, Inspector's stamp, and the gate's state", async () => {
  const recordHome = tempRecordHome();
  const task = await deliveredTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].id, task.id);
    assert.equal(typeof body.rows[0].writeupBody, "string");
    assert.equal(typeof body.rows[0].inspectorStamp, "string");
    assert.equal(typeof body.rows[0].gateState, "string");
  } finally {
    await view.close();
  }
});

test("startLiveView: /api/review also lists an Inspector refusal with no delivery, and a task that failed before any work started - each with one reason and no write-up fields", async () => {
  const recordHome = tempRecordHome();
  const refusedId = registerTask(recordHome, "refuse me").id;
  appendEvent(recordHome, { taskId: refusedId, name: "work-started", details: { project: "/p" } });
  appendEvent(recordHome, {
    taskId: refusedId,
    name: "inspection-finished",
    details: { verdict: "refused", report: "GITHUB_TOKEN is missing" },
  });
  const failedId = registerTask(recordHome, "fail me").id;
  appendEvent(recordHome, { taskId: failedId, name: "task-failed", details: { message: "the project path /nope does not exist" } });

  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const byId = new Map((body.rows as Array<Record<string, unknown>>).map((r) => [r.id as string, r]));

    const refused = byId.get(refusedId);
    assert.ok(refused, "the refused task must appear on the review page");
    assert.equal(refused!.kind, "refused");
    assert.equal(refused!.reason, "GITHUB_TOKEN is missing");
    assert.equal(refused!.writeupBody, undefined);

    const failed = byId.get(failedId);
    assert.ok(failed, "the failed task must appear on the review page");
    assert.equal(failed!.kind, "failed");
    assert.equal(failed!.reason, "the project path /nope does not exist");
    assert.equal(failed!.writeupBody, undefined);
  } finally {
    await view.close();
  }
});

test("startLiveView: a verdict POST with no Tailscale identity header is refused, and records nothing", async () => {
  const recordHome = tempRecordHome();
  const task = await deliveredTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review/tasks/${task.id}/verdict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ruling: "accept" }),
    });
    assert.equal(res.status, 403);

    const events = readEventsForTask(recordHome, task.id);
    assert.ok(!events.some((e) => e.name === "verdict-recorded"));
  } finally {
    await view.close();
  }
});

test("startLiveView: an empty Tailscale identity header is treated the same as a missing one", async () => {
  const recordHome = tempRecordHome();
  const task = await deliveredTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review/tasks/${task.id}/verdict`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Tailscale-User-Login": "   " },
      body: JSON.stringify({ ruling: "accept" }),
    });
    assert.equal(res.status, 403);
  } finally {
    await view.close();
  }
});

test("startLiveView: a verdict POST with the identity header records accept exactly as fabrica verdict does, closing the task", async () => {
  const recordHome = tempRecordHome();
  const task = await deliveredTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review/tasks/${task.id}/verdict`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...IDENTITY_HEADERS },
      body: JSON.stringify({ ruling: "accept" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, ruling: "accept" });

    const mine = (await createForeman({ recordHome, inspector: fixtureInspector() }).status()).find((t) => t.id === task.id);
    assert.equal(mine?.state, "closed");

    // Closed - no longer waiting on anyone.
    const review = await (await fetch(`http://127.0.0.1:${view.port}/api/review`)).json();
    assert.deepEqual(review.rows, []);
  } finally {
    await view.close();
  }
});

test("startLiveView: an optional note on accept reaches the record exactly as `fabrica verdict -m` puts it there", async () => {
  const recordHome = tempRecordHome();
  const task = await deliveredTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review/tasks/${task.id}/verdict`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...IDENTITY_HEADERS },
      body: JSON.stringify({ ruling: "accept", note: "exactly the button I wanted" }),
    });
    assert.equal(res.status, 200);

    // The Client's own words, on the two places a `-m` note lands: the
    // task's human-readable verdict file and the event the rest of
    // Fabrica reads.
    assert.match(readTaskFile(recordHome, task.id, "verdict") ?? "", /accept: exactly the button I wanted/);
    const recorded = readEventsForTask(recordHome, task.id).filter((e) => e.name === "verdict-recorded").at(-1);
    assert.deepEqual(recorded?.details, { ruling: "accept", note: "exactly the button I wanted" });
  } finally {
    await view.close();
  }
});

test("startLiveView: an accept with no note at all records no note - the empty-box case (Client ruling)", async () => {
  const recordHome = tempRecordHome();
  const task = await deliveredTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0 });
  try {
    // What review.js sends when the box is empty: the `note` key is left
    // off the body entirely, not sent as "".
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review/tasks/${task.id}/verdict`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...IDENTITY_HEADERS },
      body: JSON.stringify({ ruling: "accept" }),
    });
    assert.equal(res.status, 200);

    assert.match(readTaskFile(recordHome, task.id, "verdict") ?? "", /accept\n$/);
    const recorded = readEventsForTask(recordHome, task.id).filter((e) => e.name === "verdict-recorded").at(-1);
    assert.deepEqual(recorded?.details, { ruling: "accept", note: "" });
  } finally {
    await view.close();
  }
});

test("startLiveView: an optional note on wrong reaches the record the same way", async () => {
  const recordHome = tempRecordHome();
  const task = await deliveredTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review/tasks/${task.id}/verdict`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...IDENTITY_HEADERS },
      body: JSON.stringify({ ruling: "wrong", note: "not what I asked for" }),
    });
    assert.equal(res.status, 200);

    assert.match(readTaskFile(recordHome, task.id, "verdict") ?? "", /wrong: not what I asked for/);
    const recorded = readEventsForTask(recordHome, task.id).filter((e) => e.name === "verdict-recorded").at(-1);
    assert.deepEqual(recorded?.details, { ruling: "wrong", note: "not what I asked for" });
  } finally {
    await view.close();
  }
});

test("startLiveView: a verdict POST for \"fix\" with no note is refused before anything is recorded", async () => {
  const recordHome = tempRecordHome();
  const task = await deliveredTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review/tasks/${task.id}/verdict`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...IDENTITY_HEADERS },
      body: JSON.stringify({ ruling: "fix" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /note/);

    const events = readEventsForTask(recordHome, task.id);
    assert.ok(!events.some((e) => e.name === "verdict-recorded"));
  } finally {
    await view.close();
  }
});

test("startLiveView: an unknown ruling is rejected with 400", async () => {
  const recordHome = tempRecordHome();
  const task = await deliveredTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review/tasks/${task.id}/verdict`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...IDENTITY_HEADERS },
      body: JSON.stringify({ ruling: "maybe" }),
    });
    assert.equal(res.status, 400);
  } finally {
    await view.close();
  }
});

test("startLiveView: a verdict POST for an unknown task id is rejected, and one with the wrong shape never reaches the record at all", async () => {
  const recordHome = tempRecordHome();
  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const base = `http://127.0.0.1:${view.port}`;

    const badShape = await fetch(`${base}/api/review/tasks/..%2f..%2fetc/verdict`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...IDENTITY_HEADERS },
      body: JSON.stringify({ ruling: "accept" }),
    });
    assert.equal(badShape.status, 400);

    const unknown = await fetch(`${base}/api/review/tasks/20260101-nope-zz/verdict`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...IDENTITY_HEADERS },
      body: JSON.stringify({ ruling: "accept" }),
    });
    assert.equal(unknown.status, 400);
  } finally {
    await view.close();
  }
});

test("startLiveView: a verdict POST for \"fix\" hands the round to the detached process in the background, the same mechanism fabrica verdict fix uses", async () => {
  const recordHome = tempRecordHome();
  const task = await deliveredTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0, fixEntryScript: FAKE_VERDICT_FIX_ENTRY });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review/tasks/${task.id}/verdict`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...IDENTITY_HEADERS },
      body: JSON.stringify({ ruling: "fix", note: "wrong button spot" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, ruling: "fix" });

    // The response came back before the round itself finished - the
    // same "returns immediately" contract issue #123 gave `fabrica
    // verdict fix` on the command line.
    const deadline = Date.now() + 10_000;
    let delivered = 0;
    while (Date.now() < deadline) {
      delivered = readEventsForTask(recordHome, task.id).filter((e) => e.name === "delivered").length;
      if (delivered >= 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(delivered, 2, "the fix round never delivered a second time in the background");
  } finally {
    await view.close();
  }
});

test("startLiveView: /api/review lists a task waiting on an answer, with the worker's own questions", async () => {
  const recordHome = tempRecordHome();
  const task = await askingTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].id, task.id);
    assert.equal(body.rows[0].kind, "asking");
    assert.deepEqual(body.rows[0].questions, ["What database should this use?", "Behind a flag?"]);
    // Nothing to rule on yet - an asking row carries no delivery fields.
    assert.equal(body.rows[0].writeupBody, undefined);
  } finally {
    await view.close();
  }
});

test("startLiveView: an answer POST with no Tailscale identity header is refused, and records nothing", async () => {
  const recordHome = tempRecordHome();
  const task = await askingTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review/tasks/${task.id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "Postgres." }),
    });
    assert.equal(res.status, 403);

    const events = readEventsForTask(recordHome, task.id);
    assert.ok(!events.some((e) => e.name === "answers-given"));
  } finally {
    await view.close();
  }
});

test("startLiveView: an empty Tailscale identity header is treated the same as a missing one on the answer route too", async () => {
  const recordHome = tempRecordHome();
  const task = await askingTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review/tasks/${task.id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Tailscale-User-Login": "   " },
      body: JSON.stringify({ answer: "Postgres." }),
    });
    assert.equal(res.status, 403);
  } finally {
    await view.close();
  }
});

test("startLiveView: an answer POST with the identity header records the answer exactly as fabrica answer does, and hands the round to the detached process", async () => {
  const recordHome = tempRecordHome();
  const task = await askingTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0, answerEntryScript: FAKE_ANSWER_ENTRY });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review/tasks/${task.id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...IDENTITY_HEADERS },
      body: JSON.stringify({ answer: "Use Postgres, no flag." }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    // Recorded synchronously, in the foreground - exactly what `fabrica
    // answer` itself records before handing off (issue #123).
    const events = readEventsForTask(recordHome, task.id);
    const answered = events.find((e) => e.name === "answers-given");
    assert.ok(answered, "the answer must be on the record before this request answered");
    assert.equal((answered!.details as { answer?: string }).answer, "Use Postgres, no flag.");
    // The Client's words reach the worker's brief, the same way the CLI
    // path builds it (recordAnswerDecision, src/foreman/answer.ts).
    assert.match(readTaskFile(recordHome, task.id, "brief.md") ?? "", /Use Postgres, no flag\./);

    // ...and the round itself ran in the background, not inside this
    // request.
    const deadline = Date.now() + 10_000;
    let delivered = false;
    while (Date.now() < deadline) {
      if (readEventsForTask(recordHome, task.id).some((e) => e.name === "delivered")) {
        delivered = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(delivered, "the answered round never delivered in the background");
  } finally {
    await view.close();
  }
});

test("startLiveView: an answer POST with no text, or the wrong shape, is refused with the same words fabrica answer uses, before anything is recorded", async () => {
  const recordHome = tempRecordHome();
  const task = await askingTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const base = `http://127.0.0.1:${view.port}`;

    const empty = await fetch(`${base}/api/review/tasks/${task.id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...IDENTITY_HEADERS },
      body: JSON.stringify({ answer: "   " }),
    });
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).error, /an answer needs actual text/);

    const wrongShape = await fetch(`${base}/api/review/tasks/${task.id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...IDENTITY_HEADERS },
      body: JSON.stringify({ note: "wrong field" }),
    });
    assert.equal(wrongShape.status, 400);

    assert.ok(!readEventsForTask(recordHome, task.id).some((e) => e.name === "answers-given"));
  } finally {
    await view.close();
  }
});

test("startLiveView: an answer POST for a task with no question pending, an unknown id, or a malformed id is refused", async () => {
  const recordHome = tempRecordHome();
  const delivered = await deliveredTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const base = `http://127.0.0.1:${view.port}`;

    // A real task, but one that never asked anything - the same refusal
    // `fabrica answer` gives.
    const nothingPending = await fetch(`${base}/api/review/tasks/${delivered.id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...IDENTITY_HEADERS },
      body: JSON.stringify({ answer: "nothing to answer" }),
    });
    assert.equal(nothingPending.status, 400);
    assert.match((await nothingPending.json()).error, /never asked a clarifying question/);

    const badShape = await fetch(`${base}/api/review/tasks/..%2f..%2fetc/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...IDENTITY_HEADERS },
      body: JSON.stringify({ answer: "hi" }),
    });
    assert.equal(badShape.status, 400);

    const unknown = await fetch(`${base}/api/review/tasks/20260101-nope-zz/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...IDENTITY_HEADERS },
      body: JSON.stringify({ answer: "hi" }),
    });
    assert.equal(unknown.status, 400);

    assert.ok(!readEventsForTask(recordHome, delivered.id).some((e) => e.name === "answers-given"));
  } finally {
    await view.close();
  }
});

test("startLiveView: no request, of any kind, ever changes a file on disk", async () => {
  const recordHome = tempRecordHome();
  const taskId = registerTask(recordHome, "do not touch me").id;
  appendEvent(recordHome, { taskId, name: "work-started", details: { project: "/p" } });
  appendTaskFile(recordHome, taskId, "transcript.log", `${JSON.stringify({ occurredAt: "t0", kind: "stdout", text: "hi" })}\n`);

  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const base = `http://127.0.0.1:${view.port}`;
    const before = snapshotTree(recordHome);

    await Promise.all([
      fetch(`${base}/`),
      fetch(`${base}/history`),
      fetch(`${base}/review`),
      fetch(`${base}/app.js`),
      fetch(`${base}/style.css`),
      fetch(`${base}/task.js`),
      fetch(`${base}/review.js`),
      fetch(`${base}/tasks/${taskId}`),
      fetch(`${base}/api/state`),
      fetch(`${base}/api/history`),
      fetch(`${base}/api/review`),
      fetch(`${base}/api/version`),
      fetch(`${base}/api/checkout`),
      fetch(`${base}/api/config-problem`),
      fetch(`${base}/banner.js`),
      fetch(`${base}/api/tasks/${taskId}`),
      fetch(`${base}/api/tasks/${taskId}/transcript`),
      fetch(`${base}/api/tasks/${taskId}/transcript`),
      fetch(`${base}/no-such-route`),
      fetch(`${base}/api/state`, { method: "POST" }),
      fetch(`${base}/api/tasks/..%2f..%2fetc/transcript`),
      // No Tailscale identity header - refused before the body is even
      // read, so these three well-formed-looking POSTs (the server's
      // only write routes) must write nothing either.
      fetch(`${base}/api/review/tasks/${taskId}/verdict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruling: "accept" }),
      }),
      fetch(`${base}/api/review/tasks/${taskId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "nope" }),
      }),
      fetch(`${base}/api/review/tasks/${taskId}/stop`, { method: "POST" }),
    ]);

    assert.deepEqual(snapshotTree(recordHome), before);
  } finally {
    await view.close();
  }
});

// --- stop (issue #203) ------------------------------------------------
//
// The third write route, and the only one that reaches outside the
// record at all. Its process half is injected here (`stopProcess`): what
// these tests are for is the gate, the refusals, and what lands on the
// record - the real signaling is proved against real processes in
// src/cli/task-process.test.ts, which is where the operating system's
// own behavior belongs.

/** A task genuinely mid-work: registered, a worker started, one
 * transcript line written exactly the way attempts.ts writes them. */
function workingTask(recordHome: string, lastLine = "editing src/thing.ts"): string {
  const { id } = registerTask(recordHome, "a long-running task");
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/p" } });
  appendTaskFile(
    recordHome,
    id,
    "transcript.log",
    `${JSON.stringify({ occurredAt: "2026-10-18T10:00:00.000Z", kind: "stdout", text: lastLine })}\n`
  );
  return id;
}

/** A stand-in for the half of `stop` that signals a real process,
 * recording what it was asked to do. */
function recordingStopProcess(pid: number | null) {
  const calls: { recordHome: string; taskId: string }[] = [];
  return {
    calls,
    stopProcess: (recordHome: string, taskId: string) => {
      calls.push({ recordHome, taskId });
      return { pid };
    },
  };
}

test("startLiveView: a stop POST with no Tailscale identity header is refused, and neither records nor signals anything", async () => {
  const recordHome = tempRecordHome();
  const taskId = workingTask(recordHome);
  const stopper = recordingStopProcess(4242);
  const view = await startLiveView({ recordHome, port: 0, stopProcess: stopper.stopProcess });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review/tasks/${taskId}/stop`, { method: "POST" });
    assert.equal(res.status, 403);

    const events = readEventsForTask(recordHome, taskId);
    assert.ok(!events.some((e) => e.name === "stopped-by-owner"), "nothing recorded");
    assert.deepEqual(stopper.calls, [], "and nothing signaled - the gate comes first");
  } finally {
    await view.close();
  }
});

test("startLiveView: an empty Tailscale identity header is treated the same as a missing one on the stop route too", async () => {
  const recordHome = tempRecordHome();
  const taskId = workingTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0, stopProcess: () => ({ pid: 1 }) });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review/tasks/${taskId}/stop`, {
      method: "POST",
      headers: { "Tailscale-User-Login": "   " },
    });
    assert.equal(res.status, 403);
    assert.ok(!readEventsForTask(recordHome, taskId).some((e) => e.name === "stopped-by-owner"));
  } finally {
    await view.close();
  }
});

test("startLiveView: a stop POST with the identity header records who stopped it and the worker's last activity, then signals the process", async () => {
  const recordHome = tempRecordHome();
  const taskId = workingTask(recordHome, "running the check");
  const stopper = recordingStopProcess(9931);
  const view = await startLiveView({ recordHome, port: 0, stopProcess: stopper.stopProcess });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review/tasks/${taskId}/stop`, {
      method: "POST",
      headers: IDENTITY_HEADERS,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, stoppedFrom: "working", signaled: true, pid: 9931 });

    const event = readEventsForTask(recordHome, taskId).find((e) => e.name === "stopped-by-owner");
    assert.ok(event, "the decision is on the record");
    const details = event!.details as { by: string; lastActivity: { text: string } | null };
    assert.equal(details.by, "client@example.com", "the Tailscale login of whoever stopped it");
    assert.equal(details.lastActivity?.text, "running the check");

    assert.deepEqual(stopper.calls, [{ recordHome, taskId }]);
  } finally {
    await view.close();
  }
});

test("startLiveView: a stopped task is terminal - it leaves the open list for history, and is not waiting on anyone", async () => {
  const recordHome = tempRecordHome();
  const taskId = workingTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0, stopProcess: () => ({ pid: 1 }) });
  try {
    const base = `http://127.0.0.1:${view.port}`;
    const runningBefore = await (await fetch(`${base}/api/review`)).json();
    assert.deepEqual(
      runningBefore.running.map((r: { id: string }) => r.id),
      [taskId],
      "a running task is what the stop control is offered for"
    );

    await fetch(`${base}/api/review/tasks/${taskId}/stop`, { method: "POST", headers: IDENTITY_HEADERS });

    const open = await (await fetch(`${base}/api/state`)).json();
    assert.deepEqual(open.tasks, [], "no longer an open task");
    const history = await (await fetch(`${base}/api/history`)).json();
    assert.deepEqual(
      history.tasks.map((t: { id: string; state: string }) => [t.id, t.state]),
      [[taskId, "stopped by you"]]
    );
    const review = await (await fetch(`${base}/api/review`)).json();
    assert.deepEqual(review.rows, [], "nothing is waiting on the Client");
    assert.deepEqual(review.running, [], "and nothing is left to stop");
  } finally {
    await view.close();
  }
});

test("startLiveView: stopping a task that is not running is refused with a 400 naming the state, and signals nothing", async () => {
  const recordHome = tempRecordHome();
  const task = await deliveredTask(recordHome);
  const stopper = recordingStopProcess(1234);
  const view = await startLiveView({ recordHome, port: 0, stopProcess: stopper.stopProcess });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review/tasks/${task.id}/stop`, {
      method: "POST",
      headers: IDENTITY_HEADERS,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /is delivered, not running/);
    assert.deepEqual(stopper.calls, []);
    assert.ok(!readEventsForTask(recordHome, task.id).some((e) => e.name === "stopped-by-owner"));
  } finally {
    await view.close();
  }
});

test("startLiveView: a task whose process can no longer be found is still recorded as stopped, and says so plainly", async () => {
  const recordHome = tempRecordHome();
  const taskId = workingTask(recordHome);
  // Exactly what findTaskProcess returns when the pid file is gone, the
  // process already exited, or its command line no longer matches - the
  // Client's decision still stands.
  const view = await startLiveView({ recordHome, port: 0, stopProcess: () => ({ pid: null }) });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review/tasks/${taskId}/stop`, {
      method: "POST",
      headers: IDENTITY_HEADERS,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, stoppedFrom: "working", signaled: false, pid: null });
    assert.ok(readEventsForTask(recordHome, taskId).some((e) => e.name === "stopped-by-owner"));
  } finally {
    await view.close();
  }
});

test("startLiveView: a stop for a malformed task id is a 400 before anything else, like every other route taking one", async () => {
  const recordHome = tempRecordHome();
  const stopper = recordingStopProcess(1);
  const view = await startLiveView({ recordHome, port: 0, stopProcess: stopper.stopProcess });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review/tasks/..%2f..%2fetc/stop`, {
      method: "POST",
      headers: IDENTITY_HEADERS,
    });
    assert.equal(res.status, 400);
    assert.equal(await res.text(), "Not a task id.");
    assert.deepEqual(stopper.calls, []);
  } finally {
    await view.close();
  }
});

test("startLiveView: a stop for an unknown task id is refused, not recorded against a task that doesn't exist", async () => {
  const recordHome = tempRecordHome();
  const view = await startLiveView({ recordHome, port: 0, stopProcess: () => ({ pid: 1 }) });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/review/tasks/20260101-nope-aa/stop`, {
      method: "POST",
      headers: IDENTITY_HEADERS,
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /no task/);
  } finally {
    await view.close();
  }
});

test("startLiveView: /api/review says whether this very request carried an identity, so the page knows whether to draw stop at all", async () => {
  const recordHome = tempRecordHome();
  workingTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0, stopProcess: () => ({ pid: 1 }) });
  try {
    const plain = await (await fetch(`http://127.0.0.1:${view.port}/api/review`)).json();
    assert.equal(plain.identified, false, "reached directly, with no Serve in front of it");

    const proxied = await (await fetch(`http://127.0.0.1:${view.port}/api/review`, { headers: IDENTITY_HEADERS })).json();
    assert.equal(proxied.identified, true);

    // A display hint only - the route still decides for itself, on its
    // own request, so a page that drew the button anyway gets nowhere.
    const blank = await (await fetch(`http://127.0.0.1:${view.port}/api/review`, {
      headers: { "Tailscale-User-Login": "  " },
    })).json();
    assert.equal(blank.identified, false, "an empty header is no identity here either");
  } finally {
    await view.close();
  }
});

test("startLiveView: /api/review carries the two subscription meters for the page to show", async () => {
  const recordHome = tempRecordHome();
  await deliveredTask(recordHome);
  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const body = await (await fetch(`http://127.0.0.1:${view.port}/api/review`)).json();
    assert.equal(typeof body.meters.label, "string");
    assert.equal(typeof body.meters.paused, "boolean");
    assert.equal(typeof body.meters.detail, "string");
  } finally {
    await view.close();
  }
});
