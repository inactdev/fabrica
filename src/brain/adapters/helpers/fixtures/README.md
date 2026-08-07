# fixtures

`real-claude-cli-sample.jsonl` is a real, sanitized `claude --output-format
stream-json` transcript, recorded once from the actual `claude` binary
(issue #46). It exists so `../fake-claude-cli.test.ts` can prove
`fake-claude-cli.mjs` hasn't silently drifted from what the real CLI
actually emits - the fake is canned data, so nothing else catches the real
tool renaming or dropping a field the adapter depends on.

## Why shape, not bytes

The test compares *shape*, not exact equality: for each key
`claude-code.ts`'s `parseLines()`/`toTranscript()` actually reads (see
`../stream-json-shape.ts`'s allowlist), the fake's output must have that
key present with the same JS type as the fixture. Two consequences of
drawing the line there:

- A field neither this fixture nor the adapter reads (session metadata,
  cost internals, anything outside the allowlist) can change freely on
  either side without failing the test - real CLI updates add fields
  constantly, and none of them should make this test flaky.
- A field the allowlist does cover disappearing, changing type, or a
  block type disappearing entirely (e.g. `tool_result` stops carrying
  `content`) fails loudly, because that's exactly the shape the adapter's
  own parsing logic depends on.

## What this fixture must keep proving

The comparison runs *from* the fixture: `shapeDiff()` only checks keys
the fixture itself demonstrates, so a sample that lost a block type (a
re-recording where the model answered without calling a tool, say)
would quietly check less while staying green - the same "green means
verified" failure as the fake drifting in the first place. So the
fixture's own coverage is asserted too: `coverageGaps()` in
`../stream-json-shape.ts` requires it to demonstrate every allowlisted
key and every line type the comparison walks, `../fake-claude-cli.test.ts`
fails if the committed fixture ever stops doing so, and
`../record-real-cli-fixture.mjs` refuses to overwrite it with a
recording that would - checking the serialized lines it is about to
write, not the in-memory objects behind them, so a key that only
survives as `undefined` until `JSON.stringify` can't pass the gate and
then vanish from the file.

Two keys are exempt, listed with their reasons in that file's
`UNPROVABLE_BY_RECORDING`: `thinking.thinking` (the real CLI emits a
thinking block only when the model actually thinks) and
`tool_result.is_error` (omitted unless a tool call failed, and the
recording prompt deliberately succeeds). They are exempt from being
*demanded of a recording*, not dropped from the allowlist - a fixture
that does happen to contain them still compares them against the fake.

Byte-for-byte equality was rejected as the standard: it would break on
every real-CLI patch release regardless of whether anything the adapter
reads actually changed, which teaches everyone to stop trusting a failure
here. The allowlist width matters in practice, not just in theory: when
this test was first written, it caught the fake's success-path
`result` line silently missing `api_error_status` (the real CLI always
emits it, `null` on success) - exactly the class of drift issue #46
worried about, found by the allowlist as it stands today. If the
allowlist is ever found to be missing something the adapter genuinely
reads, widen `BLOCK_KEYS`/`RESULT_KEYS` in `../stream-json-shape.ts`, not
this fixture's sanitization.

## Sanitization

The recorded sample is stripped of anything specific to the machine or
account that recorded it - real `cwd`, `session_id`, hook/harness chatter
(`system` lines other than `init`, `rate_limit_event`), and any file path
under the recording machine's temp directory, in both the form handed to
the CLI and its realpath (on macOS `os.tmpdir()` resolves through a
`/var` -> `/private/var` symlink, and a tool reports back the resolved
one) - before it's written here. `../record-real-cli-fixture.mjs` does
this automatically.

## Re-recording

Run, with an authenticated `claude` on `PATH`:

```
node src/brain/adapters/helpers/record-real-cli-fixture.mjs
```

Do this when there's a concrete reason to think the real CLI's shape
changed - a version bump plus a changelog entry, or
`fake-claude-cli.test.ts` failing with a diff that looks like a real
field rename/removal rather than a bug in the fake or the script. Review
the resulting `git diff` before committing: it should only ever touch
fields the adapter's allowlist cares about (the same set the shape-parity
test compares) - a wholesale reshuffle means the script over-recorded,
not that the real CLI actually changed shape.

A fixture nobody re-records becomes a fixture that eventually lies just
as confidently as the fake it's meant to check - re-recording it here,
by hand, on a real signal, is the whole point; nothing automated refreshes
it, and nothing should (see issue #46 on why running the real binary in
CI is a separate, deliberately unbuilt decision).
