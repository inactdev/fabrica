# The code reader

Inspector issue #34 and its amendment: **every task's diff is read,
after Inspector turns it green, by a model whose only job is to flag.**
It never blocks and never approves. What it flags goes back to the same
machine as a fix round, before the delivery.

This module is the reader itself - who it is, how it is called, what it
says, and how a worker answers it. The round that calls it is
`src/foreman/reader-round.ts`; that file owns *when*, and
`src/foreman/README.md` owns the record and delivery semantics.

## What it is, and what it isn't

| | reviewer (`src/reviewer/`) | reader (here) |
|---|---|---|
| what it judges | a change's *test* edits | the whole diff |
| when | inside Inspector's own run | after Inspector's green |
| who calls it | Inspector, handed `-vendor`/`-model` | Fabrica, directly |
| can it stop a change | yes - it is part of a verdict | **no, ever** |
| needed by | a project declaring `testPaths` | **every task** |

Those last two rows are the whole design. Because the reader cannot
stop anything, a reader that fails is never allowed to stop anything
either: a failed read is recorded, shown and counted, and the delivery
goes ahead. And because it is needed by every task, a missing one is a
refusal at task start rather than a quiet skip.

## Configuring one

    [reader]
    vendor = "<the reading vendor>"
    model  = "<that vendor's model>"

    [projects.spending-app.reader]
    vendor = "<a different one, just for this project>"
    model  = "<that vendor's model>"

A project's own table wins **outright**, not field by field - the same
rule `[reviewer]` follows, for the same reason: reading one entry always
answers "who reads this project" without a second lookup.

### Two ways to reach one

