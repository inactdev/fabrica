# Credential check at task start — the design (issue #103, paper only)

**Status: design, not built.** Issue #103 opens "Paper only - not to be built
until the two proof runs are done," and the Client confirmed that reading when
the task was clarified: the deliverable is the design plus this file, no code.
Nothing in `src/` changed. Whoever folds `notes/` into `AGENTS.md` should keep
this file until #103 is actually built, then fold the parts that survived
contact with the implementation.

> A worker must never die mid-task on authentication.

One cheap live call before anything starts; a refusal if it fails, naming the
command that fixes it and the file the result goes in; and a different message
when the provider is unreachable, so nobody is sent to rotate a working
credential.

Per the Client's clarification, the check is designed **for whichever machine
the task is about to use** — each make gets its own live call and its own fix
instruction. `claude setup-token` is one make's fix line, not the whole design.

---

## 1. Where the check lives

Two existing seams decide this, and neither is negotiable:

- **CONTRACT rule 8.** `src/brain/adapters/` is the only directory anywhere
  under `src/` allowed to name a make, model or vendor
  (`contract/rule8.no-favorite-brain.test.ts` scans the rest). So the *call*
  and the *fix line* must live in the adapter. A gate in `src/foreman/` that
  knew "run `claude setup-token`" would fail that scan, and should.
