# Why an installed copy is updated by packing first, then installing the tarball

Task: change `fabrica update`'s installed-copy path to `npm pack
github:inactdev/fabrica --pack-destination <tmpdir>` followed by `npm
install -g <tmpdir>/fabrica-*.tgz`, because `npm install -g github:...`
on Linux leaves fabrica installed as a symlink into a temporary clone
npm then deletes. Dev-checkout path unchanged.

## The bug, reproduced here rather than taken on trust

The Client's report (Oct 22) was `npm install -g github:inactdev/fabrica`
dying in esbuild's postinstall with `ENOENT` in a folder that no longer
exists, and `--ignore-scripts` leaving a dangling symlink. The network
is unreachable from a worker box, so the real GitHub spec could not be
installed - but the mechanism reproduces offline with a `git+file://`
spec, which npm treats as the same kind of git dependency. npm 11.16.0,
Node 24.18.0, Linux, throwaway prefix, a two-file package with a
`prepare` script:

```
$ npm install -g --prefix $p2 git+file:///tmp/.../src-repo
added 1 package in 524ms
$ ls -l $p2/lib/node_modules/
packprobe -> ../../../../../home/worker/.npm/_cacache/tmp/git-cloneKMOEIE
$ $p2/bin/packprobe
bash: .../bin/packprobe: No such file or directory
```

So the *installed* package is a symlink into npm's cacache git-clone
temp directory, which npm removes - the install reports success and the
command is broken the moment it is run. That is the same shape as the
Client's two symptoms: a postinstall running in a folder that is being
deleted, and a dangling symlink when scripts are skipped.

The same package, packed first:

```
$ npm pack git+file:///tmp/.../src-repo --pack-destination $dest
packprobe-0.0.0.tgz
$ npm install -g --prefix $prefix $dest/packprobe-0.0.0.tgz
added 1 package in 146ms
$ test -L $prefix/lib/node_modules/packprobe || echo REAL_DIR
REAL_DIR
$ $prefix/bin/packprobe
packprobe ok
```

A real directory, a working executable. The tarball also carried the
`prepare` script's output (`build-info.json` with the real commit) - the
one thing `fabrica doctor` reads off an installed copy, so packing must
not be done with `--ignore-scripts`.

## The npm facts behind the two commands, from npm's own docs

npm ships its current documentation inside the install itself
(`<npm root -g>/npm/docs/content/...`), which is reachable with no
network - worth knowing on a box that cannot reach docs.npmjs.com:

- `commands/npm-pack.md`: synopsis is `npm pack <package-spec>`;
  `pack-destination` is "Directory in which `npm pack` will save
  tarballs", default `"."`.
- `commands/npm-install.md`, on git dependencies (and on `github:`
  shorthand specifically): "If the package being installed contains a
  `prepare` script, its `dependencies` and `devDependencies` will be
  installed, and the prepare script will be run, before the package is
  packaged and installed." So `npm pack <git spec>` is a full build of
  the published shape, not just an archive of the repo.
- The tarball npm writes is named `<name>-<version>.tgz` (observed:
  `packprobe-0.0.0.tgz`; fabrica's is `fabrica-0.0.0.tgz`).

Two consequences for the code:

- `--prefix` is passed to the *install* step only. npm's `prefix`
  config, per its own docs, "forces non-global commands to run in the
  specified folder" when set on the command line, and `pack` is a
  non-global command - pointing it at the install prefix would be
  meaningless at best.
- The staging directory is read to find the tarball rather than globbing
  (`execFileSync` has no shell to expand `fabrica-*.tgz`) and rather
  than parsing `npm pack`'s stdout. A freshly made `mkdtemp` directory
  holds exactly one tarball; zero or more than one is reported as a
  failure, never guessed at.

## Verified end to end against the real spec

Both new commands were run for real against `github:inactdev/fabrica`
from a worker box, into throwaway directories:

```
$ npm pack github:inactdev/fabrica --pack-destination $d
fabrica-0.0.0.tgz                       # 428 files, 3.6 MB unpacked
$ npm install -g --prefix $p $d/fabrica-0.0.0.tgz
$ test -L $p/lib/node_modules/fabrica || echo REAL_DIR
REAL_DIR
$ $p/bin/fabrica --help
fabrica - hand in a task; get it done in isolation, verified, honestly.
```

## A separate, pre-existing defect this turned up: `build-info.json` has no commit

The tarball packed from the real spec carries
`build-info.json` = `{"commit":null}` - `scripts/write-build-info.mjs`'s
`git rev-parse HEAD` finds no `.git` where npm runs `prepare`. That is
**not** caused by packing: a plain, non-global `npm install
github:inactdev/fabrica` into a throwaway project - no `npm pack`
anywhere in it - produces the same `{"commit":null}`, and so does
packing the explicit `git+https://github.com/inactdev/fabrica.git` form,
so neither the spec's spelling nor pack-vs-install is the cause. npm
11.16.0, Node 24.18.0, Linux. (A `git+file://` spec *does* keep its
`.git` through `prepare`, which is presumably how this was verified when
`write-build-info.mjs` was written.)

What it costs, following the chain: `detectCopy` reports
`commit: null` for every installed copy, `checkoutCheck` turns that into
a FAIL ("installed copy at ... has no build-info.json, so its commit is
unknown"), and `fabrica up` stops on any FAIL - so an installed copy
cannot start a session on this npm. `fabrica update` also prints
`unknown -> unknown` and never sees a changed commit, so its forced
live-view restart never fires there. Left alone deliberately: the fix is
a different mechanism (capture the commit from outside the package, or
read what npm *does* record), and which one is the Client's call.

## What is still spelled the old way, deliberately

`npm install -g github:inactdev/fabrica` is still the *documented*
install in README.md and still what `fabrica doctor`'s "reinstall with"
fix prints (`npm-prefix.ts`'s `installCommandArgs`, unchanged). Those
are advice for a human to run, not a path `fabrica update` takes, and
whether the documented first install should become the two-step form is
the Client's call - the evidence above is the argument for it.
