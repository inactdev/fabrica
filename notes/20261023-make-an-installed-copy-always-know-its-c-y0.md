# How an installed copy learns its commit, and why the install is three steps now

Task: make an installed copy always know its commit, with no hand step -
`scripts/write-build-info.mjs` records it from `.git` when there is one
and otherwise from what npm gives the `prepare` step, writing a loud,
named failure rather than a silent `null` when neither works; `fabrica
update`'s installed-copy path clones the repository into a throwaway
directory and packs from inside that clone instead of packing the
`github:` spec; `fabrica doctor` says `commit unknown` for a
`build-info.json` with an empty commit, and its fix describes the
clone-then-pack procedure.

## The decision, written before the change

Chosen, in the order the project asks for (safest, then most accurate,
then fastest): **put a real `.git` where `prepare` runs**, by cloning
before packing, and keep the npm-field read as a second source behind it,
with a named failure when both come up empty. Safest because it changes
no behaviour on a dev checkout (same `git rev-parse HEAD`, same file) and
cannot record a commit it did not read; most accurate because the clone's
HEAD *is* the code being installed.

**Rejected: have `prepare` ask the remote** (`git ls-remote
https://github.com/inactdev/fabrica.git master`) when `.git` is missing,
and record master's tip. It would have made the one-step `npm install -g
github:inactdev/fabrica` keep working and needed no change to `fabrica
update` at all - but what it records is a *guess*: the tree npm packed
may be older than master's tip, or not on master, and a confidently wrong
commit is worse than a named unknown (`fabrica update` compares before
and after; the live view compares server against disk - both would be
lied to). It also puts a network call in every install's build step.

**Also rejected: find the commit in what npm already wrote.** There is
nothing to find - see the next section.

## What npm really gives the prepare step (npm 11.16.0, Node 24.18.0)

Verified by running it, not read off the docs:

- `npm pack github:inactdev/fabrica` produces a tarball whose
  `build-info.json` was `{"commit":null}` - already recorded in
  `notes/20261022-...`, re-confirmed here.
- The environment npm sets for that `prepare` run carries no commit
  anywhere. A probe package packed from a git spec got
  `npm_package_resolved=/home/worker/.npm/_cacache/tmp/git-cloneILgEHM`
  (the extraction directory), `npm_package_json=<that>/package.json`,
  `npm_package_integrity=null`, plus `npm_package_name`/`version` and
  `npm_config_*`. **`npm_package_resolved` is a directory path, not a
  codeload URL** - pacote builds the pack step as a `DirFetcher` over
  `file:<tmpdir>` (`pacote/lib/git.js` hands `DirFetcher` the extracted
  directory; `pacote/lib/dir.js` sets `npm_package_resolved` to it), so
  the resolved spec it knew a moment earlier is gone by the time the
  script runs.
- So the codeload-URL fallback in `write-build-info.mjs` fires for no
  install path that exists today. It is kept because the brief asked for
  it and because it costs nothing: if a future npm (or a differently
  shaped spec) does hand the step a sha, the commit is recorded instead of
  refused. The clone is what actually closes the hole.
- `npm pack` with no spec, run inside a package directory, **does** run
  that package's `prepare` (npm's own lifecycle table lists
  `prepack`/`prepare`/`postpack` for `npm pack`; confirmed by the file the
  script wrote appearing inside the tarball).
- `npm install -g <tarball>` does **not** re-run the installed package's
  `prepare` in the installed directory - checked with
  `--dangerously-allow-all-scripts`, so the answer is not just npm
  11.16's new `allowScripts` policy withholding it. That is why nothing
  carries an already-recorded commit forward: it is never overwritten.
  (npm's lifecycle table does list `prepare` under `npm install -g
  <pkg-name>`, so this is worth re-checking if a future npm changes it -
  an install that re-ran `prepare` in place would turn every good
  `build-info.json` into the named failure.)
- A global install started in a directory npm cannot read a
  `package.json` in has been seen to fail with `npm error enoent Could
  not read package.json: ... /tmp/package.json`. Both npm steps therefore
  run inside the clone, which always has one.

## Verified end to end, against the real remote

```
$ git clone --depth 1 --branch master https://github.com/inactdev/fabrica.git $d/fabrica
$ cd $d/fabrica && npm pack --pack-destination $d     # 0.4s, fabrica-0.0.0.tgz
$ npm install -g --prefix $p $d/fabrica-0.0.0.tgz
$ cat $p/lib/node_modules/fabrica/build-info.json
{"commit":"b8a4afa7589aea8d1a2edeaf7ac80a6223d546c1","source":"git rev-parse HEAD"}
$ $p/bin/fabrica doctor | grep checkout
OK   checkout: installed copy v0.0.0, commit b8a4afa7589a (up to date with origin/master)
```

And `fabrica update` run for real from an installed copy whose commit was
unknown: `fabrica update: unknown -> b8a4afa7589a - ... - live view
started.` The Inspector step failed (`proxy.golang.org` is Forbidden from
a worker box) and, as designed, warned without failing the update.

## The shape of the fix, for the next person

`build-info.json` is now `{commit, source}` on success and
`{commit: "", source: "none", error}` on failure - never `null`. The
empty string is load-bearing: `doctor-command.ts`'s reader turns it into
`CopyInfo.commitUnknownReason`, which the `checkout` line prints verbatim
after `commit unknown`, so the Client reads *why* rather than just
*that*. An absent file and the old `{"commit":null}` shape both land in
the same state with their own reason.

Everything that prints the install prints
`npm-prefix.ts`'s `clonePackInstallProcedure(prefix)`, which is built
from the very argv `global-reinstall.ts` runs - the one spelling rule
this module already followed. `INSTALL_SPEC`, `installCommandArgs` and
`packCommandArgs` are gone: the `github:` spec is no longer a thing
Fabrica runs or advises, only something the prose explains the avoidance
of.
