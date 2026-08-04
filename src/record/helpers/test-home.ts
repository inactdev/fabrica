// Throwaway record homes for record tests — never the real ~/.fabrica,
// exactly as src/config/helpers/test-home.ts throws away config homes.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Makes a fresh, empty temp home for the record layer to write into. */
export function makeTestHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-record-test-"));
}
