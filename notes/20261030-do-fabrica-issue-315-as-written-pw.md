# A code reader that reaches its model through a host command, not a key

Issue #315 (the second work-mode issue): at work the only model access is
a coding-agent CLI on a company subscription - no API key, no
OpenAI-compatible endpoint. So `[reader]` needs a vendor whose calls go
through that command on the host, needing neither `<VENDOR>_API_KEY` nor
`<VENDOR>_BASE_URL`.

## What was built

- `src/brain/adapters/cli-reader.ts` holds all of the vendor-specific
  knowledge: which `vendor =` spelling in projects.toml means "go through
  the command", which command that is, how its argv is built, and how its
  answer is read back. It lives in `adapters/` because that is the only
  directory under `src/` CONTRACT rule 8 lets a brain, model or harness
  be named in - and `cliReaderFor(vendor)` is how the generic reader
  module asks "is this one of yours?" without ever holding the name. It
  is **not** a `Brain`: a reader holds no session, works on no repository
  and runs no tools, so it implements none of that interface.
- `ResolvedReader` (`src/reader/types.ts`) is a two-arm union now,
  discriminated by `via`: `"api"` carries the key and the endpoint
  exactly as before, `"command"` carries the command name and no
  credential at all. `readDiff` is one branch wide; everything after the
  model's answer - parsing, the correction brief, the declines file, the
  record events, the delivery - is untouched, which is what the issue
  asks for ("unchanged in shape").
- `src/reader/` still names nothing. It reaches the adapter directory
  through `src/brain/index.ts`, whose own path names nobody; a vendor-named
  import path would fail rule 8's scan, which is also why `call.ts`
  rewrites the HTTP client rather than importing the adapter's.

## The sharp edges, written down because they are not guessable

- **The diff cannot ride in argv.** Linux caps a *single* argv string at
  128 KiB (`MAX_ARG_STRLEN`), while a read is allowed up to
  `MAX_DIFF_BYTES` (1 MB). The reference adapter's `-p <brief>` shape is
  safe only because a brief is small. The reader's prompt therefore goes
  on **stdin** (`-p` with no prompt argument), verified live against the
  installed CLI (2.1.222) on 2026-10-30.
- **Structured output, not prose.** `--json-schema <schema>` plus
  `--output-format json` returns one result object whose
  `structured_output` holds the answer already parsed - verified live on
  the same version. The adapter hands that back as JSON text, so the
  generic `parseFindings` stays the single parser and the single source
  of the "that was not a findings list" failure message. The CLI giving
  up on the schema (`error_max_structured_output_retries`) is carved out
  of the is_error check and its own text read instead, exactly as
  `claude-code.ts` carves it out for a missing write-up.
- **No tools, empty cwd.** `--tools ""` (disable all tools, verified live
  together with `--json-schema`) and a throwaway empty working directory,
  so the call reads the diff it was handed and nothing else on the
  machine - the same containment reasoning the reference adapter's
  `ask()` uses, minus Docker, because this call edits nothing. `--bare`
  would also skip agent-memory discovery but makes auth API-key-only per
  its own help text, which is the thing this vendor exists to avoid.
- **A missing command is a refusal at task start**, naming it
  (`resolveReader`), which is the issue's own clarification. The refusal
  says out loud that no key is wanted, since the obvious reading of any
  reader refusal is "go and set a credential".
- The PATH lookup is the adapter's own ten lines rather than an import of
  `src/inspector/run.ts`'s identical `commandIsInstalled`: a brain
  adapter has no business depending on the Inspector module.

## Where the same shape still is, deliberately

`src/reviewer/` resolves a vendor the same way and still requires
`<VENDOR>_API_KEY`. Left alone on purpose: a reviewer is handed to
Inspector as `-vendor`/`-model` flags and Inspector dials it itself, so
Fabrica cannot route that call through a host command. A work machine
therefore still needs a key for a reviewer, which only a project
declaring `testPaths` needs at all.

## tests.map

`src/reader/` was written after `tests.map` was last generated and so was
listed nowhere - every file in it read as unmapped. Its colocated pairs
are hand-added now, plus the two files `call.ts` and `types.ts` that have
no colocated test but are really covered by `read.test.ts` and
`resolve.test.ts`.
