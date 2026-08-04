# Fabrica — Phase 0

![The loop](loop.svg)

This repository currently contains **no tool**. It contains the answer key.

- `CONTRACT.md` — the rules the tool can never break, in plain language.
- `contract/` — the same rules as runnable tests. This is the enforcement.
- `SPEC.md` — the blueprint for version one.
- `ROADMAP.md` — the path from here to Amy.

To see the current state:

    npm install
    npm test

Expected today: **17 failing** (every one says "fabrica is not built yet
(Phase 1)") and **2 passing** — the watchdog proving the answer key
itself is whole, and one scan that stays vacuously true until `src/`
exists.

Phase 1 has exactly one definition of done: every test above turns green.
