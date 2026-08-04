# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- `CONTRACT.md` and everything under `contract/` are the ratified answer key: never edit them. It is intentionally red until Phase 1 (see README.md and issue #15) — a red `npm test` is expected, not a bug.
- `npm test` runs every `*.test.ts` under `contract/` (the answer key, do not touch) and `src/`, at any depth - discovery is a `find`, not a shell glob, so a nested test file is never silently skipped. When adding a feature, colocate its test next to the source file it covers (`foo.ts` + `foo.test.ts`), matching how `contract/` colocates one test file per rule.
- Module layout under `src/<feature>/`: `types.ts` (shapes), `errors.ts` (a typed error class with a `code` for branching, message written to be shown to the Client verbatim), one file per behavior (e.g. `load.ts`, `registry.ts`), an `index.ts` barrel, and a `helpers/` subfolder for test-only fixtures. See `src/config/` as the reference example.
- The record home (`~/.fabrica` by default) is never hardcoded past the outermost CLI layer — every function that touches it takes `home: string` as an explicit parameter, so parallel workers/tests never share state. Tests use throwaway temp dirs (`mkdtempSync`), never the real home.
- Use LANGUAGE.md's vocabulary (Client, Factory, ProductionLine, Foreman, Worker, task, checks, delivery, verdict, caps) in code and messages — don't invent synonyms.
- `contract/surface.ts` declares the seams Phase 1 must implement (`createFabrica`, `Delivery`, etc.); read it before adding a module that will eventually back one of those seams.
- `src/record/` (issue #3) is the append-only event log (`events.jsonl`) plus per-task folders; its structural append-only proof spawns real `tsx` child processes (see `src/record/helpers/concurrent-append-worker.ts`) rather than interleaving async calls in one process, since only genuine OS-level concurrency can prove a write can't be torn. Reuse that pattern for any other append-only file (e.g. `transcript.log`).
- On macOS, `os.tmpdir()` resolves through a `/var` -> `/private/var` symlink. Any code or test that computes a path under a temp dir and later compares it against a `realpathSync`'d value (as `src/line` does for its worktree paths) must compare against the realpath'd form on both sides, or the comparison spuriously fails.
- `src/line/` (ProductionLine: cutting/tearing down the throwaway git worktree per task) is the reference example for path-safety code: never delete or write to a path without first proving via `git worktree list` that it's the exact throwaway path expected, not a live checkout.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
