# `direct-api/`

The first direct-API adapter family (issue #200, ROADMAP.md's "per-token
API pipes stay closed unless he deliberately opens one, behind a cap
that can be zero"). Two factories, `openRouterAdapter(opts)` and
`ollamaAdapter(opts)`, both satisfying `Brain` and both backed by the
exact same loop (`worker-loop.mjs`) - they differ only in which
OpenAI-compatible endpoint they point at and whether a request carries
an API key.

## Why there's no existing binary to wrap

`adapters/README.md`'s "Two families of adapter" section states the
asymmetry plainly: a CLI adapter hands a brief to a coding-agent program
that already exists and does its own file/shell work. A direct-API
adapter talks straight to a model's chat-completions endpoint, which
only returns text and tool-call requests - reading files, writing them,
and running commands against `workdir` has to be code this adapter
itself runs. `worker-loop.mjs` is that code: a small, standalone
read_file/write_file/run_command/submit_writeup tool-calling loop against
an OpenAI-compatible `/chat/completions` endpoint.

## One container call, not one per tool

`claude-code.ts` runs the whole `claude` binary - prompting, tool use,
and all - inside a single `runContained` call per `work()`/`ask()`.
This family keeps that same shape rather than running the loop on the
host and shelling out to `runContained` separately for each individual
tool call: the model call itself is part of the Worker's own work, not
merely orchestration plumbing around it, so it belongs inside the
sandbox too. Concretely, `worker-loop.mjs` is a real, independently
runnable, dependency-free Node ESM script (no imports from this project
at all, since nothing but Node itself is guaranteed to exist inside the
container) that `index.ts` shadow-mounts into the container at a fixed
path (`readOnlyMounts`'s `{ source, target }` form - the same mechanism
`resolveGitMounts` uses to shadow a sanitized git config) and runs with
plain `node`. Mounting the real file, rather than passing its source as
a `node -e` string, is also what lets `worker-loop.test.ts` exercise the
identical file directly with a bare `node` process and no Docker at all
- nothing is lost between what's tested and what actually runs.

Network is allowed for every call (`ask()` and `work()` alike): the one
thing either needs the network for is reaching the configured model API.
`workdir` is still the only writable mount, same as the reference
adapter.

## The protocol between `index.ts` and `worker-loop.mjs`

Config travels in as a single JSON blob on `DIRECT_API_INPUT` (never a
`node -e` argument or a file written into `workdir`, so nothing leaks
into the delivered diff): `mode` (`"ask"` or `"work"`), `brief`, `model`,
`baseUrl`, `backendName` (`"openrouter"` or `"ollama"` - decides whether
a response's missing cost field means "unknown" or a real zero, see
below), `maxSpendUsd`, and `hasSession`. The one secret, the API key,
rides a separate env var, `DIRECT_API_KEY`, so it never ends up
embedded inside a blob that might get echoed anywhere for debugging.

The script talks back over stdout only, newline-delimited JSON: one
`{"type":"entry","entry":{...}}` line per `TranscriptEntry` as it
happens (read live by `index.ts`'s own `onStdout` handler and handed to
`emitLiveTranscriptEntry`, issue #70, exactly like the reference
adapter's own line feeder), then exactly one final `{"type":"result",
...}` line - shaped differently for `ask` (`questions`, `costUsd`) and
`work` (`writeup`, `gateChanges`, `session`). A fatal error (the HTTP
call itself failing, an unparseable response) writes to stderr and exits
non-zero instead; `index.ts` treats a non-zero exit, or exit 0 with no
`result` line, as `DirectApiError("script-failed", ...)`.

## The tool-calling loop

Four tools, offered on every `work()` turn: `read_file`, `write_file`,
`run_command` (a real `bash -c` in the project root), and
`submit_writeup` - the structured write-up every worker must return
(CONTRACT rule 11's standing-question notice, already baked into
`brief` by `src/foreman/standing-question.ts` before this adapter ever
sees it, tells the model this in adapter-neutral words; `submit_writeup`
is this family's own mechanism for it, the direct-API equivalent of the
reference adapter's `--json-schema` flag). The loop ends the moment a
turn's tool calls include `submit_writeup`; a turn with no tool calls at
all gets one nudge ("call a tool, or call submit_writeup") before the
loop gives up with no write-up, same as running out of `MAX_TURNS` (40)
does - either way, a missing write-up is exactly what makes the
Foreman's own `pr-body.ts` mark the attempt red without ever handing it
to Inspector, the same path a CLI adapter's own missing structured
output takes.

Tool execution has no extra path-jail logic beyond what the container
already guarantees: `workdir` is the only writable thing bind-mounted in
at all, so a path that tries to escape it resolves to nothing the
container can see, never something on the real host.

## Warm sessions

No server-side session concept exists on either backend's HTTP surface
- a resume has to be the adapter's own doing. The full OpenAI-style
message history is persisted as one JSON file under `$HOME`
(`worker-loop.mjs`'s `SESSION_FILE_NAME`), using the exact same
mechanism the reference adapter's own `--resume` relies on:
`index.ts` mounts `${realWorkdir}.fabrica-direct-api-session` (its own
suffix, so the two adapters' state never collides if ever pointed at the
same workdir) as the container's `$HOME`, which is what actually
survives across separate, otherwise-fresh `runContained` calls.
`hasSession` (true only when `BrainWorkOptions.session` was actually
passed) decides whether the script loads that file at all - a brand
new attempt never accidentally inherits leftover state.

## Cost: OpenRouter's `usage.cost`, and Ollama's real, known zero

Both backends speak the same OpenAI-compatible shape, so `usageEntry()`
lives in one place. OpenRouter's documented behavior (verified against
its own current docs, not guessed, per the standing question every brief
carries): `usage.cost` is included automatically in every response now,
no special request parameter needed, so a response that still omits it
is treated as genuinely unknown - never zero, per CONTRACT rule 10. A
local Ollama call costs nothing to run, which is categorically different
from "the provider didn't say" - `backendName === "ollama"` reports a
real, known `0`, always `costBasis: "metered"` (issue #188: it's real
money, zero of it, never a notional subscription estimate).
`maxSpendUsd` (the per-task cap's own remaining-budget hint,
`BrainWorkOptions`) is honored on a best-effort basis: the loop checks
its own running total before each new turn and stops rather than
starting one that would exceed it - the Foreman's own post-attempt check
is still the guaranteed stop either way.

## `requiresPerTaskCap`: the reason issue #200 exists

Both `openRouterAdapter` and `ollamaAdapter` set
`Brain.requiresPerTaskCap: true` (contract/surface.ts). Unlike the
reference CLI adapter's flat-rate subscription account, a direct,
metered API (and, by the Client's own ruling on issue #200, a local one
too - one cap, whichever metered model actually runs) has no ceiling of
its own to fall back on if `[caps].perTaskUsd` is simply never set, so
this family must refuse outright rather than run uncapped the way every
earlier brain was allowed to. `src/foreman/caps.ts`'s `requireCapForBrain`
is the generic (not vendor-named) enforcement, checked at the same three
gates `requireRoomToStart` already guards - see that file and
`src/foreman/README.md`'s "Rule 10" section.

## Environment variables

Named after the same rule Inspector's own `GITHUB_TOKEN` follows: the
tool's or provider's own conventional name, read directly, never a
`FABRICA_`-prefixed reinvention.

- `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` - `openRouterAdapter`'s
  defaults. `OPENROUTER_BASE_URL` (default
  `https://openrouter.ai/api/v1`) exists specifically so a test, or a
  future self-hosted proxy, can point this at something other than the
  real service.
- `OLLAMA_HOST` - Ollama's own documented env var for where its server
  listens, reused as-is rather than invented fresh. Its conventional
  default (`127.0.0.1:11434`) is deliberately **not** this adapter's own
  default, because the call happens from *inside* the sandboxed
  container, where `127.0.0.1` means the container itself - the default
  here is `host.docker.internal:11434` instead. `src/containment`'s
  `buildDockerArgs` now always adds
  `--add-host=host.docker.internal:host-gateway` when network is
  allowed, which is what actually makes that hostname resolve to the
  real host on native Linux Docker Engine as well as Docker Desktop
  (which already resolved it without any extra flag).

## The model is a setting, never hardcoded

Both `OpenRouterAdapterOptions.model` and `OllamaAdapterOptions.model`
are required, with no default baked into this file. OpenRouter's own
`/models` endpoint includes each listed model's live `pricing` object and
a `hugging_face_id` field - a reasonable signal for "open-weight" -
making "the cheapest open-weight model currently listed" a query against
real, current data, not a string this adapter should freeze in time and
let go stale. Picking one (for the proof run, or for real use) is left
to whoever configures this adapter, and whatever they pick lands on the
receipt honestly via `Brain.model`.

## What's verified, and what's still open

Verified: OpenRouter's request/response shape (`/chat/completions`,
`tools`/`tool_calls`, `usage.cost`) against its current documentation;
Ollama's OpenAI-compatible surface (`/v1/chat/completions`, tool calling
supported) against its current documentation; `worker-loop.mjs`'s own
tool-calling loop, cost accounting, and session persistence, run
directly against `helpers/fake-chat-server.ts` with no Docker at all
(`worker-loop.test.ts`); `--add-host=host.docker.internal:host-gateway`
against Docker's own documented `--add-host` flag.

Not yet verified, and explicitly left open rather than assumed:

- **A real end-to-end run against the real OpenRouter API.** No
  `OPENROUTER_API_KEY` exists yet to run one with - `index.test.ts`'s
  containment-level tests run the real loop inside a real container
  against `fake-chat-server.ts`, never the real service. The "cheapest
  open-weight model" selection above is likewise unexercised for real.
- **Whether a contained call genuinely reaches `host.docker.internal`
  on this machine.** Docker itself was not installed on the machine this
  was written on - every Docker-dependent test here (`index.test.ts`,
  and `src/containment/run.test.ts`'s own new host.docker.internal test)
  skips loudly rather than passing for a reason that was never actually
  exercised; see each file's own loud-skip banner.
