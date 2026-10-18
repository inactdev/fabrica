// `fabrica doctor`'s relay-image line (issue #186). The probe itself is
// injected, so no test here depends on what this machine happens to
// have pulled.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RELAY_IMAGE } from "./launch.ts";
import { relayImageStatus } from "./doctor-check.ts";

test("relay image: present is OK, and names the exact image a task's relay runs", () => {
  const asked: string[] = [];
  const status = relayImageStatus((image) => {
    asked.push(image);
    return true;
  });

  assert.equal(status.ok, true);
  assert.deepEqual(asked, [RELAY_IMAGE], "the check must ask about the image launch.ts actually runs");
  assert.match(status.detail, /sha256:/);
});

test("relay image: missing is a failure, with the exact pull command as the fix", () => {
  const status = relayImageStatus(() => false);

  assert.equal(status.ok, false);
  assert.match(status.detail, /no task's relay can start/);
  assert.equal(status.fix, `docker pull ${RELAY_IMAGE}`);
});
