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
