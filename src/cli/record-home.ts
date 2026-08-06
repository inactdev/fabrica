// Where the record lives, for the one caller allowed to assume a default
// (AGENTS.md: "the record home is never hardcoded past the outermost CLI
// layer" - this file is that layer). SPEC.md: "~/.fabrica/ (path
// configurable)"; FABRICA_HOME is that configuration knob.

import { homedir } from "node:os";
import { join } from "node:path";

export function resolveRecordHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FABRICA_HOME;
  if (override !== undefined && override.trim().length > 0) return override;
  return join(homedir(), ".fabrica");
}
