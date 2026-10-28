// Issue #204's amendment asks for the skip-rule counts "on the live view
// header, not just `fabrica status`". Two halves, both checked here: the
// server putting the line in the state it serves, and the page putting
// that line on the header - driven through the same FakeDocument the
// page-scripts tests use, so "it renders" is observed rather than assumed
// from reading app.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { createForeman, shadowCountsLine, SKIP_RULES_PATH } from "../../src/index.ts";
import { eventsByTask } from "../../src/index.ts";
import { fakeBrain } from "../../src/brain/helpers/fake-brain.ts";
import { makeFixtureRepo, pushToOrigin } from "../../contract/helpers/fixture.ts";
import { fakeInspector } from "../../contract/helpers/fake-inspector.ts";
import { createRecordView } from "./record-view.ts";
import { FakeDocument } from "./helpers/load-time-dom.ts";

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

const DOCS_ONLY = `version = 1

[kinds.docs-only]
description = "A documentation-only change under docs/"
mode = "shadow"
allowedFolders = ["docs"]
maxFiles = 3
inspectorGreen = true
`;

async function homeWithOneWouldClose(): Promise<string> {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-live-shadow-"));
  const project = makeFixtureRepo("exit 0");
  mkdirSync(dirname(join(project, SKIP_RULES_PATH)), { recursive: true });
  writeFileSync(join(project, SKIP_RULES_PATH), DOCS_ONLY);
  execFileSync("git", ["add", "-A"], { cwd: project });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "skip rules"], { cwd: project });
  pushToOrigin(project);

  await createForeman({ recordHome, inspector: fakeInspector("green") }).do("tidy the intro", {
    project,
    brain: fakeBrain({
      onWork: (_brief, workdir) => {
        mkdirSync(join(workdir, "docs"), { recursive: true });
        writeFileSync(join(workdir, "docs", "intro.md"), "tidier\n");
      },
    }),
  });
  return recordHome;
}

test("the served state carries the same shadow line fabrica status shows, from the same function", async () => {
  const recordHome = await homeWithOneWouldClose();
  const state = createRecordView(recordHome).getState();
  assert.ok(state.shadow !== null, "the live view state carried no shadow line");
  assert.match(state.shadow, /shadow, nothing closes/);
  assert.match(state.shadow, /1 would have closed/);
  // Byte-identical to what the terminal prints for the same record, which
  // is the point of both surfaces calling one function.
  assert.equal(state.shadow, shadowCountsLine(eventsByTask(recordHome), state.now));
});

test("a record home with no skip rules serves no shadow line at all", () => {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-live-shadow-none-"));
  assert.equal(createRecordView(recordHome).getState().shadow, null);
});

/** index.html plus app.js, evaluated the way the page runs them, with just
 * enough browser around them for the render to be observable. */
function loadIndexPage(): { document: FakeDocument; render: (state: unknown) => void } {
  const document = new FakeDocument(readFileSync(join(PUBLIC_DIR, "index.html"), "utf8"));
  document.indexTree(document.documentElement);
  let timerId = 0;
  const context = createContext({
    document,
    location: { pathname: "/", href: "http://127.0.0.1:7777/", search: "", hash: "" },
    // Never settles: a just-loaded page is exactly a page with one
    // request in flight, and a stub that resolved would run every
    // renderer against invented data.
    fetch: () => new Promise(() => {}),
    setInterval: () => ++timerId,
    clearInterval: () => {},
    setTimeout: () => ++timerId,
    clearTimeout: () => {},
    queueMicrotask,
    console,
    addEventListener: () => {},
    removeEventListener: () => {},
    scrollTo: () => {},
    scrollY: 0,
    innerHeight: 900,
    innerWidth: 1400,
  });
  runInContext(readFileSync(join(PUBLIC_DIR, "banner.js"), "utf8"), context, { filename: "banner.js" });
  runInContext(readFileSync(join(PUBLIC_DIR, "app.js"), "utf8"), context, { filename: "app.js" });
  return {
    document,
    render: (state) => {
      (context as { __state?: unknown }).__state = state;
      runInContext("renderTasks(__state)", context, { filename: "render" });
    },
  };
}

const EMPTY_SPEND = {
  dailyUsd: 0,
  dailyLabel: "$0.00",
  dailySubscriptionUsd: 0,
  dailySubscriptionLabel: "$0.00",
};

test("the header shows the shadow line the server sent", () => {
  const page = loadIndexPage();
  const element = page.document.getElementById("shadow");
  assert.ok(element, "index.html has no #shadow element for the counts to land in");

  page.render({ now: Date.now(), spend: EMPTY_SPEND, shadow: "skip rules (shadow, nothing closes): 3 would have closed", tasks: [] });
  assert.equal(element.textContent, "skip rules (shadow, nothing closes): 3 would have closed");
  assert.equal(element.hidden, false);
});

test("the header stays hidden and empty when the server sends no shadow line", () => {
  const page = loadIndexPage();
  const element = page.document.getElementById("shadow");
  assert.ok(element);
  // Hidden in the markup to begin with, so an opted-out record home never
  // flashes an empty row before the first poll lands.
  assert.equal(element.hidden, true);

  page.render({ now: Date.now(), spend: EMPTY_SPEND, shadow: null, tasks: [] });
  assert.equal(element.textContent, "");
  assert.equal(element.hidden, true);
});

test("a state from a server that predates this field renders no header line rather than 'undefined'", () => {
  const page = loadIndexPage();
  const element = page.document.getElementById("shadow");
  assert.ok(element);
  page.render({ now: Date.now(), spend: EMPTY_SPEND, tasks: [] });
  assert.equal(element.textContent, "");
  assert.equal(element.hidden, true);
});
