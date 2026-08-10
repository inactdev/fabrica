import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "./main.ts";

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

test("main: no command prints top-level help to stderr and exits 1", async () => {
  const io = captureIo();
  const code = await main([], io);
  assert.equal(code, 1);
  assert.equal(io.out.length, 0);
  assert.match(io.err[0], /Usage: fabrica/);
});

test("main: --help prints top-level help to stdout and exits 0", async () => {
  const io = captureIo();
  const code = await main(["--help"], io);
  assert.equal(code, 0);
  assert.match(io.out[0], /Usage: fabrica/);
});

test("main: -h is the same as --help", async () => {
  const io = captureIo();
  const code = await main(["-h"], io);
  assert.equal(code, 0);
  assert.match(io.out[0], /Usage: fabrica/);
});

test("main: an unknown command refuses with exact instructions and exits 1", async () => {
  const io = captureIo();
  const code = await main(["bogus"], io);
  assert.equal(code, 1);
  assert.match(io.err[0], /unknown command "bogus"/);
  assert.match(io.err[0], /Usage: fabrica/);
});

test("main: `do --help` prints the do command's own usage and exits 0, without running anything", async () => {
  const io = captureIo();
  const code = await main(["do", "--help"], io);
  assert.equal(code, 0);
  assert.match(io.out[0], /fabrica do "<task text>"/);
});

test("main: `do -h` also short-circuits to help", async () => {
  const io = captureIo();
  const code = await main(["do", "fix it", "-h"], io);
  assert.equal(code, 0);
  assert.match(io.out[0], /fabrica do "<task text>"/);
});

test("main: `verdict --help` prints the verdict command's own usage and exits 0, without running anything", async () => {
  const io = captureIo();
  const code = await main(["verdict", "--help"], io);
  assert.equal(code, 0);
  assert.match(io.out[0], /fabrica verdict <taskId>/);
});

test("main: `verdict -h` also short-circuits to help", async () => {
  const io = captureIo();
  const code = await main(["verdict", "some-task", "-h"], io);
  assert.equal(code, 0);
  assert.match(io.out[0], /fabrica verdict <taskId>/);
});

test("main: top-level help mentions the verdict command", async () => {
  const io = captureIo();
  const code = await main(["--help"], io);
  assert.equal(code, 0);
  assert.match(io.out[0], /verdict <taskId>/);
});

test("main: top-level help mentions the answer command", async () => {
  const io = captureIo();
  const code = await main(["--help"], io);
  assert.equal(code, 0);
  assert.match(io.out[0], /answer <taskId>/);
});

test("main: `answer --help` prints the answer command's own usage and exits 0, without running anything", async () => {
  const io = captureIo();
  const code = await main(["answer", "--help"], io);
  assert.equal(code, 0);
  assert.match(io.out[0], /fabrica answer <taskId>/);
});

test("main: `answer -h` also short-circuits to help", async () => {
  const io = captureIo();
  const code = await main(["answer", "some-task", "-h"], io);
  assert.equal(code, 0);
  assert.match(io.out[0], /fabrica answer <taskId>/);
});

test("main: `answer` with bad usage refuses without touching the record", async () => {
  const io = captureIo();
  const code = await main(["answer"], io);
  assert.equal(code, 1);
  assert.match(io.err[0], /<taskId>/);
});

test("main: top-level help mentions status, log, and watch", async () => {
  const io = captureIo();
  const code = await main(["--help"], io);
  assert.equal(code, 0);
  assert.match(io.out[0], /status\n/);
  assert.match(io.out[0], /log <taskId>/);
  assert.match(io.out[0], /watch <taskId>/);
});

test("main: `status --help` prints the status command's own usage and exits 0, without running anything", async () => {
  const io = captureIo();
  const code = await main(["status", "--help"], io);
  assert.equal(code, 0);
  assert.match(io.out[0], /Usage: fabrica status/);
});

test("main: `log --help` prints the log command's own usage and exits 0, without running anything", async () => {
  const io = captureIo();
  const code = await main(["log", "--help"], io);
  assert.equal(code, 0);
  assert.match(io.out[0], /fabrica log <taskId>/);
});

test("main: `log -h` also short-circuits to help", async () => {
  const io = captureIo();
  const code = await main(["log", "some-task", "-h"], io);
  assert.equal(code, 0);
  assert.match(io.out[0], /fabrica log <taskId>/);
});

test("main: `watch --help` prints the watch command's own usage and exits 0, without running anything", async () => {
  const io = captureIo();
  const code = await main(["watch", "--help"], io);
  assert.equal(code, 0);
  assert.match(io.out[0], /fabrica watch <taskId>/);
});

// Client ruling on issue #12's watch-help-overstates-streaming finding:
// the first thing read must describe what the screen actually looks
// like - heartbeats live, transcript in batches - not word-by-word
// streaming that never happens.
test("main: `watch --help` opens with an accurate description, not a word-by-word streaming promise", async () => {
  const io = captureIo();
  await main(["watch", "--help"], io);
  assert.match(io.out[0], /Heartbeats appear as they happen/);
  assert.match(io.out[0], /transcript arrives in a batch/);
  assert.doesNotMatch(io.out[0], /[Ss]treams? .*live/);
});

test("main: `watch -h` also short-circuits to help", async () => {
  const io = captureIo();
  const code = await main(["watch", "some-task", "-h"], io);
  assert.equal(code, 0);
  assert.match(io.out[0], /fabrica watch <taskId>/);
});
