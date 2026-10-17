# Issue #200: the direct-API worker, and two things worth keeping

## The adapter

`src/brain/adapters/openai-compatible.ts` plus `openai-agent/` is the
first direct API adapter: any OpenAI-compatible chat-completions
endpoint, with the agent loop running as plain `.mjs` *inside* the
worker's box (staged read-only at `/fabrica-agent` from a throwaway copy
of only the `.mjs` files, run with the worker image's stock `node`) and
reporting NDJSON on stdout, which the host maps to live transcript
entries. Everything about why it is shaped this way - the cap's exact
semantics, the two named targets, which vendor document each wire detail
came from, and the three things that still need the Client's own machine
- is in `openai-compatible.md`, and that file is the one to read before
touching any of it. Two rulings it encodes that are easy to undo by
accident:

- **A dollar figure never comes from a price table in this repo.** Cost
  is either the provider's own per-call `usage.cost` (`costSource:
  "reported"`) or a genuine `$0.00` on a server the Client runs
  themselves (`"free"`). A stale per-million-token table would not fail
  loudly; it would report invented money as `costBasis: "metered"`,
  which is the one thing rule 10 exists to stop. A `"reported"` target
  that answers with no cost is an unknown, never a zero.
- **No cap, no run.** `work()` throws before any container, relay or API
  call when `maxSpendUsd` is absent, naming `[caps].perTaskUsd`; the
  in-box agent refuses again before its first call, so starting it by
  hand cannot spend uncapped money either. The cap is metered as the
  round goes and stops at the first call that crosses it (overshooting
  by at most one call), returning what was done with a
  `budget-exhausted` entry rather than throwing.

## `FABRICA_BRAIN`: there is now a brain to choose

`src/brain/adapters/index.ts` is no longer a seam with one option.
`selectedBrain(env, recordHome)` picks the adapter from
`FABRICA_BRAIN` - unset means exactly the old behaviour - and reads
every setting from Fabrica's environment first, then from
`<recordHome>/brain.env` (`brainEnvValue`, the same mode-600 rule
`credentialEnvFrom` enforces, but a missing line is "not configured"
rather than a refusal). `defaultBrainAdapter`'s `name`/`model` are
getters now, so a receipt names whichever brain actually ran.

Consequence worth remembering: **a second brain means every
brain-specific check has two answers.** `fabrica doctor`'s worker-token
check and its `--live` probe both branch on the selection now
(`doctor-checks.ts`), because reporting a missing CLI token as a FAIL to
a Client who switched brains would stop `fabrica up` over a credential
they are not using. Anything else added in that shape needs the same
treatment.

## Working inside a worker box: what is actually reachable

Written while running as a Fabrica Worker, so these are observed facts
about this fleet's own boxes, not guesses:

- The box's egress is its relay, and the relay's tunnel allowlist is
  GitHub only. `registry.npmjs.org` is refused, so **`npm install` fails
  inside a worker box** - which means `node_modules` is absent and
  `npm test` cannot run: no `tsc --noEmit` (no typescript on disk) and
  no `tsx`.
- What works instead: `node --test <file>.test.ts` directly. Node 24
  strips types natively and the repo already imports with explicit
  `.ts` extensions, so the fast suite runs. Every test that reaches
  `src/index.ts` still fails in there for one unrelated reason - the
  real `smol-toml` dependency is missing - which is worth knowing before
  reading a red run as a regression.
- Documentation *is* reachable, through `api.github.com`, for anything a
  vendor publishes in a public repository (OpenRouter's docs are
  `OpenRouterTeam/docs`; Ollama's are in `ollama/ollama` under `docs/`).
  `raw.githubusercontent.com` is refused, but the Contents API serves
  file bodies base64-encoded, and `api.github.com/repos/<o>/<r>/issues/<n>`
  serves an issue's own text. A small Node script that CONNECTs through
  `$HTTPS_PROXY` and then `tls.connect`s is enough to read any of it -
  there is no `curl`, no `python3`, and `node`'s `fetch` ignores the
  proxy variables.
