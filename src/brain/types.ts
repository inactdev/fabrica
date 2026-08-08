// The brain socket (CONTRACT rule 8: "No favorite brain"). Declared once
// in contract/surface.ts (issue #45) and re-exported here as a type only -
// `import type` is erased at compile time, so this creates no runtime
// dependency on contract/. This is the ONLY interface a Worker's model
// plugs into; nothing past this file may know which brain is behind it.

export type { Brain, BrainAskResult, BrainWorkOptions, BrainWorkResult, TranscriptEntry } from "../../contract/surface.ts";
