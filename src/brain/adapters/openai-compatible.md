# `openai-compatible.ts` — the direct-API worker

Issue #200. One adapter that speaks an OpenAI-compatible
chat-completions API, runs the agent loop itself inside the worker's
box, and **refuses to run without a spending cap**. The second of the
two families [`README.md`](./README.md) describes, and the first direct
API adapter in the project: `claude-code.ts` wraps a program that
already does the agent work, while this one carries that loop as its own
code in [`openai-agent/`](./openai-agent/).

Read this before changing anything here. Everything below about a
vendor's wire shape was read from that vendor's own current
documentation on 2026-10-17 — never guessed — and the one thing that
could *not* be done from where it was written is listed plainly at the
end.

## The design, and the alternative that was rejected

The task was a direct-API adapter with an open-weight target whose
receipts are real money (`costBasis: "metered"`). That makes the cost
question the deciding one, because a dollar figure can come from only
two places:

1. **A price table in this repo** (per-million-token prices per model,
   multiplied by the token counts every OpenAI-compatible API returns).
   This is what an adapter for Groq, Together or DeepSeek would need.
   **Rejected**: such a table goes stale silently, and a stale table
   does not fail loudly — it reports invented money as `metered`, which
   is precisely what rule 10 exists to prevent. It would also have to be
   maintained for every model the Client might hot-swap to, which is the
   opposite of model-agnostic.
2. **The provider's own figure for the call it just answered.** No
   table, nothing to go stale, and the number on the receipt is the
   number on the bill.

So the default target is a vendor that documents (2) as always present,
and the only other cost source this adapter accepts is `"free"` — a
server the Client runs themselves, which bills nothing per call, where
`$0.00` is the honest metered figure rather than an unknown. A
`"reported"` target that answers without a cost is an **unknown** cost,
never a zero; rule 10 then blocks new work until it is recorded by hand,
and `fabrica doctor --live` warns about exactly that before a task is
ever started.

## The two targets, and what was verified about each

