import { test } from "node:test";
import assert from "node:assert/strict";
import { caffeinated } from "./caffeinate.ts";

test("caffeinated: on darwin, wraps the command with caffeinate -i -s", () => {
  const result = caffeinated("docker", ["run", "--rm", "alpine"], "darwin");
  assert.deepEqual(result, { command: "caffeinate", args: ["-i", "-s", "docker", "run", "--rm", "alpine"] });
});

test("caffeinated: on linux, the command and args are returned unchanged", () => {
  const result = caffeinated("docker", ["run", "--rm", "alpine"], "linux");
  assert.deepEqual(result, { command: "docker", args: ["run", "--rm", "alpine"] });
});

test("caffeinated: on win32, the command and args are returned unchanged", () => {
  const result = caffeinated("docker", ["run"], "win32");
  assert.deepEqual(result, { command: "docker", args: ["run"] });
});

test("caffeinated: defaults to this process's own platform when none is given", () => {
  const result = caffeinated("docker", ["run"]);
  if (process.platform === "darwin") {
    assert.deepEqual(result, { command: "caffeinate", args: ["-i", "-s", "docker", "run"] });
  } else {
    assert.deepEqual(result, { command: "docker", args: ["run"] });
  }
});
