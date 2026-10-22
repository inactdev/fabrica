// The shapes of a settled reviewer. Internal to src/ - nothing here is
// a promise Fabrica makes the Client, so none of it belongs in
// contract/surface.ts; `[reviewer]`'s own written-down shape
// (ReviewerConfig) lives with the rest of projects.toml, in src/config.

/** A reviewer settled enough to be handed to Inspector: the two flags,
 * plus the environment Inspector reads the credential back out of. */
export interface ResolvedReviewer {
  vendor: string;
  model: string;
  /** `<VENDOR>_API_KEY` and its value - set on the Inspector child's
   * environment only, never printed and never put in Fabrica's own. */
  apiKeyVar: string;
  apiKey: string;
  /** `<VENDOR>_BASE_URL`, when the Client set one. Inspector reads it
   * for any vendor other than its own default; Fabrica forwards it when
   * it is there and never demands it, since which vendors need one is
   * Inspector's knowledge, not Fabrica's. */
  baseUrlVar: string;
  baseUrl?: string;
}

/** The three answers "who reviews this project" can have. `none` is the
 * ordinary case for a project whose `.inspector.json` declares no
 * `testPaths`: nothing configured, nothing required, Inspector called
 * exactly as it was before. */
export type ReviewerResolution =
  | { kind: "none" }
  | { kind: "reviewer"; reviewer: ResolvedReviewer }
  | { kind: "refused"; message: string };
