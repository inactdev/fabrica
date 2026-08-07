export { checkForOffBooksChanges } from "./check.ts";
export { detectUnattributedChange } from "./detect.ts";
export { readProjectGitState } from "./git-state.ts";
export { readBaseline, writeBaseline } from "./baseline.ts";
export { recordBlockedEditAttempt } from "./blocked-edit.ts";
export type { BlockedEditAttempt } from "./blocked-edit.ts";
export type { ProjectGitState } from "./types.ts";
