# `fabrica up` / `fabrica doctor --fix` supply the two images themselves

Client ruling 2026-10-30, with the clarification answered in the brief:
**auto in `up`; `doctor` needs `--fix`, plain `doctor` stays
read-only.** `src/cli/image-repair.ts`'s `repairImages` is the step.

## The property that makes it safe to automate: the repair decides nothing

The brief said "the pins and their checks are unchanged", and that is
also the whole design. `repairImages` never asks whether an image is
current. It reads the `DoctorCheck[]` that `collectDoctorChecks` just
produced, and for a *failing* `worker image` / `relay image` line it
runs the command that line already printed as its `fix`, then re-asks
the same probe. So:

- a repaired line can only be green for the reason doctor itself would
  give (the `fabrica.dockerfile-sha256` stamp equalling the
  Dockerfile's hash; `docker image inspect` finding the pinned digest);
- a command that fails leaves exactly the `FAIL` and the exact `fix`
  that were there before, plus one stderr line in docker's own words.

The command a check prints and the command the repair spawns are now one
value: `workerImageBuild()` (`src/brain/adapters/doctor-checks.ts`) and
`relayImagePull()` (`src/relay/container/doctor-check.ts`) each return
`{ command, args, cwd?, image, shell }`, and the `fix:` strings are
rendered from `shell`. **Do not write a second spelling of either
command anywhere** - that is what the one-value shape exists to prevent,
and `image-repair.test.ts` asserts the two agree.

Three label constants exist only so the repair can find the right lines
among all of doctor's without a second copy of the string:
`WORKER_IMAGE_LABEL`, `WORKER_CLI_LABEL` (both in the adapter's
doctor-checks) and `RELAY_IMAGE_LABEL` (the relay's). `DOCKER_LABEL`
lives in `src/cli/docker-daemon.ts`, beside the `dockerDaemonUp()` the
line is literally asking about - and deliberately *not* in
`doctor-command.ts`, because `doctor-command.ts` imports
`image-repair.ts` and the reverse import would be a runtime cycle.
`image-repair.ts` imports from `doctor-command.ts` **types only**, which
is what keeps that cycle from existing; keep it that way.

## Four decisions that are easy to undo by accident

- **`--fix` runs before `--live`.** The ordering lives in
  `collectDoctorChecks`'s new `repair?` hook, not in either caller,
  because the live probe runs a container *from the worker image* -
  spending a few cents against an image this run is about to replace
  would be wrong, and two callers getting it right independently is how
  it drifts. `src/cli/doctor-command.test.ts` pins the order.
- **A failing `docker` line skips the whole step.** With no daemon a
  build can only fail a second time in docker's words, burying the one
  line that carries the real fix.
- **A failing `worker CLI` line is NOT a trigger**, even though its
  printed fix is the same `docker build`. That line failing while the
  stamp is current means the image was built from this very Dockerfile
  and still has a different version inside - which a layer-cached
  rebuild cannot change, so `fabrica up` would spend minutes and still
  refuse. It *is* re-asked after a build that happened for the image's
  own sake, since the image under it moved. Considered and rejected
  deliberately; re-adding it needs a fresh reason.
- **docker's output is forwarded line by line, stderr included.**
  BuildKit writes every progress line to stderr, so a step reading only
  stdout looks like a silent hang for the minutes a build takes.

## No settings change was needed, and why

`skill/claude-code/settings.json`'s allow list already carries the
**exact-match** entry `Bash(fabrica doctor)`, not a prefix - the same
shape as `Bash(fabrica)` / `Bash(fabrica --help)`. So `fabrica doctor
--fix` is not free from the chat agent and lands on a prompt, while the
read-only form stays free. `doctor` therefore did not become a
`NEVER_FROM_CHAT_COMMANDS` entry: the command itself is unchanged in
what it is for, only one of its flags writes, and the existing
exact-match entry is already the right line. Worth knowing before
anyone "tidies" that entry into `Bash(fabrica doctor *)`: doing so would
hand an AI driver a `docker build` against this machine.

## The shared fake docker now covers images too

`src/containment/helpers/fake-docker.mjs` (and
`install-fake-docker.ts`) grew `build`, `pull` and `image inspect`
alongside the `network` commands it already had - extended rather than
copied a third time, so there is one `docker` stand-in for the whole
project. Two things about it worth knowing:

- Images live in their own `images.json` under the state dir, not in
  `state.json`, because `install-fake-docker.ts`'s `remaining()` reads
  that file as a bare array of networks.
- A fake `build` **re-reads the Dockerfile the call names** and resolves
  its `LABEL <key>=$<ARG>` lines from the `--build-arg` values it was
  given, rather than hardcoding the stamp label's name. That is what
  makes `image-repair.test.ts`'s strongest assertion real: a worker
  image stamped with an older hash is rebuilt and the *untouched* check
  then passes it, because the build genuinely carried the Dockerfile's
  own hash through. A rename of that LABEL shows up as the fixture no
  longer failing, never as a silent pass.
- A test that proves "this command could not be spawned at all" must
  not assert the errno. The first version of
  `image-repair.test.ts`'s unspawnable-`docker` test matched `/ENOENT/`
  and passed here but came back red from the independent check, which
  answered `EACCES` for the same missing command - the operating system
  picks the code, and a PATH entry or working directory that is not
  searchable gives a different one than a plain missing file. Assert
  Node's own stable `spawn <command>` prefix instead. Widening it to
  `/ENOENT|EACCES/` is the wrong fix: it encodes a guess about which
  spellings exist rather than the property being proven.
- `image inspect --format` understands exactly one Go template -
  `{{index .Config.Labels "KEY"}}`, the one the adapter's stamp read
  asks for - and fails loudly on any other rather than inventing an
  answer.
