# `src/projectimage/` - which image a project's machine works in

Issue #322. One question, several readers:

- the round that starts the machine's box (`src/cli/run-task-entry.ts`,
  `answer-entry.ts`, `verdict-fix-entry.ts`, `src/foreman/foreman.ts`),
- the self-test box that runs a project's check when it has no Inspector
  (`src/foreman/judge.ts`),
- `fabrica doctor`'s per-project image line, and the build `--fix` and
  `fabrica up` run themselves (`src/cli/image-repair.ts`).

They all read `machineImageFor` / `machineImageForProject` /
`machineImageForTask`, so what the Client is told up front and what a
round actually does can never be two different answers - the same shape,
and the same reason, as `src/workmode/` and `src/projecttoken/`.

## The answer

A project carrying a `Dockerfile.inspector` - at its repository root, or
in its terms folder for a work-mode project (issue #316) - gets its own
image, `fabrica-machine-<folder>-<hash of the project path>:latest`,
built from that file plus Fabrica's own layer
(`src/brain/adapters/machine-layer.ts`, the one directory allowed to name
the coding agent it installs). A project carrying none keeps the shared
image, exactly as before this issue.

Why its own file rather than `FROM` whatever image Inspector built: the
tag Inspector builds under is not Fabrica's to know, and an image that
depended on Inspector having run at least once would be a second,
undeclared contract between the two sides. Fabrica builds from the same
*source* Inspector builds from, which is the property that actually
matters - one declaration of the project's toolchain, two boxes - and
Docker's layer cache makes the overlap nearly free.

## A project whose build needs a credential (issue #342)

This image is the project's own `Dockerfile.inspector` with Fabrica's
layer on top, so a project whose install step mounts a build secret
needs that secret here exactly as Inspector's own check-image build
does. `machineImageBuild` adds one `--secret id=NAME,env=NAME` per name
`.inspector.json` lists and puts the values on the build command's own
environment (`ImageCommand.env`, which `src/cli/image-repair.ts`'s
`runImageCommand` passes to the child) - so the argv, and therefore
everything printed and everything any other process on the machine can
read, carries names only.

A name with no value anywhere refuses the build before the generated
Dockerfile is even written, with a typed `BuildSecretsError` naming the
variable: `src/cli/machine-image.ts` reports that in the credential's
own words rather than as "its Dockerfile.inspector cannot be read", and
the repair loop reports it against that one project and carries on. See
`src/buildsecrets/README.md`.

## Sharp edges

- **The build context is the repository**, even for a project whose terms
  folder lives outside it: the `COPY` lines in the shape `fabrica
  register` writes (`package.json`, `package-lock.json`, `go.mod`) name
  paths in the repository.
- **The stamp is the hash of the generated Dockerfile**, passed to the
  build as `--build-arg FABRICA_IMAGE_STAMP` and stored under the same
  `fabrica.dockerfile-sha256` label the shared image uses. It therefore
  moves when either input moves - the project's own file, or Fabrica's
  layer, which carries both version pins. It does **not** move when a
  project's dependencies do: that is Docker's own cache question, exactly
  as it is for Inspector's box.
- **Nothing here writes anything except `machineImageBuild`**, which is
  only ever called for a build that is about to run. That is what keeps
  plain `fabrica doctor` read-only, and it is why a missing image's fix
  line is `fabrica doctor --fix` rather than a `docker build` command the
  Client could paste - until that build runs, there is no generated
  Dockerfile for such a command to point at. It lands under
  `<recordHome>/images/`, never in the Client's repository.
- **Composing that Dockerfile asks Docker a question**, so even the
  read-only path is not purely a text operation: a project whose own file
  names no `USER` at the end of its final stage has to be given back the
  user its base image runs as, and that lives in the image's own
  configuration rather than in any file (`machineRestoreUser`). The read
  is `docker image inspect`, which never pulls, so a base image not on
  this machine yet is pulled once - said on stderr first, and only ever
  the base image a project already asked for. On the read-only path that
  is close to unreachable, since `machineImageCurrency` answers `"absent"`
  before it composes anything: an image whose stamp it is checking was
  built here, which means its base was pulled here. Unreadable either way
  is an `"unreadable"` currency, i.e. a FAIL that says so, never a box
  quietly run as root. Every caller can replace the read
  (`BaseUserProbe`), which is how every test here stays off a real daemon.
- **`needsBuild` on the status line is the only decision**, and
  `src/cli/image-repair.ts` reads it rather than asking again. A worker
  CLI version that disagrees with the pin inside an otherwise current
  image sets it false: the image was built from this very Dockerfile and
  still has another version inside, so a layer-cached rebuild cannot
  change it - the same reasoning that keeps the shared image's "worker
  CLI" line from being a repair trigger.
- **The project's `Dockerfile.inspector` is read from the Client's own
  checkout**, not from a task's worktree or its base commit - so a
  machine cannot change the box it is running in by editing that file
  mid-round, and two concurrent tasks on one project share one image.
  Inspector reads the committed copy for its own box, which is the same
  file in every ordinary case; a Client editing it mid-task makes
  `fabrica doctor` report the image stale without disturbing the round
  already running.
- **The tag is derived from the project's resolved path**, not from its
  name in projects.toml: a round knows the path long before (and
  sometimes without) knowing which registry entry names it, and two
  registrations of one path must not produce two images. The folder name
  rides along unhashed only so the tag is readable.
- **`fabrica quiz` re-checks still run in the shared image.** They read a
  scratch checkout, run no project check, and one run covers several
  tasks across different projects, so there is no single project image
  for it to use. `wiring.test.ts` names that exception explicitly and
  fails on any other call site that builds a worker without asking here.

## When an image gets built, and who refuses when it cannot be

Three places put a project's image on this machine. All three ask
`machineImageCurrency` whether it needs building, so none of them can
form a second opinion about it:

- **`fabrica doctor --fix` and `fabrica up`**, through
  `src/cli/image-repair.ts`, off the per-project doctor line's own
  answer. This is the Client sitting down to work.
- **`fabrica update`**, through `src/cli/machine-image.ts`'s
  `buildRegisteredMachineImages`, for every registered project at once.
  New code can move Fabrica's own layer, which makes every project's
  image stale in one go, so they come forward with the code.
- **The start of a task**, through the same module's
  `requireMachineImage` - in `fabrica do`'s foreground, before anything
  is registered, and again at the head of each detached round
  (`run-task-entry.ts`, `answer-entry.ts`, `verdict-fix-entry.ts`)
  before the round itself begins.

A build that fails there refuses the task, in the build's own words,
before a round or an attempt is spent; it never dies mid-round, and it
never touches or waits on another project. All three of those properties
are issue #322's amendment, written after its first attempt merged with
every project needing an image that could not be built - which blocked
every task on every project, including the ones that could have fixed
it.

That amendment is also why
`src/brain/adapters/machine-image-build.test.ts` exists: every test in
the first attempt drove a fake docker, so the generated Dockerfile was
never once handed to a real builder. A fake docker proves the argv; only
a real one proves the file.
