# adapters

The one directory where a real brain may be named (CONTRACT rule 8: "No
favorite brain"). Nothing outside this directory may reference a brain,
model, or vendor name - `contract/rule8.no-favorite-brain.test.ts` scans
for that and skips only this folder. See [`../README.md`](../README.md)
for what each field on the `Brain` interface means and how to write one;
this file covers what actually lives here.

## Two families of adapter

Every adapter satisfies the same `Brain` interface, but there are two
genuinely different shapes behind it.

**CLI adapters** wrap a coding agent that already runs as its own
program. That tool does the agent work itself - reading files, editing
them, running commands inside `workdir`. The adapter's job is narrow:
build the right command line, hand over `brief`, stream the tool's
output into `transcript`, and translate that tool's own notion of a
resumable run into `session`.

**Direct API adapters** talk straight to a model's API instead. There is
no agent program on the other end - the API only returns text and
tool-call requests. Reading files, editing them, and running commands
inside `workdir` has to be code the adapter itself runs. **That loop
lives inside the adapter.**

That's the asymmetry worth stating plainly, because it's easy to assume
the two are equally cheap to add: a CLI adapter delegates the agent loop
to a program that already exists; a direct API adapter implements that
loop itself. Both end up satisfying the identical `Brain` seam, and both
must have genuinely done the work by the time `work()` resolves - but
one is a thin wrapper and the other is a small agent in its own right.

## Cost, and why `costUsd` can be null

`Receipt.costUsd` is typed `number | null` because these two families
report cost differently. A direct API adapter is billed per token, so it
can compute a real dollar figure for the call it just made. A CLI
adapter often runs against a flat-rate subscription with no per-call
price at all - for those, the honest value is `null`, not an invented
number.

This has a consequence for CONTRACT rule 10 worth flagging early: caps
are enforced in dollars, and a brain that reports `null` spend cannot be
metered by cost the same way a priced one can. Solving that is issue
#11's job, not this one - but whoever builds cap enforcement should meet
this fact here, not discover it there.

## v1 ordering

This is not a menu to build all at once. ROADMAP.md is explicit: brains
come from the Client's existing subscriptions first, through their
officially approved harnesses, and per-token API pipes stay closed
unless he deliberately opens one behind a cap that can be zero. So the
CLI family comes first - issue #6 built the first CLI adapter, listed
below - and direct API adapters arrive later, behind that deliberate
switch.

## Guarding a fake against drift from the real thing

Every CLI adapter's fast tests need a controllable fake standing in for
the real binary (`claude-code.ts` has `helpers/fake-claude-cli.mjs`) -
right for testing the adapter's own parsing logic deterministically, but
nothing stops that fake silently drifting from what the real tool emits
once written (issue #46). The pattern this reference adapter settled on,
meant to be copied by the next one:

1. **A loud skip, not a silent one.** Whatever test drives the real
   binary (`claude-code.test.ts`'s capability spike) must make it
   unmissable when it *didn't* run - Docker absent, image missing,
   nothing authenticated. `claude-code.test.ts`'s `after()` hook prints an
   `!!!`-bordered banner at the end of the run if that test skipped for
   any reason, so a wall of green dots can never be read as "verified
   against reality." Copy that hook, not just the idea of one - a
   comment saying "this skips silently" is exactly the failure mode
   issue #46 was raised about.
2. **A fixture-parity test that always runs.** `helpers/fake-claude-cli.test.ts`
   spawns the fake directly (no Docker) and compares its output's
   *shape* - not bytes - against `helpers/fixtures/real-claude-cli-sample.jsonl`,
   a real sample recorded once and committed. See
   `helpers/fixtures/README.md` for exactly where the shape-vs-bytes line
   was drawn and why, and `helpers/stream-json-shape.ts` for the
   allowlist-based comparison itself. The fixture's own coverage is
   asserted as well (`coverageGaps()`), because the comparison runs
   *from* the fixture: a sample that stopped demonstrating a shape would
   silently check less while staying green, so both that test and the
   re-record script fail rather than accept one.
3. **What a second adapter has to build, concretely:** its own fixture
   file (recorded from its own real binary, with its own re-record
   script, sanitized of that machine's paths/session data the same way),
   its own shape-allowlist (the field names differ per tool, so
   `stream-json-shape.ts`'s allowlist is `claude-code.ts`-specific, not
   reusable as-is), and its own loud-skip hook on whatever test of its
   drives the real binary. None of the three is generic infrastructure
   worth extracting yet with only one adapter written - copy the pattern,
   not a shared module, until a second adapter exists to prove what's
   actually common.

Running the real binary in CI - closing the loop all the way, rather than
comparing against a fixture that ages between recordings - was
deliberately **not** built here: it needs an authenticated install and
real spend in CI, a decision for whoever configures Fabrica's CI, not
something an adapter's own tests take on themselves. The loud skip above
exists precisely so that decision stays visible instead of getting quietly
assumed to be handled.

## Written adapters

- **`claude-code.ts`** - the Client's own daily coding agent, driven
  through the `claude` CLI's non-interactive mode. The first CLI
  adapter (issue #6). See [`claude-code.md`](./claude-code.md) for what
  was verified against the real binary and why each flag is there.

## Candidate CLI adapters

From ROADMAP.md's parking lot and issue #23 ("Second and third brain
adapters"):

- **Grok Build** - xAI's terminal coding agent, launched May 2026;
  ROADMAP.md already confirms it ships a headless mode with JSON output.
- **Codex** - OpenAI's terminal coding agent.
- **Gemini CLI** - Google's terminal coding agent.
- **pi** - the fourth candidate named in issue #23.

None of these has a written adapter yet. Before any of them gets one,
its adapter has to nail down four things that nothing else in Fabrica
knows, and issue #6's rule for finding them out is not optional:
*"discover exact flags and auth behavior on the real machine, never
guess."* Concretely, for each candidate:

1. **The exact command that runs it non-interactively.** Most terminal
   coding agents ship an interactive chat mode and a separate scriptable
   one; the adapter has to invoke the scriptable one, with whatever
   flags that specific binary's current version actually takes.
2. **How `brief` goes in and `transcript` comes out.** Some tools take
   the prompt as an argument, some on stdin, some from a file; some
   print plain text, some emit structured output (Grok Build's headless
   mode is JSON) that maps piece-by-piece into `transcript` entries, the
   way `claude-code.ts` maps `stream-json` lines.
3. **How it represents a resumable run.** Some tools hand back an id you
   pass on the next invocation; others resume from a local state
   directory instead. Whichever it is, that's what `opts.session` and
   the returned `session` map onto.
4. **How it runs contained.** An adapter's tool runs inside a Docker
   container via `../../containment/` (see `../README.md` on why each
   adapter wires that in itself), so the candidate needs a container
   image carrying the tool's own Linux build, and a headless way for
   its credential to reach a fresh container. See
   [`claude-code.md`](./claude-code.md), "Process containment," for how
   the reference adapter answers both.

None of that is guessed here - it's verified against each real binary
when that candidate's adapter is actually written.

## A sketch of the shape

Illustrative only: a generic CLI adapter, showing where the first three
answers above plug in (the fourth, containment, lives inside what
`runNonInteractively` would really be - a `runContained` call; see the
reference adapter for the real shape). The tool name and flags are
placeholders, not a real command - see the candidates above for what
has to be verified before this becomes real code.

```ts
import type { Brain } from "../types.ts";

export function terminalToolAdapter(): Brain {
  return {
    name: "terminal-tool",
    model: "whatever model that tool reports itself as using",
    async work(brief, workdir, opts) {
      // Real flag names come from verifying the live binary (issue #6).
      const args = opts?.session
        ? ["--resume", opts.session, "--prompt", brief]
        : ["--prompt", brief];
      if (opts?.reasoningEffort) args.push("--effort", opts.reasoningEffort); // ignored if the tool doesn't support it

      const { output, resumeId } = await runNonInteractively(args, { cwd: workdir });

      // A text-only tool's output becomes one entry; a tool with its own
      // structured output maps each piece to its own entry instead.
      return {
        transcript: [{ occurredAt: new Date().toISOString(), kind: "text", text: output }],
        session: resumeId,
      };
    },
  };
}
```

Re-run `npx tsx --test contract/rule8.no-favorite-brain.test.ts` after
editing this file - the names above belong in `adapters/` and nowhere
else.
