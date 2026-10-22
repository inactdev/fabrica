# `fabrica doctor` fix lines: prose leads, the command trails

Issue #130 asked the worker-image check's fix to say out loud that its
build command runs from any folder (the command opens with its own `cd`
into the checkout, which it already did, but nothing said so).

The durable part is the shape chosen, not the wording: when a `fix:`
string needs an explanatory note alongside a command, the note goes
**before** the command, never after it. A reader who copies a fix line
copies from the command to the end of the line, so a trailing
parenthetical ends up pasted into their shell; a leading note leaves the
command as the line's tail and stays pasteable. `checkoutCheck`'s
`reinstall with: npm install -g …` in `src/cli/doctor-command.ts` already
had this shape — `src/brain/adapters/doctor-checks.ts`'s `buildFix()` now
matches it, and `doctor-checks.test.ts` anchors the assertion with `^…$`
so the command staying the tail is what the test actually proves.

One other place prints that same build command: the "worker CLI" check's
version-mismatch fix (`workerCliVersionStatus`). It goes through the same
`buildFix()`, since it is the same command printed in the same run of
doctor with the same "where do I run this" question. The "relay image"
check (`src/relay/container/doctor-check.ts`) is not the same shape — its
fix is a bare `docker pull`, which needs no directory at all.
