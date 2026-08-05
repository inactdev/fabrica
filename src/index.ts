// Fabrica's single public entry point (issue #45). contract/*.test.ts, and
// any future CLI (issue #47), import the real implementation from here
// rather than reaching into src/foreman or any other internal module
// directly — so internal restructuring never touches the ratified
// contract tests' imports.

export { createFabrica } from "./foreman/index.ts";
export type { FabricaOptions } from "./foreman/index.ts";
export type { Fabrica } from "../contract/surface.ts";
export { ForemanError } from "./foreman/index.ts";
export type { ForemanErrorCode } from "./foreman/index.ts";
export { DEFAULT_ATTEMPTS } from "./foreman/index.ts";
export { DEFAULT_CHECK_COMMAND } from "./foreman/index.ts";
