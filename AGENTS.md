# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- `CONTRACT.md` and everything under `contract/` are the ratified answer key: never edit them. It is intentionally red until Phase 1 (see README.md and issue #15) — a red `npm test` is expected, not a bug.
- `npm test` runs both `contract/*.test.ts` (the answer key, do not touch) and `src/**/*.test.ts` (real source tests). When adding a feature, colocate its test next to the source file it covers (`foo.ts` + `foo.test.ts`), matching how `contract/` colocates one test file per rule.
- Module layout under `src/<feature>/`: `types.ts` (shapes), `errors.ts` (a typed error class with a `code` for branching, message written to be shown to the Client verbatim), one file per behavior (e.g. `load.ts`, `registry.ts`), an `index.ts` barrel, and a `helpers/` subfolder for test-only fixtures. See `src/config/` as the reference example.
- The record home (`~/.fabrica` by default) is never hardcoded past the outermost CLI layer — every function that touches it takes `home: string` as an explicit parameter, so parallel workers/tests never share state. Tests use throwaway temp dirs (`mkdtempSync`), never the real home.
- Use LANGUAGE.md's vocabulary (Client, Factory, ProductionLine, Foreman, Worker, task, checks, delivery, verdict, caps) in code and messages — don't invent synonyms.
- `contract/surface.ts` declares the seams Phase 1 must implement (`createFabrica`, `Delivery`, etc.); read it before adding a module that will eventually back one of those seams.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
