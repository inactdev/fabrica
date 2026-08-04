# Fabrica - Phase 1, in progress

![The loop](loop.svg)

The answer key was committed first. The tool is now being built against it.

- `CONTRACT.md` - the rules the tool can never break, in plain language.
- `contract/` - the same rules as runnable tests. This is the enforcement.
- `SPEC.md` - the blueprint for version one.
- `ROADMAP.md` - the path from here to Amy.
- `src/` - the tool itself, as far as it has been built.

To see the current state:

    npm install
    npm test

Expected today: **red**, on purpose. `npm test` runs the contract suite
together with the tool's own tests. Most contract tests still say "fabrica
is not built yet (Phase 1)" - they reach for parts that do not exist yet.
Two never depended on the tool at all and pass from the start: the
watchdog proving the answer key itself is whole, and a scan of `src/` for
hardcoded model names. Run the command for today's exact tally - it is
meant to move with every issue closed, so it is not quoted here.

Phase 1 has exactly one definition of done: every contract test turns green.
