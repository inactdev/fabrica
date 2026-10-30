# A project may use its own GitHub token instead of the App (issue #314)

Work mode, first of three. One setting in `projects.toml`; a project
that does not carry it behaves exactly as before.

## The plan, and the alternative that was rejected

**Chosen.** `[projects.<name>].githubTokenVar` names a variable in
`brain.env`. One new module, `src/projecttoken/`, answers "which
credential does this project use" (App, its own token, or a refusal
naming what is missing), and `src/foreman/github-token.ts` - which was
already "every GitHub credential a task uses" - becomes the single
chokepoint: `taskGithubCredential()` returns either today's recording
App minter or a reader of the project's own token, and the three places
that reach GitHub for a task (publish, read-issue, read-checks) ask it
for a token string rather than minting one themselves. Safest, because
the choice is made in exactly one function: a new GitHub call added
later cannot accidentally get the App for a token project, because the
only way to get a token at all is through that function.

**Rejected: a `GITHUB_TOKEN` override threaded only into
`src/inspector/run.ts`'s handoff environment.** It is a two-line change
and it satisfies the issue's literal "hands Inspector that token as
`GITHUB_TOKEN`" - but the Client's clarification is "every GitHub
operation for that project", and the issue read and the pull-request
checks read would have kept using the App. On a machine where the App
cannot be installed at all, those two would fail while publishing
worked, which is the half-working state this issue exists to remove.

**Also rejected: making the project-token path a `TokenMinter` that
returns a `MintedToken`.** Every call site would have been untouched,
but `MintedToken` carries an installation id, a granted-permission map,
a `repository_selection` and an expiry, none of which a personal token
has - so the `"token-minted"` event would have carried invented
numbers. The record has to say what is true, so the project-token path
records its own event (`"project-token-used"`: purpose, repository, and
the variable's *name*) and the credential seam was narrowed to what
every caller actually used - a token string.

## What is deliberately not changed

- **No fallback, either way** (the issue's own clarification). A project
  names a token or it uses the App. A token project never touches the
  App, and `requirePublishPermissions` (issue #304's start gate, which
  reads what GitHub granted on a minted App token) returns early for
  one: there is no grant to read on a personal token, and GitHub exposes
  no equivalent endpoint for a fine-grained token's own scopes.
- **`fabrica register`'s `gh pr create`** still uses the Client's own
  `gh` login, exactly as `src/githubapp/README.md` already records. A
  project is not yet registered when that runs, so it has no entry to
  read a variable name from.
- **The relay's `GITHUB_HOSTS`** is about what a Worker's box may reach,
  not about which credential the host publishes with; untouched.

## The same shape elsewhere, and what was done about it

Every GitHub call a task makes now reads its token from one function,
`src/foreman/github-token.ts`'s `taskGithubCredential`. Both HTTP layers
(`src/github/api.ts`, `src/ci/github.ts`) take the token as a parameter
and hold no credential of their own, so there is nowhere else a task
could get one.

One place genuinely has the same shape and is deliberately left
standing: **`fabrica register` pushes the registration branch and opens
its pull request on the project's own repository with the Client's `gh`
login** (`src/register/tools.ts`, `register.ts` step 10). It cannot use
this setting - the project is only being registered, so it has no
`projects.toml` entry yet to name a variable in - and `gh`'s login is
the GitHub CLI's configuration rather than Fabrica's, which is the same
reason `src/githubapp/README.md` already records it as out of issue
#187's scope. Moving that one call is its own piece of work.

## Sharp edges found while doing it

- `fabrica doctor`'s **github app** line used to FAIL on an unconfigured
  App whatever the registered projects were. On the machine this issue
  is for, no App can be installed at all - and `fabrica up` stops on any
  blocking FAIL, so that line alone would have made Fabrica unusable
  there. It now checks the App only for projects that actually use it:
  with at least one registered github.com project and every one of them
  naming its own token, the line passes and says so. Zero registered
  projects keeps the old behaviour exactly (an unconfigured App is still
  a FAIL) - "nothing uses it" is a fact about the registry, not about an
  empty one.
- The per-project doctor line (`project <name>`) is where "which path
  does this project use" is reported, because that is the line a reader
  already looks at per project. It FAILs when the named variable holds
  nothing, and when `brain.env` is readable by anyone else - the second
  comes free from `brainEnvValue`, which throws for exactly that, and is
  the same refusal every other credential on the machine gives.
- **A variable's name is validated by the loader, not where it is read.**
  `brainEnvValue` builds a line-matching regular expression out of the
  name it is given, so a `githubTokenVar` carrying regular-expression
  punctuation would match lines nobody wrote. `src/config/load.ts`'s
  `requireEnvVarName` refuses anything that is not a plain environment
  variable name. Every other variable name in Fabrica is derived in code
  (`src/reviewer/resolve.ts`'s `apiKeyVarFor` sanitizes a vendor into
  one), so this is the first one the Client writes by hand - any future
  hand-written variable name needs the same check.
- **`ScopedToken.mint()` now answers `{ token }` and nothing else.** It
  used to answer a `MintedToken` - installation id, granted-permission
  map, expiry, `repository_selection` - and its one consumer
  (`src/inspector/run.ts`) read only the token. Narrowing it is what let
  a project's own token flow through the same seam without inventing App
  facts for the record. Anything that needs those facts holds a
  `TokenMinter` instead.
