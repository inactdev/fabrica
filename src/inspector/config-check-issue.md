# To file on `inactdev/inspector`: a config check that runs nothing

This is the inspector-side half of Fabrica's issue
[#306](https://github.com/inactdev/fabrica/issues/306), which says in as
many words: *"inspector exposes a command for exactly this: validate the
config and name the `Dockerfile.inspector` it would build, without
running anything - if it does not yet, this issue's task adds the Fabrica
side and files the inspector side as its own issue with the exact command
shape it needs."*

It does not yet (checked against `main` `a5cf7050`, 2026-10-28: the
subcommands are `examine`, `review`, `document`, `guidebook`, `always`,
and the default verdict run). So Fabrica carries its own copy of the
refusals Inspector documents today - `config-check.ts` - and this is the
issue to file so that copy can be deleted.

**Why Fabrica wants it from Inspector rather than keeping its own copy.**
The copy is a second source of truth for Inspector's own rules, and the
2026-10-27 migration is exactly what that costs: Inspector retired
`image` and `network`, Fabrica knew nothing about it, and every project
still carrying those keys burned a full round before finding out. A copy
closes today's gap and reopens the same one on Inspector's next config
change. Only Inspector can answer "would I refuse this" without being
told.

## The command shape Fabrica needs

```
inspector config -repo <path> [-commit <sha>]
```

- **Runs nothing.** No container, no image build, no network, no
  publication, no check command. This is read-and-report only, which is
  the whole point: Fabrica calls it at task start, before any machine
  runs, on every task.
- **`-branch` is not required.** The default run requires it because it
  may publish; this one publishes nothing, so requiring a publication
  branch for a question about a config file would be asking for
  something that has no bearing on the answer.
- **No `GITHUB_TOKEN`, and no GitHub call.** Nothing here needs a
  credential.
- **The working tree need not be clean.** `fabrica doctor` runs this
  against the Client's own checkout, which is routinely mid-edit. A
  dirty tree is not a reason to refuse a question about a committed
  file.
- **`-commit <sha>` (optional) asks about one exact commit's tree**
  rather than the working tree. This is what a Fabrica round actually
  wants: a task is judged at the commit its branch was cut from, and
  `.inspector.json` plus `Dockerfile.inspector` are read there and
  nowhere else. Omitted, the working tree is the subject.

### Exit codes

Inspector's own convention, with `1` deliberately unused - there is no
red here, because no code was judged:

| code | meaning |
| --- | --- |
| `0` | nothing refusable found: the config parses, carries no retired key, names a check command, and a committed `Dockerfile.inspector` is there to build |
| `2` | refused - the same refusal, in the same words, the default run would have printed |
| `64` | usage error (unknown flag, `-repo` pointing at no repository) |

### Output

On success, on stdout, the facts Fabrica's issue asks to be named:

```
check: ./check.sh
dockerfile: Dockerfile.inspector
from: cimg/node:24.0.0
```

`from` is `Dockerfile.inspector`'s own resolved `FROM` - "name the
`Dockerfile.inspector` it would build" - and may be omitted when it
cannot be resolved without building. On a refusal, the refusal message
goes to stderr **verbatim as the default run prints it**: Fabrica quotes
it to the Client unchanged, so two spellings of one refusal would mean
the Client reads different words depending on which half of Fabrica
found it.

### Which refusals it must cover

Every refusal the default run reaches before it needs a container -
that is, everything `LoadConfig` and `ProjectDockerfile` can raise
today:

- `ErrNoCheckCommand` - no `.inspector.json`, or an empty `check`
- `ErrRetiredImageKey` - `"image"` present, any value
- `ErrRetiredNetworkKey` - `"network"` present, any value
- a config that will not parse
- `ErrNoProjectImage` - no `Dockerfile.inspector` committed
- `ErrUncommittedProjectImage` - one on disk that git does not track

It must **not** try to cover a refusal that needs the container runtime
(a build that fails, no usable runtime, an unmountable git directory):
those are honest `0`s here, and the run itself is where they belong.

### The consumer contract

Once the command exists, it belongs in Fabrica's
`src/inspector/consumer-contract.json` and so in Inspector's own
`cmd/inspector/testdata/fabrica-consumer-contract.json` copy, which is
what makes a later rename of `-commit` or a change to the `2` fail
Inspector's `TestFabricaConsumerContract`. Deliberately **not** added
there yet: that file pins the call Fabrica makes *today*, and Inspector's
test verifies every flag in it is really accepted, so an entry for a
command that does not exist would fail Inspector's own suite the moment
the sync job carried it across.

## What Fabrica does in the meantime

`config-check.ts` reproduces three of the six refusals above - the two
retired keys and the missing committed `Dockerfile.inspector`, which is
exactly what the Client's clarification on issue #306 asked for - from
Inspector's own source rather than from prose about it, and quotes
Inspector's wording. `src/foreman/inspector-config.ts` refuses a round
on them before any machine runs, and `fabrica doctor`'s per-project line
FAILs on them. All three go away in favour of one call to this command.