**Hosted (the default): OpenRouter.** `https://openrouter.ai/api/v1`,
`Authorization` set to a Bearer token — `OpenRouterTeam/docs`,
`api_reference/authentication.mdx`: "If you're calling the OpenRouter
API directly, set the `Authorization` header to a Bearer token with your
API key." The credential variable it names is `OPENROUTER_API_KEY`
(`snippets/exports/constants.mdx`'s `API_KEY_REF`).

Cost: `cookbook/administration/usage-accounting.mdx` — "OpenRouter
automatically returns detailed usage information with every response,
including … Cost in credits", "included … in the complete response for
non-streaming requests. **No additional parameters are required**," and
`cost` is "The total amount charged to your account." The same document
marks the older `usage: { include: true }` and
`stream_options: { include_usage: true }` parameters as deprecated and
inert, which is why this adapter sends neither.

Why this vendor, given rule 8 ("No favorite brain") lets the adapter —
not the Client — name it: it is the one OpenAI-compatible gateway whose
documentation promises both halves this adapter needs at once. Open-weight
models from every vendor behind a single key and a single model string,
so "best result for the money" is a per-task choice rather than a
per-account one; and the real charge per call on the response, so no
price table is needed. Point `baseUrl` elsewhere and nothing else about
this adapter changes — that is what hot-swappable means here.

**Local: Ollama.** `http://<host>:11434/v1`, same endpoint shape —
`ollama/ollama`, `docs/api/openai-compatibility.mdx`: a local server
"requires an API key value, but Ollama ignores it," with `gpt-oss:20b`
and `qwen3:8b` among its examples. This adapter sends **no**
`Authorization` header at all for a target with no credential, which
that server accepts. Cost defaults to `"free"` whenever no credential is
configured, for the reason above.

**The request shape itself** (`tools`, `tool_choice`, `max_tokens`, and
the three-step tool-calling exchange — assistant message carrying
`tool_calls` whose `arguments` is a JSON *string*, then one
`{ role: "tool", tool_call_id, content }` message per call) is quoted
from `api_reference/parameters.mdx` and
`guides/features/tool-calling.mdx` in the same repository. Non-streaming
on purpose: the loop needs the terminal `usage` object to meter spend,
and a non-streaming response carries it in one piece.

## No cap, no run

`work()` throws `OpenAiCompatibleError("no-cap")` **before any
container, relay or API call** whenever `BrainWorkOptions.maxSpendUsd`
is absent, with the exact setting to add:

```
[caps]
perTaskUsd = 2.00
```

That is the whole of the Client's August 2026 ruling the issue cites,
and it lands where it is cheapest to enforce: `src/foreman/attempts.ts`
passes `maxSpendUsd` only when the project's `[caps].perTaskUsd` is set,
so "no hint" and "no cap" are the same condition. The in-box agent
checks it a second time (`openai-agent/main.mjs`) and refuses before its
first call, so no way of starting the agent — including by hand — can
spend uncapped money.

The Client's own answers to how the cap is measured and enforced
(2026-10-17), implemented exactly as given:

- **Metered dollars, per `work()` call** — the `maxSpendUsd` Fabrica
  already passes, which is what is left of the task's own cap.
- **Metered as it goes, from the provider's per-call usage, stopping at
  the first call that crosses the line** — so a round can overshoot by
  at most one call. `openai-agent/loop.mjs` checks the running total
  before each call and never makes another once it is at or past the
  cap.
- **What was done so far comes back** — a `budget-exhausted` transcript
  entry and every usage entry, never a thrown error, so the spend
  reaches the receipt and the Foreman can stop the task honestly. A
  round that stops this way has no write-up, which makes the attempt red
  on the Foreman's own terms.
- **No cap means refuse, with no fallback** — not an environment
  variable, not a config default, no built-in number.

A cap with nothing left in it (`maxSpendUsd <= 0`) returns that same
budget-exhausted shape with a real `$0.00` metered usage entry, without
paying for a container to say so.

## The box, and what runs in it

`runContained` (see `../../containment/README.md`), with:

- The ProductionLine worktree as `/workdir`, and the project's shared
  `.git` mounted read-only through the reference adapter's own
  `resolveGitMounts` — so `git status`/`log`/`diff` work and `git
  commit` cannot (Fabrica commits).
- A throwaway copy of `openai-agent/`'s **`.mjs` files only**, plus this
  call's `job.json`, mounted read-only at `/fabrica-agent`. The worker
  runs that code and must not be able to rewrite its own harness.
  `openai-agent/runtime-imports.test.ts` proves the copy runs under a
  stock `node` with no `node_modules` and no TypeScript anywhere near
  it, the same way `src/relay/container/` proves it for the relay.
- The same worker image the reference adapter builds
  (`docker/Dockerfile`): it already carries `node`, `git`, `bash` and
  the project toolchains a Worker needs to run the project's own checks.
  A second image would be a second thing to build and keep current, for
  no difference in what the agent needs.
- The box's `$HOME` persisted per task, which is where the agent keeps
  this call's message history — see "Warm sessions" below.

Configuration reaches the agent as one `job.json` beside it, not argv
and not a pile of environment variables: the brief alone can be tens of
kilobytes. Nothing secret is in it — the credential it carries is a
per-call placeholder.

The agent writes **NDJSON on stdout and nothing else** (one
`openai-agent/types.ts` `AgentLine` per line); stdout is a protocol, not
a log, and anything else it has to say goes to stderr. The host maps
each line to a transcript entry the instant its newline lands (issue
#70's live transcript) and reads the final `result` line for what only a
finished process can know: the total cost, the write-up, why it stopped.

## Network, and where the credential is

Same shape as the reference adapter, generalized to a caller-named
gateway: every call joins a fresh `--internal` Docker network whose only
other member is a relay container (`src/relay/`). The worker's
`job.json` holds a per-call placeholder; the relay holds the real
credential and swaps it into the `Authorization` header on the way
upstream — the one place both values ever meet, with no TLS termination
anywhere. GitHub is reachable through the relay's CONNECT tunnel; every
other destination is refused.

A target with no credential still goes through the relay (there is just
nothing to swap), so egress stays confined either way.

## Warm sessions on an API that has none

CONTRACT rule 6's `fix` resumes the same worker rather than starting
cold, and SPEC.md is explicit that a retry is a correction into the same
session. A chat-completions API holds no session, so the agent keeps one
itself: the whole message history, written to
`$HOME/.fabrica-sessions/<sessionId>.json` in the box, whose `$HOME` is
mounted per task and survives across that task's calls. `work()` returns
the new session id; `opts.session` resumes the prior one and appends the
new brief as a correction inside it. A box with no mounted home (or a
corrupt file) simply starts cold, which is correct rather than an error
— the brief says what to do either way.

## What bounds the clarifying call

`ask()` (SPEC.md step 2) runs the same agent in `"ask"` mode: one call,
no tools, `max_tokens` capped, against an empty scratch directory with
no git mounts at all — so CONTRACT rule 1 holds by construction, and the
prompt is the reference adapter's own `buildAskPrompt` (what counts as
materially ambiguous is a property of the step, not of which brain
answers it). Its real cost is reported as `BrainAskResult.costUsd`, so
rule 10 counts it.

**A stated limit, with its exact consequence.** The `Brain` seam
carries no cap to `ask()` — there is no `maxSpendUsd` parameter on it —
so the refusal above cannot be applied there. What bounds that call
instead is its shape: exactly one request, no tools, a hard
`max_tokens`. The reference adapter's `ask()` is unbounded in the same
way.

So a task started with **no cap at all** goes: `requireRoomToStart`
passes (it is a no-op when no cap is set — `src/foreman/caps.ts`'s
`capsActive`), this `ask()` makes its one bounded call, and then
`work()` refuses with the message above. The refusal lands where real
money would be spent, and the clarify step costs a fraction of a cent
before it. Closing even that gap would mean either giving `Brain.ask` a
cap in `contract/surface.ts` or letting an adapter read the Client's
config — one is a contract change no adapter may make on its own, the
other breaks the layering deliberately (a brain adapter has no business
reading `projects.toml`). Stated rather than silently accepted.

## Turning it on

Nothing changes for anyone who leaves it alone: with `FABRICA_BRAIN`
unset, `defaultBrainAdapter` builds exactly the worker it always did.
The per-token pipe is opened deliberately, with one switch (see
`index.ts`). Each setting is read from Fabrica's own environment first,
then from `<recordHome>/brain.env` (same file, same mode-600 rule, so a
machine can keep all of it in one place):

| setting | meaning |
| --- | --- |
| `FABRICA_BRAIN=openai-compatible` | use this worker |
| `FABRICA_MODEL` | required — the model id, exactly as the target names it |
| `OPENROUTER_API_KEY` | the hosted target's credential; absent means a keyless target |
| `FABRICA_MODEL_BASE_URL` | optional — any OpenAI-compatible base URL, default the hosted one |
| `FABRICA_MODEL_COST` | optional — `reported` (default with a credential) or `free` (default without) |

There is deliberately **no default model**: this adapter has no
favourite one, and a slug hardcoded here would rot into a confusing
provider-side error. `fabrica doctor` reports which model at which
endpoint, whether a credential is configured, and — with `--live` — one
real call confirming both that it authenticates and that the provider
reports the call's cost.

## What is **not** verified from here

This adapter was written inside a Fabrica worker box, which has no
credential for any model provider, no egress to one (its relay allows
GitHub only), and no Docker daemon. Three things therefore remain for
the Client's own machine, and the tests say so loudly rather than
quietly skipping (`../README.md`'s "A loud skip, not a silent one"):

1. **A live call to a real provider.** `openai-compatible.test.ts`'s
   last test makes one and asserts `usage.cost` is a number — the single
   documented fact every receipt here depends on. It is opt-in
   (`FABRICA_TEST_REAL_MODEL_API=1` plus the credential and
   `FABRICA_MODEL`), because it spends real money, and the same check is
   available to the Client as `fabrica doctor --live`.
2. **The agent running in a real box.** The same file's in-box test runs
   the staged agent in the real worker image, with no network and no
   credential, and asserts it answers in the protocol. It needs Docker.
3. **The local Ollama target's reachability.** `host.docker.internal` is
   how a container reaches a server on the Docker host, but
   `src/relay/container/launch.ts` records that an `--internal` network
   strips that route — which is why the relay container has a second,
   ordinary network of its own. Whether `host.docker.internal` resolves
   *from the relay container* on a given machine was not provable from
   here. If it does not, the fix is configuration, not code:
   `FABRICA_MODEL_BASE_URL` can name any address the relay can reach.

Issue #200's "done when" — a task running end to end on a hosted
open-weight model with a real dollar receipt — needs (1), and that is
the Client's to run.
