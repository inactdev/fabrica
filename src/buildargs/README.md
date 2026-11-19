# Version build arguments

A project's `Dockerfile.inspector` used to name a version in its `FROM`
line while the repository declared the same version in a file of its
own. Issue #355's case: gifthealth's file said `FROM ruby:3.4.8`, `main`
moved to 3.4.13, and every task that rebased past that bump failed at
`bundle install` ("your Ruby version is 3.4.8, but your Gemfile
specified 3.4.13") with nothing wrong with the work.

**The repository's own file is the source of truth, and both image
builds follow it.**

```dockerfile
ARG RUBY_VERSION=3.4.8
FROM ruby:${RUBY_VERSION}
```

```json
{ "buildArgs": { "RUBY_VERSION": { "file": ".ruby-version" } } }
```

## The four files here

- `versions.ts` - the table: which images carry a language version in
  their tag (`ruby`, `cimg/ruby`, `node`, `cimg/node`, `python`,
  `cimg/python`, `golang`, `cimg/go`), which build argument carries it,
  and which files a repository may declare it in, primary first. Plus
  the two questions everything else asks: does this `FROM` reference
  carry a version a file could supply (`versionArgFor`), and what does
  this repository declare right now (`declaredVersionFor`).
- `declared.ts` - `.inspector.json`'s own `buildArgs` key, read back.
- `resolve.ts` - those declarations given values out of one tree, plus
  the `--build-arg` flags and the fingerprint the image's stamp is taken
  over.
- `convert.ts` - an existing hard-coded file rewritten into the argument
  form, as text plus the config entry it needs. Writes nothing.

## Which files, in which order

| language | primary | fallbacks |
| --- | --- | --- |
| ruby | `.ruby-version` | `.tool-versions` |
| node | `.node-version` | `.nvmrc`, `.tool-versions` |
| python | `.python-version` | `.tool-versions` |
| go | `go.mod`'s `go` line | `.tool-versions` |

The Client's own clarification on issue #355, including that package
manager versions (Bundler's `BUNDLED WITH`, `package.json`'s
`packageManager`) are out of scope for now.

The order decides which file an entry is **written** against. It is not
a fallback chain at resolve time: once the entry names a file, that file
is the declaration, and Inspector resolves the same entry against the
same file. A Fabrica that quietly read a second file would build the
worker's box on one version and the check box on another.

## Patterns

An entry is `NAME: { file }` or `NAME: { file, pattern }`. A pattern is
matched **one trimmed line at a time**, first match winning, taking the
first capture group (or the whole match when it has none); with no
pattern the value is the file's first non-empty line, trimmed.

Line at a time, and never a `(?m)` inline flag: Fabrica matches these
with JavaScript's engine and Inspector with Go's RE2, and `(?m)` is a
syntax error in the first. Anchored against one trimmed line, `^go[
\t]+([0-9][^\s]*)` means the same thing in both.

A resolved value ends up in a Docker tag and in a `docker build` argv,
so it has to look like one (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, 128
characters). One that does not is reported, never passed.

## Why the `ARG` always carries a default

`ARG RUBY_VERSION=3.4.8`, never a bare `ARG RUBY_VERSION`, even though
issue #355's own proposal sketches the bare form. A build that passes no
value - every installed Inspector until the `buildArgs` half lands, and
any hand `docker build` of the same file - resolves `FROM ruby:` with
the bare form, which is not a stale image but Docker's own "invalid
reference format": every check-image build on every converted project
would fail at once. With a default it produces exactly the image it
produced before the conversion, and the only way to get a wrong version
is the one the Client already had.

Verified against BuildKit's own Dockerfile reference, whose `ARG`
section says `FROM` instructions support variables declared by any `ARG`
before the first `FROM`, and whose example is exactly this shape
(`ARG CODE_VERSION=latest` / `FROM base:${CODE_VERSION}`). The same
section is why the `ARG` goes above the first `FROM` and why nothing
after a `FROM` may read it without re-declaring it.

## Two builds, two trees

| build | reads the values at |
| --- | --- |
| Inspector's check box | the commit under check (Inspector's own half) |
| Fabrica's machine image | the build context - the registered project's checkout |

Fabrica's half is deliberately the build context and not origin's tip:
`.ruby-version` is itself copied into `/deps` for `bundle install` to
read, so a `FROM` resolved from one commit while the Gemfile beside it
comes from another is the one combination that cannot work - bundler
refuses the build naming both versions, which is issue #355's own
failure arrived at from the other side.

## The stamp

A project's machine image is current when its stamp matches the hash of
the generated Dockerfile. With the version in a build argument, a bump no
longer moves that text - so `machineImageStamp` hashes the resolved
values with it (`src/projectimage/resolve.ts`). That is what makes a
bumped `.ruby-version` rebuild the worker's box and not only the check
box.
