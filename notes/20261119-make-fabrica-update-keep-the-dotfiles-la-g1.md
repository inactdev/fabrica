# `fabrica update` keeps a hand-written `<prefix>/bin/fabrica` launcher

## The two failures this closes, both real

On both Macs, the dotfiles bootstrap writes its own launcher at
`<prefix>/bin/fabrica` — a script that runs Fabrica on a pinned Node
through fnm. `fabrica update` reinstalls with `npm install -g --prefix
<prefix> <tarball>`, into that same prefix, and npm wants to own that
exact path. Both halves of the resulting mess were reproduced here on
npm 11.16.0 / Node 24.18.0 against a scratch prefix and a two-file probe
package, not reasoned about:

1. **With the launcher in place, the install refuses and nothing lands
   at all.** npm reported `npm error code EEXIST` / `File exists:
   <prefix>/bin/<name>` / "Remove the existing file and try again, or
   run npm with `--force` to overwrite files recklessly", exited
   non-zero — and `<prefix>/lib/node_modules/` was left *empty*. The
   package was not updated; the bin-link step is not a last cosmetic
   touch npm does after unpacking, it is a step that aborts the whole
   install.
2. **With the launcher gone, npm writes its own link there instead** —
   `<prefix>/bin/<name>` -> `../lib/node_modules/<name>/bin.mjs`, a
   *relative* symlink — and that link runs on whatever node the
   terminal happens to have. That is how the work Mac ended up on
   24.16.0 inside the work repo on 2026-11-11.

Moving the launcher aside, installing, and moving it back was also run
for real: the install reported "added 1 package", the restored launcher
executed, and the package was genuinely updated.

## What was built

`src/cli/bin-launcher.ts`, wrapped around the one install step inside
`reinstallGlobalCopy` (`src/cli/global-reinstall.ts`), plus the
reporting and exit code in `src/cli/update-command.ts`.

The deciding question is **"is `<prefix>/bin/fabrica` npm's own link
into this prefix's copy of the package?"** — a symlink whose target,
resolved against the bin directory, lands inside
`<prefix>/lib/node_modules/fabrica`. That, and only that, is npm's to
replace. Anything else — a script, or a symlink pointing anywhere else —
is someone's launcher and is moved aside to
`<prefix>/bin/.fabrica-launcher-saved`, then moved back afterwards.

Three properties worth keeping:

- **The move is a same-directory `rename`,** both ways. It is atomic,
  and it moves the inode, so bytes, mode and ownership come back
  identical with no copy to truncate. Never read-then-write.
- **It is put back whether the install worked or not** (and even if the
  install step throws), because the restore is structural — a `finally`
  in `installKeepingLauncher`, not a line the caller has to remember.
- **npm's own link is captured, not reconstructed.** Before the launcher
  goes back over the top, whatever npm left at the bin path is read with
  `readlink` and kept as a string. That string is the fallback if the
  launcher turns out to be broken — nothing here ever builds a link out
  of an assumed layout.

## Verifying the restored launcher, and the Client's ruling on a miss

After the launcher is back, the paths it names **inside
`<prefix>/lib/node_modules/fabrica`** must all exist. For a symlink
that is its resolved target; for a script it is every absolute path in
its text that falls inside that directory. Deliberately only
package-internal paths: those are the ones an install can invalidate,
and checking every absolute token a shell script happens to contain
(`/dev/null`, a comment, an `$HOME`-expanded path) would discard
working launchers.

On a miss, per the Client's ruling: **discard the broken launcher, put
npm's own captured link back so `fabrica` still starts, exit non-zero,
and say which path no longer exists and that re-running the dotfiles
bootstrap writes a new launcher.** Never leave a `fabrica` that cannot
start.

Two edges that ruling does not cover, decided here and named in the
summary line rather than hidden:

- **Nothing to fall back to.** If the install failed, npm left no link
  of its own, so discarding the launcher would leave *no* `fabrica` at
  all — strictly worse than a broken one, and it would destroy the
  Client's own file on top. The launcher is kept, and stderr says there
  is nothing on this prefix that can start Fabrica.
- **A launcher that names no package-internal path.** Unknown is not
  the same as missing, so this does not fail the update: the launcher is
  put back untouched, stderr says plainly that it could not be checked
  from here, and the summary reads `launcher kept, unchecked`. A silent
  skip would have been the bug.

A broken launcher does not short-circuit the rest of the update:
Inspector, every project's machine image and the live view all still
come forward (the code really was replaced, so a live view on the old
code is exactly what an earlier ruling forbids), and `fabrica update`
returns 1 at the end.

## The alternative that was rejected

`npm install -g --force`, which npm's own EEXIST message suggests. One
flag, no move-aside and no restore path to get wrong — and it silently
destroys the launcher on every update, which is failure mode 2 above,
the one that put the work Mac on the wrong Node. Also loosens npm far
beyond the one path at issue. Rejected.

A second one: verifying the restored launcher by *running* it
(`<prefix>/bin/fabrica --help`), which proves it starts rather than
inferring that from a path. Rejected because the ruling asks for the
missing path to be named, which an exit code cannot do, and because an
update should not execute the Client's own script to decide whether to
delete it.

## Sharp edge left standing on purpose

If the process is killed between the move-aside and the restore, the
launcher is at `<prefix>/bin/.fabrica-launcher-saved` and the bin path
holds npm's link. The next `fabrica update` classifies that as npm's
own link, so it preserves nothing and the saved file is never picked
back up. Adopting a leftover saved file would resurrect a launcher the
Client may have removed on purpose, so it is not done — `fabrica` still
runs in that state, just on the wrong Node, and re-running the dotfiles
bootstrap fixes it.
