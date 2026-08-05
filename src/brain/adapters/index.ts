// The one place outside claude-code.ts itself allowed to name it (this
// directory is exempt from rule8.no-favorite-brain's scan). Picks which
// written adapter backs `defaultBrainAdapter()` - v1 has exactly one
// (adapters/README.md's "v1 ordering"), so there is no real selection
// logic yet, only a seam for src/brain/index.ts to re-export without
// naming a vendor itself.

import { claudeCodeAdapter } from "./claude-code.ts";
import type { Brain } from "../types.ts";

export function defaultBrainAdapter(): Brain {
  return claudeCodeAdapter();
}