Most vendors are reached over the network, with a credential - the two
variables below. A few are reached by **running a command on this
machine** instead (issue #315): a work account whose only model access is
a coding-agent CLI on a subscription has no API key to configure and no
endpoint to name, so a vendor like that wants neither variable, and the
installed, already-signed-in command is the whole credential.

Which vendors those are, and what command each needs, is adapter-only
knowledge: `src/brain/adapters` is the one directory allowed to name a
vendor, a model or a harness at all (CONTRACT rule 8), so this module
asks it (`cliReaderFor`) and never learns the name it just matched. The
answer rides on `ResolvedReader.via` - `"api"` or `"command"` - which is
the only thing anything here branches on. `readDiff` is one branch wide;
everything after the model's answer - the parsing, the report, the
findings handed to the worker, the record, the delivery - is the same
code either way, deliberately.

For a command-reached vendor the one thing that can be wrong is that the
command is not there, which is its own refusal naming it
(`missingCommandMessage`), on the same "refuse at task start" footing as
the three below.

### A vendor reached over the network

Two credentials, read from Fabrica's own environment first and then from
`<recordHome>/brain.env` (mode 600), exactly the precedence the worker's
own token has:

- `<VENDOR>_API_KEY` - **required.**
- `<VENDOR>_BASE_URL` - **also required**, and this is where the reader
  differs from the reviewer, which forwards one only when set. A
  reviewer's endpoint is Inspector's problem; this call is Fabrica's
  own, so Fabrica needs somewhere to send it, and it keeps no
  vendor-to-endpoint table. It holds the endpoint *root* - everything
  before `/chat/completions`.

### The four refusals

`resolveReader()` answers `reader` or `refused`. There is deliberately
no third "none" answer, which is the one real asymmetry with the
reviewer's resolution. It refuses when:

1. no `[reader]` is configured for the project at all;
2. its `<VENDOR>_API_KEY` is nowhere to be found (or `brain.env` is
   readable by other users, which is its own refusal in its own words
   and never quietly read as "no key");
3. its `<VENDOR>_BASE_URL` is nowhere to be found;
4. or - for a vendor reached by a command rather than an endpoint - that
   command is not on `PATH`. Neither credential is looked for in that
   case, and the refusal says so out loud: the obvious reading of any
   reader refusal is "go and set a key", which here would send the
   Client hunting for one that does not exist.

**It never falls back to `[reviewer]`.** The two tables exist
separately so the Client can give the two jobs to different models;
borrowing one for the other would make that choice unmakeable while
looking like it had been made.

The same function answers for both call sites, so they cannot disagree
about what counts as configured: `fabrica do` asks before anything is
registered or spent, and the round asks again in `prepareRound`, before
any worker starts. A refusal in the round is
`ForemanError("reader-not-ready")`.

## The call

`src/reader/call.ts` makes one POST to `<baseUrl>/chat/completions` with
a `model`, a `messages` array and a Bearer token, and reads the answer
at `choices[0].message.content`. That request shape is not invented
here - it is the shape this repository already verified against the
vendors' own current documentation and wrote down under
`src/brain/adapters/`, read back from that record.

The call is written out fresh rather than imported from the direct-API
brain adapter's own client, which makes the identical request. That is
not a preference: **CONTRACT rule 8's scan
(`contract/rule8.no-favorite-brain.test.ts`) reads every file under
`src/` outside the adapter directory and flags a vendor name as plain
text anywhere in it, an import specifier included** - and that client's
path names one, so a generic module cannot reach it without failing
that test by construction. The same scan covers this README, which is
why no vendor, model or harness is named anywhere on this page.

Only "not now" is retried - 408, 409, 429 and the 5xx family, twice,
with a short wait. A 400 or a 401 is a real answer about this request
and is reported immediately. The credential goes into one header on one
request and nowhere else: not into any environment, not into argv, and
never into a message - every error names the endpoint, which came from
config, and never the key.

### The other call

`askCommandReader` is the same question asked of a command on this
machine (see "Two ways to reach one"), and hands back the same thing: the
model's answer as text, for the one parser below. It passes the answer's
shape over as a JSON Schema (`FINDINGS_JSON_SCHEMA`, the same shape the
prompt asks for in words), so a command that can be asked for structured
output answers in it rather than in prose.

No retry loop on that side, where the HTTP call above has one: a command
on this machine is not somebody's rate limiter, its own client already
handles a provider's back-pressure, and a second whole read is a second
whole charge. There is nothing to leak either - this call carries no
credential at all.

## What a read says

`readDiff()` returns a `ReaderReport`: the model's label
(`"<vendor>/<model>"`, the Client's own spelling), the findings, and how
many bytes of diff were read. **An empty findings list is a normal
answer** - the prompt says so explicitly, because a reader that felt
obliged to find something would be inventing work.

There is no severity on a finding and no verdict on a report. The
prompt forbids a verdict rather than merely not asking for one: a reader
answering "looks good to me" would be approving, which is Inspector's
job and the Client's, never this one's.

Parsing is deliberately tolerant about the wrapping and strict about the
content. Models fence JSON in backticks and add a sentence in front of
it however firmly they are asked not to, and refusing a read over that
would throw away a good answer - so `parseFindings` finds the outermost
JSON object in whatever came back (brace-counting, with string literals
tracked, so a brace inside a finding's own text cannot end the object
early). What is *not* tolerated is an entry missing either half: a
half-finding handed to a worker is an instruction to guess.

An answer with no findings array at all is a **failed** read, never a
clean one. A clean read has to be something the model said, never
something the parser gave up and assumed.

### Why a diff too large is a refusal, not a trim

Past `MAX_DIFF_BYTES` the read is refused naming both numbers. The
whole point is that the *whole* diff is read, so a truncated read
presented as a read is the one dishonest option available - and a
refusal costs nothing here, because a failed read never blocks a
delivery.

## How the worker answers

`readerCorrection()` is the brief: the findings, numbered, handed over
as-is, with the standing permission to decline one - and the standing
requirement to say why. Declines come back as JSON in
`.fabrica-reader-declines.json` in the root of the worker's own
workdir.

A file rather than a field on the write-up, because `BrainWorkResult`
has no free-form structured channel (`writeup` is a fixed schema for
pull request bodies) and widening a ratified contract shape for one
round's bookkeeping would be the wrong trade -
`src/quiz/recheck.ts` made the same call for the same reason. The one
difference, and the sharp edge: **this worktree is committed**, so the
file must never survive into the diff. `src/foreman/reader-round.ts`
reads and deletes it inside `attempts.ts`'s existing `beforeCommit`
hook, which runs immediately before the commit.

One numbering end to end - the brief the worker read, the file it wrote
back, the record, and the delivery the Client reads - so nobody has to
translate between two. A decline naming a finding out of that range, or
giving no reason, is dropped and *reported* (`ParsedDeclines.problem`)
rather than shown to the Client beside a finding it was not about; a
declines file that will not parse is reported the same way. Neither
fails the round: a worker that fumbled the format has still done the
work.

## Why this is its own module

The same reason `src/reviewer/` is: it needs the record home's
credential file, and the parts of the system that call it have no
business depending on the reader's own internals. It takes only the
`<VENDOR>_API_KEY`/`<VENDOR>_BASE_URL` naming from `src/reviewer/`,
deliberately - one vendor must resolve to one key variable whichever job
it is doing, and two copies of that rule are how a key set under one
spelling goes unread under the other.
