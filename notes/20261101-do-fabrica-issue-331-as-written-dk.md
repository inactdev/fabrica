# A project that publishes with the `gh` login (issue #331)

## The plan, and the alternative that was rejected first

`projects.toml` gains a second, mutually exclusive way to say which
credential one project's GitHub operations use:

```toml
[projects.dayjob]
path        = "~/work/widgets"
githubToken = "gh"          # instead of githubTokenVar = "..."
```

**Chosen.** A fourth `ProjectTokenResolution` kind, `{ kind: "gh" }`,
that is purely *declarative* — it says which credential, and holds no
credential. The one place a gh token ever exists is inside
`taskGithubCredential`'s own `token()` call frame, which runs `gh auth
token --hostname github.com` at the moment of that one GitHub call and
discards the answer when the call returns.

**Rejected: resolve `gh` into the existing `{ kind: "token" }` shape** —
i.e. have `resolveProjectToken` run `gh auth token` itself and hand back
`{ variable: "gh", token }`. It is less code and needs no new union
member, and it was rejected on safety. `resolveProjectToken` is called
by `fabrica doctor` on every registered project, by issue #304's start
gate, and by every credential description — all of which only want to
know *which* credential a project uses. Reading a live credential on
each of those calls, and carrying it inside a returned object that
outlives the call that needs it, would turn the issue's "used for that
call only, never written anywhere" from a property of the code's shape
into a property of each caller's good behaviour. The declarative kind
keeps it true by construction, which is the same reason
`src/projecttoken/` exists at all rather than each call site reading
`brain.env` for itself.

Rejected for the same reason: a `gh`-backed `ProjectToken` whose `token`
field is a getter or a thunk. That is the same leak with a lazier
spelling, and it would make `ProjectToken` — a struct whose whole
contract is "the value, never printed" — carry behaviour.

## Sharp edges worth keeping

- **`gh auth token` prints the token on stdout.** Every refusal and
  every doctor line built from a failed `gh` run therefore reads
  `stderr` only, never `stdout`. A diagnostic that echoed the command's
  whole output would print the credential into the Client's terminal and
  into `fabrica log`. `src/projecttoken/gh.ts` is the only place that
  spawns it, and it never returns, logs or records the stdout it read
  except as the token itself.
- **gh's documented exit codes** (`gh help exit-codes`): 0 success, 1
  failure, 2 cancelled, **4 authentication required**. 4 is "logged out"
  and is reported as that; 1 is reported as whatever gh said on stderr.
  A spawn that fails with `ENOENT` is "not installed", which is a
  different fix (`brew install gh`) from "not logged in" (`gh auth login
  --hostname github.com`).
- **`gh auth token` refreshes an expiring token before printing it**
  unless `--no-refresh` is passed. Fabrica does not pass it: a refresh is
  exactly what makes this setting worth having over a copied token, so
  the one call per GitHub operation is also what keeps the login fresh.
- **Every place that had to learn there is a third credential**, since
  "a project not using the App" was previously the same thing as "a
  project naming `githubTokenVar`": `src/cli/doctor-command.ts`'s
  `registeredProjectRepos` (which projects the App's line asks GitHub
  about) and `registeredOwnTokens` (which it names as not asked), and
  `src/githubapp/doctor-checks.ts`'s `ProjectOwnToken`, whose `variable`
  is now optional - a `gh` project has no variable to name. A future
  fourth credential has the same list to update, and TypeScript only
  catches the `ProjectTokenResolution` half of it: those two functions
  read `ProjectConfig` fields directly, so they would compile fine while
  being wrong.
- **One existing test had to be rewritten, not just added to**:
  `src/config/load.test.ts`'s "the unknown-field refusal names
  githubTokenVar" used `githubToken = "github_pat_fake"` as its
  stand-in *unknown* field. That spelling is now a recognized setting
  with a refused value, so the test uses `githubTokenVariable` instead.
  Worth knowing because the mistake it imitates is a real one - pasting
  the token where the source name belongs - and `githubToken`'s own
  refusal names `githubTokenVar` for exactly that reader.
- **Evidence versus the absence of it**, the same ruling issue #304's
  gate was built on: the push check (`GET /repos/{owner}/{repo}` →
  `permissions.push`) refuses a task only on a *definite* no — gh
  missing, logged out, or GitHub answering that the login cannot push
  (including 401/403/404, where "cannot see it" and "cannot push to it"
  are the same answer to the Client). A read that could not be taken at
  all (network down, 5xx, a body that will not parse) is reported as
  unknown: `fabrica doctor` passes the line with a note, and a task
  starts, because refusing on an unasked question would stop work on a
  project that is configured correctly every time the machine is offline.
