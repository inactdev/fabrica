// Throwaway fixtures for ProductionLine tests: a project to cut lines from
// (reusing contract/helpers/fixture.ts's own repo builder and fingerprint,
// so our tests prove the exact same byte-for-byte invariant rule 1 does)
// plus a fresh record home to cut them into.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export { makeFixtureRepo as makeFixtureProject, fingerprint } from "../../../contract/helpers/fixture.ts";

export function makeFixtureHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-line-home-"));
}
