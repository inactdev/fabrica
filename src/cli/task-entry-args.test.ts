// The argv contract between spawn-detached.ts and the detached task
// runner. Small, but it crosses a process boundary: nothing downstream
// can tell a shifted positional from a deliberate value, which is why
// the optional values are named flags (issue #184 added the second one).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTaskEntryArgs, taskEntryFlags } from "./task-entry-args.ts";

/** argv as a child really receives it: node, the script, then the args. */
function argv(...args: string[]): string[] {
  return ["/path/to/node", "/path/to/run-task-entry.ts", ...args];
}

test("parseTaskEntryArgs: the three positionals alone", () => {
  assert.deepEqual(parseTaskEntryArgs(argv("/home", "/proj", "do the thing")), {
    recordHome: "/home",
    projectPath: "/proj",
    taskText: "do the thing",
  });
});

test("parseTaskEntryArgs: either optional flag, both, or neither - order does not matter", () => {
  assert.deepEqual(parseTaskEntryArgs(argv("/home", "/proj", "t", "--model", "small-5")), {
    recordHome: "/home",
    projectPath: "/proj",
    taskText: "t",
    model: "small-5",
  });
  // The case a trailing-positional shape could not express: a model with
  // no issue, which is why these are named.
  assert.deepEqual(parseTaskEntryArgs(argv("/home", "/proj", "t", "--model", "small-5", "--issue", "184")), {
    recordHome: "/home",
    projectPath: "/proj",
    taskText: "t",
    issue: "184",
    model: "small-5",
  });
  assert.deepEqual(parseTaskEntryArgs(argv("/home", "/proj", "t", "--issue", "184")), {
    recordHome: "/home",
    projectPath: "/proj",
    taskText: "t",
    issue: "184",
  });
  // All three spellings of `--issue` cross the process boundary as the
  // text the Client typed - nothing here re-derives a number, so a
  // repository-naming spelling is never flattened on the way through.
  assert.deepEqual(parseTaskEntryArgs(argv("/home", "/proj", "t", "--issue", "inactdev/inspector#7")), {
    recordHome: "/home",
    projectPath: "/proj",
    taskText: "t",
    issue: "inactdev/inspector#7",
  });
});

test("parseTaskEntryArgs: --file is the one repeatable flag, and keeps its order", () => {
  assert.deepEqual(
    parseTaskEntryArgs(argv("/home", "/proj", "t", "--file", "/docs/pots.md", "--file", "/docs/data.csv")),
    {
      recordHome: "/home",
      projectPath: "/proj",
      taskText: "t",
      files: ["/docs/pots.md", "/docs/data.csv"],
    }
  );
  // Mixed in with the others, in any order - the whole reason these are
  // named flags rather than positionals.
  assert.deepEqual(
    parseTaskEntryArgs(argv("/home", "/proj", "t", "--file", "/docs/pots.md", "--issue", "325", "--model", "small-5")),
    {
      recordHome: "/home",
      projectPath: "/proj",
      taskText: "t",
      issue: "325",
      model: "small-5",
      files: ["/docs/pots.md"],
    }
  );
});

test("parseTaskEntryArgs: a path is carried through untrimmed - a trailing space can be part of a file name", () => {
  assert.deepEqual(parseTaskEntryArgs(argv("/home", "/proj", "t", "--file", "/docs/odd name .md")).files, [
    "/docs/odd name .md",
  ]);
});

test("parseTaskEntryArgs: a wrong shape throws rather than running the task on a guess", () => {
  assert.throws(() => parseTaskEntryArgs(argv("/home", "/proj")), /expected <recordHome>/);
  assert.throws(() => parseTaskEntryArgs(argv("/home", "/proj", "t", "--model")), /"--model" was given no value/);
  assert.throws(() => parseTaskEntryArgs(argv("/home", "/proj", "t", "--issue", "  ")), /"--issue" was given no value/);
  assert.throws(() => parseTaskEntryArgs(argv("/home", "/proj", "t", "--file")), /"--file" was given no value/);
  assert.throws(() => parseTaskEntryArgs(argv("/home", "/proj", "t", "--file", "")), /"--file" was given no value/);
  assert.throws(() => parseTaskEntryArgs(argv("/home", "/proj", "t", "--wat", "x")), /unknown argument "--wat"/);
});

test("taskEntryFlags: what the spawner appends is exactly what the parser reads back", () => {
  assert.deepEqual(taskEntryFlags({}), []);
  assert.deepEqual(taskEntryFlags({ issue: 7, model: "small-5" }), ["--issue", "7", "--model", "small-5"]);

  const flags = taskEntryFlags({ model: "small-5" });
  assert.deepEqual(parseTaskEntryArgs(argv("/home", "/proj", "t", ...flags)), {
    recordHome: "/home",
    projectPath: "/proj",
    taskText: "t",
    model: "small-5",
  });

  // One pair per file, and the round trip back out again - a path is
  // exactly the kind of value a delimited single flag would mangle.
  assert.deepEqual(taskEntryFlags({ files: [] }), []);
  assert.deepEqual(taskEntryFlags({ files: ["/docs/a.md", "/docs/b,c.md"] }), [
    "--file",
    "/docs/a.md",
    "--file",
    "/docs/b,c.md",
  ]);
  assert.deepEqual(
    parseTaskEntryArgs(argv("/home", "/proj", "t", ...taskEntryFlags({ issue: 325, files: ["/docs/b,c.md"] }))),
    { recordHome: "/home", projectPath: "/proj", taskText: "t", issue: "325", files: ["/docs/b,c.md"] }
  );
});
