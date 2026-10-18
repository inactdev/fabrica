# Node is pinned to an exact version now, and a test makes the four pins move together

`.node-version` holds `24.18.0` and `package.json`'s `engines.node` is
`24.18.0`, matching the two pins that were already exact:
`.inspector.json`'s `cimg/node:24.18.0` and the worker/relay images'
digest-pinned `node:24.18.0-alpine`. `src/cli/node-version-pins.test.ts`
reads all four off disk and fails unless they name the same version, so a
bump that moves some of them and not the rest fails the suite.

## Why a bare major in `.node-version` was wrong

The previous note
(`notes/20261017-make-the-repo-declare-its-own-node-versi-sp.md`) landed
`.node-version` containing `24`, reasoning that the major was the
declaration and `fabrica doctor` owned the exact patch. That reasoning
turned out to be backwards in practice, for a concrete reason:

**`.node-version` is an instruction to a version manager, not a
description.** `fnm` (and `nvm`, `asdf`, `mise`, `actions/setup-node`)
reads that file and *installs* what it says. Handed `24`, fnm installed
**24.22.0** - the newest 24.x at the time, a perfectly correct reading of
a bare major. `fabrica doctor` then compared that against
`.inspector.json`'s `24.18.0` and **refused it**, exactly as designed.
The repo's own declaration and the repo's own preflight were in direct
disagreement, and following the repo's instructions was what produced the
refusal. A bare major cannot express "the Node this suite is known to
pass on" - only "some member of a family of builds, chosen for you."

`engines.node` had the same hole from the other side: with
`engine-strict=true`, `24` is still satisfied by every 24.x, so npm
enforced nothing about *which* 24. The flag was binding on a range too
loose to be worth binding.

So the exactness is not pedantry: four pins describe one Node, and three
of them were already exact. The two loose ones were the only places a
different build could enter.

## Consequence worth knowing before it surprises someone

`npm install` / `npm ci` now exit 1 with `EBADENGINE` on *any* Node other
than 24.18.0, not just a wrong major, because `.npmrc`'s
`engine-strict=true` makes the exact range binding. That is the intended
effect - it is the same answer `fabrica doctor` already gave, moved
earlier, to install time. README's "Prerequisites" line was updated to
say the exact version and that it is exact rather than a floor;
previously it said "Node 24", which would have read as satisfied by the
24.22.0 that npm now refuses.

## What the test can and cannot prove

`src/cli/node-version-pins.test.ts` reads, per source:

- `.node-version` - the file's own trimmed contents, and the value every
  other pin is compared against.
- `package.json`'s `engines.node`.
- `.inspector.json`'s image tag - **through `doctor-command.ts`'s
  `pinnedNodeVersion()`**, now exported for this, rather than a second
  regex of its own. Deliberate: the live symptom this exists to prevent
  is doctor refusing the Node the repo told you to install, so the test
  has to read that tag through the one reader doctor itself refuses on. A
  private copy could be right while doctor was wrong.
- the worker Dockerfile's node base image.

The Dockerfile is the one with a real limit. Its base is pinned by
digest (`FROM node@sha256:...`) and **a digest carries no version**: the
only record of which Node it is, is the comment beside it naming
`node:24.18.0-alpine`. So the test parses that comment. A bump that
changes the digest and leaves the comment alone is therefore invisible
here, and nothing offline can close that gap - deriving a version from a
digest needs a registry lookup. Binding the comment is still worth
strictly more than leaving it unbound, and the Dockerfile now says so
next to the `FROM`, so a reword keeps the `node:<x.y.z>-alpine` spelling
(a reword that drops it fails the test loudly rather than silently
un-pinning the check).

A third assertion covers that file contradicting *itself*: it names a
Node version three times in three spellings (`node:24.18.0-alpine`,
`Node v24.18.0`, and a cross-reference to `cimg/node:24.18.0`), so the
test requires every mention to agree. A half-bump that fixes the tag and
not the prose two lines down is caught by this and by nothing else.

`package-lock.json`'s root entry mirrors `engines` too, and was updated
by hand to match - the exact one-field change `npm install` would make
itself, so a later install produces no incidental diff in an unrelated
pull request. It is **not** asserted by the test: it is a regenerated
mirror, not an independent declaration, and `npm ci` reads the range
from `package.json` rather than from here anyway (verified empirically in
the earlier note, against a lock written before the range existed).

The relay image is deliberately **not** a fifth source: `RELAY_IMAGE`
(`src/relay/container/launch.ts`) is the identical digest string, and
`src/relay/container/relay-image-digest.test.ts` already proves it
matches the Dockerfile's `FROM`. Covering it here would be a second
assertion of the same fact.

## Verified in both directions

Each simulated partial bump was run, not just reasoned about - bumping
each of the four alone, bumping only the Dockerfile's prose mention,
reverting both files to bare majors, and rewording the Dockerfile comment
away from the tag spelling. Every one fails at least one assertion, with
a message naming which source disagrees. The test also passes against the
real tree as it stands.

## Reversing an earlier "deliberate non-change"

That same previous note recorded "**No test asserts the four
declarations agree**" as a considered decision, on the grounds that
`engine-strict` plus a runner reading `.node-version` already makes
`npm ci` fail on drift. The fnm/24.22.0 refusal is the counter-example:
`npm ci` only ever sees *one* Node, whichever the environment already
has, so it catches a runner that disagrees with `engines` - and nothing
else. It cannot notice `.node-version` disagreeing with
`.inspector.json`, which is the drift that actually happened, because
both files are just text to it. The test is not a restatement of a CI
check; it covers a pair CI structurally cannot compare.

The note's other deliberate non-change still stands, with one update:
`fabrica doctor`'s node check still reads `.inspector.json`, not
`.node-version`. The reason given was that `.node-version`'s major-only
`24` could not express an exact patch - no longer true - but it no longer
matters either, since the test now proves the two are the same string.
Which file doctor reads is now a free choice, so it was left alone.

## Still open, found and not touched

`devDependencies` still pins `@types/node: ^22.20.1` while everything
runs on Node 24 - the same class of mismatch as this one, at the types
layer. Unchanged for the same reason the earlier note gave: a dependency
bump cannot be verified from inside a task box, since the npm registry is
unreachable there (`E403`). Worth its own issue.
