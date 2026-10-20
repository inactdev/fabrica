# npm's global layout, and why Fabrica derives it instead of asking npm

Task: make an installed copy of `fabrica` updatable from wherever it
lives (`fabrica update` with `--prefix`), and have `fabrica doctor`
detect a leftover `npm link` symlink (closes issue #171).

## The durable facts, all checked on a real machine, not assumed

npm 11.16.0's own shipped documentation
(`<npm root -g>/npm/docs/content/configuring-npm/folders.md`, which is
the current docs for whichever npm is installed - reachable offline,
worth knowing when the network is restricted):

- "Global installs on Unix systems go to `{prefix}/lib/node_modules`"
  (Windows drops the `lib` level).
- "When in global mode, executables are linked into `{prefix}/bin` on
  Unix."
- `prefix` config: "The location to install global items. If set on the
  command line, then it forces non-global commands to run in the
  specified folder."

Verified with real installs into a throwaway prefix:

- `npm install -g --prefix <dir> <spec>` installs to
  `<dir>/lib/node_modules/<name>` with the executable symlinked into
  `<dir>/bin` - for a tarball spec and a `git+file://` spec alike.
- A copy *reached through* that executable sees
  `<prefix>/lib/node_modules/<name>` as its own module root (node
  resolves the bin symlink), while `process.argv[1]` stays the
  `<prefix>/bin/<name>` path as typed. So the module's own path names
  the prefix it is installed under, and `argv[1]` names the prefix that
  put it on `PATH`. Both are used by `src/cli/npm-prefix.ts`.
- `npm link` writes a **relative** symlink at
  `<prefix>/lib/node_modules/<name>` (`../../../<checkout>`), plus the
  usual `<prefix>/bin/<name>`. Anything reading that symlink has to
  resolve it against the link's own folder.
- `npm link` with `--prefix` on the *command line* fails (`ENOENT`) -
  exactly the documented "forces non-global commands to run in the
  specified folder" behaviour. `npm_config_prefix=<dir> npm link`
  works. With `-g`, `--prefix` behaves as expected:
  `npm unlink -g --prefix <dir> <pkg>` removes a link from that prefix,
  which is why doctor's fix carries `--prefix` when the leftover is not
  at npm's own prefix.

Why this matters at all: npm's *default* global prefix is the folder
node itself is installed in, which on a Nix-managed host is a read-only
store path. A copy installed under some other, writable prefix can only
be reinstalled in place by naming that prefix, and the only evidence of
which prefix that was is the running copy's own path - so
`prefixOfGlobalInstall` derives it rather than running `npm prefix -g`,
which would hand back the read-only default and re-break the thing
being fixed.

## What could not be reproduced here

Issue #171's actual symptom - `npm install -g github:inactdev/fabrica`
failing with `ENOTDIR` while a link sits at
`<prefix>/lib/node_modules/fabrica` - did not reproduce on npm 11.16.0
on Linux: installing over both a hand-made absolute symlink and a real
`npm link`-created relative one replaced it cleanly ("changed 1
package"). The report stands as the Client's (a Mac/Nix host, likely a
different npm); the detection and the documented fix are useful either
way, since `npm unlink -g fabrica` is also what un-shadows an installed
copy. If someone revisits this, the gap to close is which npm version
and host actually errors.

## Test-environment note

This box could not install dependencies (the npm registry returned 403
for every tarball), so `npm test` - which runs `tsc --noEmit` first and
then `tsx --test` - could not run. Node 24's native TypeScript stripping
(`node --test <file>.test.ts`) runs this repo's test files directly
without `tsx`, which is a usable fallback for everything that does not
import `smol-toml` (i.e. everything not reaching `src/config/load.ts`).
It type-*strips*, it does not type-check, so it is no substitute for
`npm run typecheck`.
