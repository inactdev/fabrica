# Build secrets

A project's image build sometimes needs a credential the repository does
not have. Issue #342's case: a work project installs `sidekiq-pro` and
`sidekiq-ent` from `https://enterprise.contribsys.com/`, a paid gem
source, and `bundle install` runs at **image build time** because the
check box has no network.

The whole design is one sentence: **names travel, values don't.**

| what | where it lives | who sees it |
| --- | --- | --- |
| the variable's name | `.inspector.json`'s `buildSecrets`, `Dockerfile.inspector`'s mount, every message, `fabrica doctor` | everyone |
| the variable's value | `~/.fabrica/brain.env` (mode 600), or Fabrica's own environment | one `docker build`, and the `inspector` child |

## The three files here

- `derive.ts` - which variables a `Gemfile.lock` says are needed, from
  every `GEM` remote other than rubygems.org, by bundler's own naming
  rule (`BUNDLE_` + host uppercased, `.` → `__`, `-` → `___`). Used by
  `fabrica register`, which writes the names into `.inspector.json` and
  the mount lines into `Dockerfile.inspector`.
- `declared.ts` - that list, read back out of a project's
  `.inspector.json`.
- `resolve.ts` - the **only** place a value is read. Fabrica's own
  environment first, then `brain.env`; a listed name with no value
  anywhere is a refusal naming the variable, never a build attempted
  without it.

## Who may read a value, and why only them

Three callers, named in `resolve.ts`'s header and held to it by
`no-value-outside-the-build.test.ts`:

1. `src/projectimage/resolve.ts`'s `machineImageBuild` - the project's
   machine image is that same `Dockerfile.inspector` with Fabrica's
   layer on top, so it needs the same secrets. They go on the `docker
   build` child's environment, and into its argv only as
   `--secret id=NAME,env=NAME` - a name.
2. `src/foreman/judge.ts` - the `inspector` child's environment, which is
   where Inspector reads a `buildSecrets` entry from (inspector#86).
3. `fabrica doctor` - which asks only whether a value is *there*.

The worker box cannot get one by construction, not by care: its
environment is an explicit allowlist (`src/containment`'s `opts.env`,
built from `credentialEnvFrom`'s single credential) and nothing puts a
build secret in it.

## Sharp edges

- **`GEM` only.** `Gemfile.lock` carries a `remote:` under `GIT` and
  `PATH` too - a repository URL and a directory. Reading those as gem
  sources derives a credential variable for `github.com`, which is why
  the parse is section-aware.
- **The file form of the mount, never `env=`.** `RUN
  --mount=type=secret,id=NAME NAME="$(cat /run/secrets/NAME)" bundle
  install` works on any Docker with BuildKit; the `env=` option needs a
  newer Dockerfile frontend than some installs have (the issue says so,
  and Docker's own docs put `env=` behind a `# syntax=` pin).
  `src/register/dockerfile.ts` writes it, with `mode=0444` so the step
  can read it whether the image's install step runs as root or as the
  image's own user.
- **A host that cannot be a variable name is reported, not dropped.** A
  gem source with a port in it, or one `new URL` cannot read a host out
  of, becomes a note in `fabrica register`'s own output telling the
  Client to name the variable himself.
- **Nothing here is written for a project with no second gem source**,
  which is almost every project: no `buildSecrets` key, no mount, no
  lookup, no doctor line.
