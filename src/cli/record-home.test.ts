import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveRecordHome } from "./record-home.ts";

test("resolveRecordHome: defaults to ~/.fabrica when FABRICA_HOME is unset", () => {
  assert.equal(resolveRecordHome({}), join(homedir(), ".fabrica"));
});

test("resolveRecordHome: FABRICA_HOME overrides the default", () => {
  assert.equal(resolveRecordHome({ FABRICA_HOME: "/tmp/custom-home" }), "/tmp/custom-home");
});

test("resolveRecordHome: a blank FABRICA_HOME is treated as unset", () => {
  assert.equal(resolveRecordHome({ FABRICA_HOME: "   " }), join(homedir(), ".fabrica"));
});