- **Issue #64.** `src/foreman/no-host-check.test.ts` fails if anything under
  `src/foreman` spawns anything but `git`. So the gate module must not spawn —
  it takes the probe as an injected function and calls it. (That rule is about
  Fabrica never running *the project's* check on the host; it is not a rule
  against Fabrica's own preflight making a call. The CLI make's probe runs in
  the worker's own box anyway.)

So:

```
src/brain/adapters/doctor-checks.ts   the per-make live call + fix line (already exists)
        ↓  probeWorkerToken(env, recordHome)        — already re-exported by src/brain/index.ts
src/foreman/credential.ts             the gate: records the refusal, then throws  (new)
        ↓
ask.ts / answer.ts / verdict.ts / quiz/recheck.ts    the four start paths
```

**Reuse, do not re-write.** `probeWorkerToken` already *is* the dispatcher this
needs: it reads which machine is selected (`directBrainSettings`), and either
makes the CLI make's call in the worker image or the direct-API make's one
`chatCompletion`. `fabrica doctor --live` is its only caller today. The gate
becomes its second caller, so doctor and the gate can never disagree about
whether a credential works — the same reason both test suites measure an
untouched checkout with one `fingerprint()`, and both the review page and a
pull request body render through one `finalMessageFor`.

What it lacks is the three-way answer §4 needs, so widen its return type:

```ts
export type CredentialVerdict =
  | { state: "alive";          machine: string; detail: string }
  | { state: "bad-credential"; machine: string; detail: string; fix: string }
  | { state: "unreachable";    machine: string; detail: string; fix: string }
  | { state: "unknown";        machine: string; detail: string };
```

`machine` is the make plus the model, opaque downstream — a string the gate
prints and never parses. `fabrica doctor --live` keeps printing an
`AdapterCheck`, derived from the verdict by one function, so the two surfaces
cannot word the same credential differently.

**The per-make contract.** A make's adapter supplies:

1. one live call that cannot succeed with a bad credential,
2. a mapping from that call's own observable outcomes onto the four states,
3. its own fix line, naming its own re-auth command and the real resolved
   path of `brain.env`.

An adapter that supplies none returns `{ state: "unknown" }` and the gate
fails open, loudly (§4). That is what keeps this design true for a make nobody
has written yet.

---

## 2. What "cheap" is, per make

The rule: **the smallest call the make's own interface offers that genuinely
exercises the credential.** A presence check is not a check.

That is not a theoretical worry for the make Fabrica runs today. Checked
against the real installed CLI (2.1.222): `claude auth status` reports

```json
{ "loggedIn": true, "authMethod": "oauth_token", "apiProvider": "firstParty" }
```

with a token of `sk-ant-oat01-definitely-not-valid` and nothing else in the
environment. It reports which credential *source* is configured, not whether
that credential works — exactly the check the issue rejects. **No make's probe
may be an `auth status`-shaped command** unless that command is documented to
make a live call.

| Make | The call | Cost / latency |
|---|---|---|
| CLI make (the default worker) | `claude -p "Reply with OK." --output-format json --max-budget-usd 0.05`, in the worker image, network allowed — exactly what `doctor-checks.ts`'s `realRun` already does, including its rule that a terminal `error_max_budget_usd` still means the call *authenticated* | a few cents metered, nothing on a flat-rate subscription; one container start |
| Direct-API make (`FABRICA_BRAIN=openai-compatible`) | `probeDirectWorker`'s one `chatCompletion` with `max_tokens: 16`, from the host — it already holds that credential, since it is what hands the relay the real value | fractions of a cent; one HTTP round trip |
| opencode, pi, internal-harness | **Unspecified here, deliberately.** None has an adapter in `src/brain/adapters/` yet, none of their CLIs is installed on this machine, and their documentation was not reachable from where this was written. Each supplies its own probe when its adapter is written; the gate and `fabrica doctor --live` get it for free, because both only ever call the dispatcher. Guessing their command shapes here would put three wrong commands into a design document. |

**Why the CLI make's probe does not go through the task's relay.** A task's
worker box reaches the network only through that task's own relay container,
which swaps a per-task stand-in key for the real one, and which does not exist
yet at gate time. Standing one up is not "one cheap call." The probe therefore
runs the way `doctor --live` already runs it: the real credential in a
throwaway box with its own network. The consequence, stated rather than hidden:
**the probe proves the credential, not the task's relay path.** The relay has
its own cover — `fabrica doctor`'s relay-image line before the task, and
`src/brain/relay-health.ts`'s per-heartbeat probe during it.

**Never print, log or echo the token** — `doctor-checks.ts` already says this
in its header and the verdict carries only a state and words. A refusal
message names the *variable* and the *file*, never a value.

---

## 3. Every path that starts a task

Four, not three. The issue's own warning ("a check on one entry point is not a
check") is already live in this codebase:

| Path | Site | Behaviour on a bad credential |
|---|---|---|
| A new task | `ask.ts`'s `registerAndAsk` | refuse |
| A resumed round (`fabrica answer`) | `answer.ts`'s `recordAnswerDecision` | refuse |
| A fix round (`fabrica verdict fix`) | `verdict.ts`'s `runFixRound` | refuse |
| The quiz re-check round | `quiz/recheck.ts`'s `recheckOneTask` | **skip with a note** |

The first three already carry two start gates in exactly this order —
`requireRoomToStart` (rule 10) then `requireMeterRoomToStart` (issue #189) —
and the credential gate goes third, immediately after them, at all three
sites.

In `ask.ts` it must sit **before `brain.ask()`**, because that call is itself a
real model call: a dead credential there today lands as an opaque `ask-failed`
whose details are whatever the brain happened to say. Replacing that with a
named refusal is half of what this issue buys.

In `answer.ts` the gate belongs in the foreground half, beside
`requireRoomToStart` — issue #123 made `fabrica answer` record the decision in
the foreground and hand the round to a detached process, and a refusal the
Client can read on the spot beats one he has to go find in the log. A refused
resume leaves the task exactly as resumable as it was, which is already the
stated property of the two gates next to it.

**The quiz re-check is the interesting one.** `src/quiz/recheck.ts` calls
`brain.work` on a throwaway checkout and is the only part of the quiz that
spends money. It is not a task: there is nothing to refuse, no taskId of its
own to record a refusal against, and it already re-states the cap and meter
tests read-only (`recheckRoomProblem`) so it can *skip* rather than throw. The
credential check joins that function the same way: one more reason string
("the worker credential did not pass a live check"), one more skipped round,
nothing refused and nothing failed. A maintenance round that quietly dies on
authentication is a smaller problem than a task that does, but it is the same
problem, and it is the path a check written only against the Foreman would
miss.

---

## 4. A bad credential vs an unreachable provider

Three outcomes, because reporting the second as the first sends someone to
rotate a credential that was fine.

- **`bad-credential` → refuse**, with the make's own fix line.
- **`unreachable` → refuse too**, with the network message and an explicit "the
  credential may be fine — do not rotate it." This deliberately differs from
  issue #189's fail-open rule, and the difference is the point: a meter reading
  is *evidence about* something else, so an unreadable one must never refuse
  work. An unreachable provider is not evidence about the failure — it **is**
  the failure. A task started against a provider nothing can reach produces a
  container that ran, a partial branch and a record that says working, which is
  the exact state this issue exists to prevent.
- **`unknown` → fail open, loudly.** For when the probe itself could not be
  run: no Docker on this machine, or a make whose adapter supplies no probe.
  One warning on stderr in the words `requireMeterRoomToStart` already uses
  ("nothing was refused on an unread number"), and the task proceeds. Never
  refuse on a check nobody could take.

**Classifying the two is the adapter's job, and its default is asymmetric on
purpose: anything a make cannot confidently classify is `unreachable`, not
`bad-credential`.** A false "your token is dead" costs a rotation, a new token
in a 600-mode file, and a lost afternoon of trust in the check; a false "the
network is down" costs one re-run.

For the CLI make, the raw material is already in `probeWorkerToken`: the JSON
result line's `is_error`/`subtype`/`result`, the exit code, and stderr. **The
exact strings that CLI emits for an expired or revoked token were not observed
while writing this** — that needs a credential that was valid and then was not,
and a reachable provider, neither of which this box had. So the mapping must be
recorded from a real observation when it is built, in
`src/brain/adapters/claude-code.md`, the way every other verified behaviour of
that binary is recorded there. Until it is, the asymmetric default means the
unobserved cases read as `unreachable`.

---

## 5. Caching

One call per task is cheap; one per task in a tight loop is not, and for the
CLI make each one is a container start.

- **Keyed on the machine, not on the credential.** The cache record is
  `{ machine, state, checkedAt, detail }` in `<recordHome>/credential-check.json`
  — no token, and no hash of one. Reuse requires `machine` to match the
  currently selected one; a Client who switched makes gets a fresh call.
- **On disk, not in memory.** Every task runs in its own detached process
  (`spawn-detached.ts`), so an in-process cache would never once be hit by the
  burst it exists to protect against. Written temp-then-rename so a reader
  never sees a torn file; an unreadable or unparseable file reads as "no
  cache", never as an error. It is rewritten in place, not appended — it is a
  single current fact, not a history, so `src/record/`'s append-only machinery
  does not apply to it.
- **TTL: 60 seconds, for a success and for a refusal alike.** A success must
  not be cached for long — that reintroduces the mid-task death this closes.
  A refusal is cached for the same short window because twenty queued tasks
  against a dead credential should not mean twenty container starts to learn
  one thing, and the refusal they would each reach is identical; 60 seconds is
  short enough that "fix the token, re-run" just works without anyone waiting
  out a cache.
- **`fabrica doctor --live` always bypasses the cache** and always writes the
  fresh result. Asking is an explicit request to check *now*.

---

## 6. What lands on the record

A refusal is appended before it is thrown — the shape `caps.ts` and `meters.ts`
both already use — so `fabrica log <id>` says what happened even though the
task never began.

```ts
export interface CredentialRefusedDetails {
  state: "bad-credential" | "unreachable";
  machine: string;
  message: string;      // the exact words the Client saw
  project?: string;     // so `fabrica status` can name it, same as the other two
}
```

**The event name needs no contract change.** `src/inspector/types.ts` holds
Fabrica's one local widening of `FabricaEventName`, which `src/record/types.ts`
re-exports as the record's event-name type, for events that are "Fabrica's own
bookkeeping, not a promise to the Client about a seam." `"meter-refused"` —
a refusal-before-start event, added by issue #189 — is the exact precedent.
`"credential-refused"` goes there, so this touches no path `rule9-gate.yml`
protects and needs no hand-merge. `ForemanError`'s code union
(`src/foreman/errors.ts`) gains the matching `"credential-refused"`.

Downstream readers need nothing new: a credential refusal is the same shape as
a cap refusal — refused before `work-started`, nothing ran, nothing to resume —
so `queries.ts`'s `stateOf` and `render.ts` treat it exactly as they treat
`"cap-refused"`. See §8 for the pre-existing gap that observation turned up.

---

## 7. The refusal message

Both halves the issue asks for, in the words a person who has not touched this
in a month can act on, and never the token.

Bad credential, CLI make:

> Refused before anything started: the worker credential for claude-code did
> not pass a live check — the provider rejected it. Run `claude setup-token`,
> put the new token in /Users/…/.fabrica/brain.env as a single line
> `CLAUDE_CODE_OAUTH_TOKEN=<token>`, then run `chmod 600` on that file.
> Nothing was started.

Unreachable:

> Refused before anything started: claude-code's provider could not be reached
> (<one line of the real reason>), so the worker credential could not be
> checked. The credential itself may be fine — do not rotate it. Check the
> network, then try again. Nothing was started.

Two deliberate readings of the issue's wording:

- It asks the message to name `~/.fabrica/brain.env`. The message prints the
  **real resolved path** (`brainEnvPath(recordHome)`), because a record home
  can be moved with `FABRICA_HOME` and every existing message in
  `adapters/index.ts` already prints the resolved form. Printing a literal
  `~/.fabrica` would be wrong on exactly the machine that needed it most.
- `claude setup-token` appears only in the CLI make's own fix line, inside
  `src/brain/adapters/`. Another make's refusal names that make's command. The
  gate never knows either string.

---

## 8. What this does not close, and the same shape elsewhere

- **A credential that lapses mid-task.** Out of scope by the issue's own
  reasoning ("Why at the start, and not during"), and worth saying plainly: a
  long task that started against a valid credential can still cross an expiry
  mid-run and die the way it does today. `attempts.ts`'s per-attempt loop is
  where that would go if the Client ever wants it; issue #102's expiry print at
  install time is the cheaper half of the same problem. Neither replaces the
  other, which is what #103 already says about #102.
- **The relay path and the worker box** are not what the probe exercises — §2.
- **`"meter-refused"` is written and never read.** Reading `queries.ts` and
  `render.ts` for §6 turned this up: both branch on `"cap-refused"` to
  recognise a task that never began and to word a dead end, and neither knows
  about `"meter-refused"` at all (it appears in `errors.ts`,
  `inspector/types.ts` and `meters.ts`, nowhere else). So a task refused by the
  pause rule is not reported as refused-before-start the way a cap-refused one
  is. Same shape as the event this design adds, and left standing — it is
  issue #189's bug, not #103's, and this task is paper only.
- **Nothing structurally enforces that a new start gate reaches all four
  paths.** `requireGitRoot`, `requireRoomToStart` and `requireMeterRoomToStart`
  are each called by hand at the same three Foreman sites, and the quiz
  re-check re-states two of them read-only. Review is the only thing that
  catches a fourth gate landing at two of them. If this is built, the cheap fix
  is one `requireStartGates(recordHome, taskId, opts)` in `src/foreman/` that
  the three sites call, so the next gate is one edit in one file — and a test
  that fails when a new `require*ToStart` export is not called from it.

## 9. One question for the Client, not blocking

Should an `unreachable` provider refuse (the design above) or fail open? The
case for refusing is in §4 and is what "no worker ever dies mid-task on
authentication" implies. The case against is that it makes a flaky network a
hard stop on work that might have succeeded, where issue #189 chose the
opposite for an unreadable meter. The design takes the refusing side and says
so in the message; flipping it later is a one-line change in
`src/foreman/credential.ts` and a reworded warning.
