# src/projecttoken

Which GitHub credential one project's operations go through (issue #314,
the first of three work-mode settings; widened by issue #331). One
question, one answer, in one place.

## Why this exists

`src/githubapp` exists because a personal token that can touch every
repository the Client owns is too much credential for one push. Its
answer — a GitHub App, minting a one-repository, one-hour token per call
— is still the default and still what every project uses.

But an App has to be *installed*, and on a company GitHub organization
that decision is not the Client's to make. At his day job it cannot be
installed at all, and Fabrica there is the sealed box plus Inspector,
with him answering every question himself. So a project may name, in
`projects.toml`, the variable in `brain.env` holding a fine-grained
personal token scoped to that one repository:

```toml
[projects.dayjob]
path           = "~/work/widgets"
check          = "./check.sh"
githubTokenVar = "DAYJOB_GITHUB_TOKEN"
```

The name, never the value. The token is read from `brain.env` exactly
like every other credential on the machine — Fabrica's own environment
first, then that 600-mode file — and the only half that is ever printed,
recorded or put in a message is the variable's name.

## The second form: the `gh` login (issue #331)

At the same day job, the Client already works in that repository through
the GitHub CLI, logged in as himself. Copying *that* token into
`brain.env` would be a second copy of one secret on disk, and it goes
stale every time `gh` refreshes the login. So a project may name the
login instead of a variable:

```toml
[projects.dayjob]
path        = "~/work/widgets"
check       = "./check.sh"
githubToken = "gh"
```

Every GitHub operation for such a project runs `gh auth token --hostname
github.com` **at the moment of that one call**, uses the answer for that
call, and discards it. Nothing is cached, written to disk, logged, or put
on the record — the record says `gh` was asked and what for
(`"project-token-used"` with `source: "gh"`), and nothing else.

`githubToken` and `githubTokenVar` are mutually exclusive, refused
together by the loader (`src/config/load.ts`) rather than resolved by a
precedence rule: publishing under whichever credential a precedence rule
happened to pick is exactly what rule 1 below exists to prevent.

Two files, two questions:

| file | answers |
|---|---|
| `gh.ts` | can this machine produce a github.com token from `gh` at all - and the two sharp edges of asking: `gh auth token` prints the credential on **stdout** (so every message is built from `stderr` only), and "not installed" (ENOENT) is a different finding, with a different fix, from "not logged in" (gh's own exit code 4) |
| `gh-push.ts` | can the account that login belongs to actually push here - `GET /repos/{owner}/{repo}`'s `permissions.push`, read from GitHub's own answer rather than inferred from the login working |

`gh-push.ts` has **three** answers, not two, and the third one matters:
a definite no (no `gh`, no login, GitHub saying this login cannot push,
including 401/403/404) refuses a task and FAILs the doctor line; a
question that could not be asked at all (network down, a 500, a body
that will not parse) is `unknown`, which the doctor line says out loud
and passes, and which starts the task. That is the ruling issue #304's
own gate was built on — evidence versus the absence of it — and without
it every offline minute would refuse work on a correctly configured
project.

### What this form gets back

Issue #304's start gate is *available* again here, by a different route:
an OAuth login's write access to one repository is readable where a
fine-grained token's own scopes are not. And a login with the `repo`
scope can read a pull request's check runs, so such a project's CI
result shows up in `fabrica status` again.

## The three rules this module exists to keep

All three hold for the `gh` form above word for word; read "its own
credential" for "a token" throughout.

1. **Never a fallback, in either direction** (the issue's own
   clarification). A project names a credential of its own or it uses
   the App. A named variable holding nothing, or a `gh` that is not
   logged in, is a refusal, never a quiet mint off the App; and a
   machine with no App configured at all is not an error for a project
   that has its own.
2. **Every GitHub operation, not just the push** (the Client's
   clarification on the issue). The push, the pull request, the issue a
   task names, and the checks on that pull request.
3. **The App is never reached for such a project.** Not "is not
   normally reached" — `src/foreman/github-token.ts`'s
   `taskGithubCredential` is the only way any code in Fabrica gets a
   GitHub token for a task, and it asks this module first. A GitHub call
   added later cannot accidentally get the App for a token project,
   because there is nowhere else for it to get a token from.

## Where the answer is used

| caller | what it does with it |
|---|---|
| `src/foreman/github-token.ts`'s `taskGithubCredential` | the chokepoint: returns the App's recording minter, this project's own token, or a token read from `gh` right then, for all three purposes (`publish`, `read-issue`, `read-checks`) |
| `src/foreman/publish-permissions.ts` | issue #304's start gate reads what GitHub *granted* on a minted App token; a token project mints none, so the gate is skipped for it (see below) — a `gh` project gets it back through `ghPublishAnswer` |
| `src/cli/doctor-command.ts` | the per-project line: which path this project uses, and a FAIL when the named variable holds nothing, `brain.env` is readable by others, or the `gh` login cannot push here |
| `src/githubapp/doctor-checks.ts` | the App's own line asks nothing about either kind, and passes with no App at all when every registered project has a credential of its own |

### What a project token gives up, and why that is not hidden

Issue #304's gate works by minting a publishing token at task start and
reading the `permissions` map GitHub puts on it — a permission the
installation never accepted is only visible there. A fine-grained
personal token has no such map that any API exposes, so for a token
project that gate is **skipped rather than guessed at**: a permission
the Client forgot shows up as a failed push at the end of the round,
which is where it used to show up for everyone. `README.md` says this
out loud to the Client rather than leaving him to find it.

What still refuses before any worker starts is a token that is missing
entirely: `publishToken`'s `check()`, through `Inspector.prepare()`.

## The record

A project token is not minted, so it leaves no `"token-minted"` event.
It leaves `"project-token-used"` instead (declared in
`src/inspector/types.ts`'s widening, details in
`src/foreman/github-token.ts`'s `ProjectTokenUsedDetails`): what the
call was for, the repository, and where the credential came from —
`source: "brain.env"` with the variable's name, or `source: "gh"` with
no name to give. Never the token.

A separate event name rather than a flag on the existing one, because
nothing was minted: there is no installation, no granted-permission map
and no expiry, and a record that invented them would be a record nobody
could trust.

## Testing

`resolve.test.ts` drives the whole of it with a throwaway record home
and an explicitly-passed environment — never the machine's own, where a
token sitting in the tester's shell would make a test pass for a reason
that has nothing to do with the code. The credential's own wiring (the
App never being reached, the event, the refusal) is
`src/foreman/github-token.test.ts`, with `src/githubapp`'s fake minter
standing in for the App: a fake that was never asked records nothing,
which is exactly the assertion.

`gh.test.ts` and `gh-push.test.ts` follow the same rule one step
further: they spawn a **real** stand-in `gh` (`helpers/fake-gh.ts`
writes one and hands back a PATH holding only it), because what is
being tested is how an exit code, a stdout and a stderr are read — a
function-shaped seam standing in for the spawn would test neither. The
machine's own `gh` is never reached, or the tester's GitHub login would
decide whether a test passes.
