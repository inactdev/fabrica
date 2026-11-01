#!/usr/bin/env bash
# check-pin-freshness (issue #326). Fabrica pins Node in four places,
# the coding agent's CLI version in the worker image, its base images by
# digest, and - in README's install instructions - the Go version
# Inspector needs. Nothing watched upstream, so a security release would
# have gone unnoticed indefinitely. This script is what the weekly
# .github/workflows/pin-freshness.yml job runs: it compares every one of
# those pins against upstream and, for each pin that is behind, opens one
# issue naming the exact bump and the exact lines to change, so a Fabrica
# task can take it from there. One issue per stale pin (Client
# clarification on issue #326), and a later run while that issue is still
# open updates it in place rather than opening a second one.
#
# Read-only against upstream - every upstream read here is a GET, and the
# only write anywhere is this repository's own issue.
#
# EVERY PINNED VALUE IS READ OUT OF THE REAL FILE THAT HOLDS IT. There is
# deliberately no committed list of "the pins" to keep in step: a watcher
# whose idea of what is pinned has drifted from the files watches nothing,
# and does it silently. For the same reason, a pin whose value can no
# longer be found where this script expects it FAILS THE JOB, loudly,
# rather than being skipped - a pin that moved is exactly when a watcher
# must speak up.
#
# Where "upstream" is, per pin:
#
#   node          nodejs.org's release index, newest release in the same
#                 major line .node-version itself names
#   worker-cli    the npm dist-tag `latest` of whatever package the worker
#                 Dockerfile installs the agent CLI from
#   node-image    the current manifest-list digest of the tag the worker
#                 Dockerfile's own comment says its digest was taken from
#   go-toolchain  go.dev's current stable release
#   inspector-go  the `go` directive in inactdev/inspector's own go.mod,
#                 against README's "This needs Go N.N+" line
#
# The golang base image is watched by its Go version, not by its digest,
# and that is deliberate: the node line records the tag its digest came
# from (`node:<x.y.z>-alpine`, the spelling src/cli/node-version-pins
# .test.ts already binds), so that digest can be re-resolved, while the
# golang stage records only the Go version it resolves to. Asking a
# registry about a tag nobody wrote down would mean inventing one and
# hoping it was the one that digest came from - a guess that produces
# confident, wrong bumps. Add a tag to that comment the way the node line
# has one and this becomes a second digest pin with no change here.
#
# This script never closes an issue. When a bump lands, the Fabrica task
# that took it closes the issue through its own pull request body
# ("Closes #N", written by src/foreman/pr-body.ts from a task text that
# opens with "Issue #N:"), so the loop closes through the path this
# project already has rather than on this job's guess that two numbers
# matching again means the work is done.
#
# Tested by src/cli/pin-freshness-workflow.test.ts. As well as reading
# this file's source for the facts issue #326 ratified, it sources it in
# a real bash, replaces the five functions below that do I/O with fakes,
# and runs the whole job against this repository's own files - every pin
# fresh, every pin behind, an issue already open, a pull request quoting
# the marker, an unreadable upstream answer. So the comparison, the
# located lines, the titles and the open-or-update decision are all
# really executed; what stays unproven is only whether GitHub answers a
# real request the way the fake does, the same honest limitation
# .github/scripts/sync-inspector-contract.sh documents for itself.
#
# Which is also why the five I/O functions are each one small wrapper
# around one tool, and why gh_json exists at all: the seam a test
# replaces has to be narrow enough that replacing it leaves the real
# logic behind.
set -euo pipefail

# The label every issue this job opens carries. Issues are found again by
# listing open issues with this label - not through the search API, whose
# index lags behind by enough that a second run could open a duplicate
# before the first issue became searchable.
PIN_LABEL_NAME="pin-freshness"
PIN_LABEL_COLOR="0e8a16"
PIN_LABEL_DESCRIPTION="A pin in this repository is behind upstream (opened by the weekly pin-freshness job)"

# The hidden marker that identifies which pin an issue is about. The
# title names the exact bump and therefore changes whenever upstream
# moves again, so the title can never be the thing matched on.
MARKER_PREFIX="fabrica-pin-freshness"

#
# ---------------------------------------------------------------------
# Pure helpers. No I/O, no globals - these are what the test sources and
# calls directly.
# ---------------------------------------------------------------------
#

# version_digits strips a leading "v" or "go" so "v24.18.0", "go1.26.8"
# and "24.18.0" all compare as the same kind of thing. Upstream spells
# its versions three different ways and none of the spellings mean
# anything to the comparison.
version_digits() {
  local v="$1"
  v="${v#v}"
  v="${v#go}"
  printf '%s' "$v"
}

# newer_version OLD NEW returns 0 when NEW is strictly newer than OLD, 1
# when it is the same or older, and 2 when either side cannot be read as
# a dotted numeric version at all.
#
# Compared component by component as integers. Text ordering puts 24.9.0
# *after* 24.18.0, which for a pin watcher is not a cosmetic bug: it both
# hides a real bump and proposes going backwards. A missing trailing
# component counts as 0, so 1.26 and 1.26.0 are the same version.
#
# Status 2 exists so that a prerelease or any other unexpected spelling
# fails the job loudly instead of being quietly treated as "not newer" -
# a silent skip is a bug in this project.
newer_version() {
  local old new
  old=$(version_digits "$1")
  new=$(version_digits "$2")

  case "$old" in "" | *[!0-9.]*) return 2 ;; esac
  case "$new" in "" | *[!0-9.]*) return 2 ;; esac

  local -a a b
  IFS='.' read -r -a a <<<"$old"
  IFS='.' read -r -a b <<<"$new"

  local n=${#a[@]}
  if [ "${#b[@]}" -gt "$n" ]; then n=${#b[@]}; fi

  local i x y
  for ((i = 0; i < n; i++)); do
    x="${a[i]:-0}"
    y="${b[i]:-0}"
    x="${x:-0}"
    y="${y:-0}"
    if [ "$y" -gt "$x" ]; then return 0; fi
    if [ "$y" -lt "$x" ]; then return 1; fi
  done
  return 1
}

# max_version prints the greatest version read from stdin, one per line,
# using newer_version's ordering rather than sort's. Returns 1 on no
# input at all and 2 if any line is not a version - both of which the
# caller turns into a loud failure, because an upstream read that came
# back with nothing usable is not the same as "nothing to do".
max_version() {
  local best="" v rc
  while IFS= read -r v; do
    v="${v//[[:space:]]/}"
    [ -n "$v" ] || continue
    if [ -z "$best" ]; then
      best="$v"
      continue
    fi
    rc=0
    newer_version "$best" "$v" || rc=$?
    case "$rc" in
      0) best="$v" ;;
      1) ;;
      *) return 2 ;;
    esac
  done
  [ -n "$best" ] || return 1
  printf '%s\n' "$best"
}

# short_digest shortens "sha256:<64 hex>" to "sha256:<12 hex>" for a
# title, which has to stay readable. Bodies always carry the full digest.
short_digest() {
  local d="$1"
  case "$d" in
    sha256:*) printf 'sha256:%s' "${d#sha256:}" | cut -c1-19 ;;
    *) printf '%s' "$d" ;;
  esac
}

# pin_title is the one place an issue title is spelled. "the exact bump",
# as issue #326 asks for: what is pinned, what it says now, what upstream
# says.
pin_title() {
  printf 'pin-freshness: %s %s -> %s' "$1" "$2" "$3"
}

# marker_for is the hidden HTML comment that identifies an issue as this
# job's own report about one particular pin.
marker_for() {
  printf '<!-- %s: %s -->' "$MARKER_PREFIX" "$1"
}

#
# ---------------------------------------------------------------------
# Failing loudly.
# ---------------------------------------------------------------------
#

# File descriptor 3 is this script's real stdout, saved here before
# anything can capture it. Most of the reads below hand their answer back
# on stdout, so they are called inside `$( )` - and an annotation written
# to stdout in there is swallowed into the value being computed instead of
# reaching the log. Measured, not assumed: an unreadable release index
# failed the job with no message at all before this. Everything fails
# loudly in this project, so the one thing a failure must never lose is
# its reason.
exec 3>&1

fail() {
  echo "::error::$*" >&3
  exit 1
}

#
# ---------------------------------------------------------------------
# Reading and writing JSON.
#
# With node, not jq. This script already needs node - it reads the agent
# CLI's published version through npm - so node costs nothing, while jq
# is not installed everywhere this repository's own tests run, and a test
# that skips is a test that proves nothing. gh's own `--jq` flag is used
# freely below: that is the jq built into gh, not a system install.
# ---------------------------------------------------------------------
#

# json_field prints one dotted field of the JSON document on stdin, and
# returns non-zero if it is absent or null. An empty path prints the
# document itself, which is how a bare JSON string is unquoted.
json_field() {
  node -e '
    const path = process.argv[1].split(".").filter(Boolean);
    let value = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    for (const key of path) value = value == null ? value : value[key];
    if (value === undefined || value === null) process.exit(3);
    process.stdout.write(String(value));
  ' "$1"
}

# json_versions prints the `version` of every element of the JSON array
# on stdin, one per line, keeping only the elements that pass the two
# filters this script needs: a version prefix ($1), and a field that has
# to be exactly true ($2). Either may be empty.
json_versions() {
  node -e '
    const [prefix, flag] = process.argv.slice(1);
    const list = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (!Array.isArray(list)) process.exit(3);
    for (const entry of list) {
      const version = entry && entry.version;
      if (typeof version !== "string") continue;
      if (prefix && !version.startsWith(prefix)) continue;
      if (flag && entry[flag] !== true) continue;
      console.log(version);
    }
  ' "$1" "$2"
}

# json_object builds a JSON object from name/value pairs, so a title or
# body carrying a quote, a backslash or a newline can never produce a
# malformed request. A name ending in "[]" becomes a single-element
# array, which is all the one array-valued field here (labels) needs.
json_object() {
  node -e '
    const args = process.argv.slice(1);
    const out = {};
    for (let i = 0; i < args.length; i += 2) {
      const name = args[i];
      if (name.endsWith("[]")) out[name.slice(0, -2)] = [args[i + 1]];
      else out[name] = args[i + 1];
    }
    process.stdout.write(JSON.stringify(out));
  ' "$@"
}

#
# ---------------------------------------------------------------------
# Running one command without mixing up its two output streams.
# ---------------------------------------------------------------------
#

# run_capturing runs a command, leaves its stdout in RUN_OUT and its
# stderr - flattened to one line - in RUN_ERR, and returns the command's
# own exit status.
#
# Deliberately not `$(cmd 2>&1)`: npm prints notices on stderr even when
# it succeeds, and docker buildx prints progress there, so a merged
# capture would mix that prose into the JSON about to be parsed. A
# flattened reason also matters because a raw newline ends a `::error::`
# annotation, truncating everything after it.
RUN_OUT=""
RUN_ERR=""
run_capturing() {
  local rc=0 stderr_file
  RUN_OUT=""
  RUN_ERR=""
  stderr_file=$(mktemp) || {
    RUN_ERR="a temporary file to capture stderr could not be created"
    return 1
  }
  RUN_OUT=$("$@" 2>"$stderr_file") || rc=$?
  if [ "$rc" -ne 0 ]; then
    RUN_ERR=$(tr -d '\r' <"$stderr_file" | awk 'NF { gsub(/^[[:space:]]+|[[:space:]]+$/, ""); out = (out == "" ? $0 : out "; " $0) } END { print out }')
    [ -n "$RUN_ERR" ] || RUN_ERR="it exited $rc without printing a reason"
  fi
  rm -f "$stderr_file"
  return "$rc"
}

#
# ---------------------------------------------------------------------
# Upstream reads. All GET, all read-only.
# ---------------------------------------------------------------------
#

# fetch_url prints one URL's body, or fails the job naming the URL.
# --fail turns an HTTP error into a non-zero exit instead of an error
# page that would then be parsed as if it were the real answer.
fetch_url() {
  local url="$1"
  if ! run_capturing curl --fail --silent --show-error --location --max-time 60 --retry 3 --retry-all-errors "$url"; then
    fail "Could not read $url: $RUN_ERR. Failing closed rather than reporting a pin as fresh on a failed read; re-run this job."
  fi
  printf '%s' "$RUN_OUT"
}

# latest_node_in_line prints the newest release in one major line of
# nodejs.org's own release index.
latest_node_in_line() {
  local major="$1" body versions latest rc=0
  body=$(fetch_url "$NODE_INDEX_URL")
  if ! versions=$(printf '%s' "$body" | json_versions "v$major." ""); then
    fail "nodejs.org's release index ($NODE_INDEX_URL) was not readable as the array of releases this job expects. Failing closed; re-run this job."
  fi
  latest=$(printf '%s\n' "$versions" | max_version) || rc=$?
  case "$rc" in
    0) ;;
    1) fail "nodejs.org's release index ($NODE_INDEX_URL) lists no release at all in the ${major}.x line, which is the line .node-version pins. Failing closed rather than reporting that pin as fresh." ;;
    *) fail "nodejs.org's release index ($NODE_INDEX_URL) listed a ${major}.x version this job could not read as a version. Failing closed; a pin watcher that guesses is worse than none." ;;
  esac
  printf '%s' "${latest#v}"
}

# latest_npm_version prints a package's `latest` dist-tag. Asked through
# npm itself rather than a hand-built registry URL: `npm view <spec>
# <field>` is npm's own documented way to read this, and it handles a
# scoped package name without this script having to decide how such a
# name is encoded in a URL.
latest_npm_version() {
  local pkg="$1" out
  if ! run_capturing npm view "$pkg" version --json; then
    fail "Could not read the latest published version of $pkg from the npm registry: $RUN_ERR. Failing closed; re-run this job."
  fi
  # `--json` so the answer is one unambiguous JSON string rather than
  # npm's own display formatting, then unquoted with an empty field path.
  if ! out=$(printf '%s' "$RUN_OUT" | json_field ""); then
    fail "The npm registry's answer for $pkg's latest version was not readable JSON. Failing closed; re-run this job."
  fi
  printf '%s' "$out"
}

# tag_digest prints the current manifest-list digest of a remote image
# tag, without pulling it. Resolved by the same tool a `docker pull`
# would use, so the digest reported here is by construction the digest a
# pull of that tag lands on today.
#
# `--format '{{json .Manifest}}'` and not '{{.Manifest.Digest}}': a plain
# sub-field template is ignored by buildx (docker/buildx#1175) and prints
# the whole human-readable block instead, which would then be compared
# against a digest and always look like a bump.
tag_digest() {
  local ref="$1" digest
  if ! run_capturing docker buildx imagetools inspect "$ref" --format '{{json .Manifest}}'; then
    fail "Could not read $ref's current digest from its registry: $RUN_ERR. Failing closed rather than reporting a digest pin as fresh on a failed read; re-run this job."
  fi
  if ! digest=$(printf '%s' "$RUN_OUT" | json_field "digest") || [ -z "$digest" ]; then
    fail "$ref's registry answer carried no digest this job could read. Failing closed; re-run this job."
  fi
  case "$digest" in
    sha256:*) ;;
    *) fail "$ref's registry answer gave \"$digest\" where a sha256 digest was expected. Failing closed; re-run this job." ;;
  esac
  printf '%s' "$digest"
}

# latest_go_stable prints go.dev's newest stable release ("go1.26.8").
latest_go_stable() {
  local body versions latest rc=0
  body=$(fetch_url "$GO_RELEASES_URL")
  if ! versions=$(printf '%s' "$body" | json_versions "" "stable"); then
    fail "go.dev's release list ($GO_RELEASES_URL) was not readable as the array of releases this job expects. Failing closed; re-run this job."
  fi
  latest=$(printf '%s\n' "$versions" | max_version) || rc=$?
  case "$rc" in
    0) ;;
    1) fail "go.dev's release list ($GO_RELEASES_URL) named no stable release at all. Failing closed rather than reporting the Go pin as fresh." ;;
    *) fail "go.dev's release list ($GO_RELEASES_URL) named a stable release this job could not read as a version. Failing closed." ;;
  esac
  printf '%s' "$latest"
}

# inspector_go_directive prints the `go` directive from Inspector's own
# go.mod, read through the GitHub Contents API - the same read, in the
# same direction, that .github/scripts/sync-inspector-contract.sh makes
# of that repository.
inspector_go_directive() {
  local repo="$1" branch="$2" encoded go_mod directive
  if ! gh_json -X GET "repos/$repo/contents/go.mod" -f ref="$branch" --jq '.content // empty'; then
    fail "Could not read go.mod from $repo@$branch through the GitHub API: $GH_ERR. Failing closed rather than reporting README's Go requirement as current on a failed read; re-run this job."
  fi
  encoded="$GH_OUT"
  if [ -z "$encoded" ]; then
    fail "The GitHub API returned no content for go.mod on $repo@$branch. Failing closed; re-run this job."
  fi
  if ! go_mod=$(printf '%s' "$encoded" | tr -d '\n' | base64 -d 2>/dev/null); then
    fail "go.mod's content from $repo@$branch was not valid base64, so it could not be decoded. Failing closed; re-run this job."
  fi
  directive=$(printf '%s\n' "$go_mod" | sed -n 's/^go[[:space:]]\{1,\}\([0-9][0-9.]*\).*$/\1/p' | head -1)
  if [ -z "$directive" ]; then
    fail "go.mod on $repo@$branch carries no \`go\` directive this job could read, so there is nothing to compare README's Go requirement against. Failing closed; re-run this job."
  fi
  printf '%s' "$directive"
}

#
# ---------------------------------------------------------------------
# Reading this repository's own pins.
# ---------------------------------------------------------------------
#

# require_file keeps a moved or renamed file from reading as an absent
# pin. Called as a statement rather than inside a command substitution on
# purpose: `fail` exits, and an exit inside `$( )` only ends the subshell -
# which a pipeline's own exit status then hides.
require_file() {
  local path="$1"
  if [ ! -f "$path" ]; then
    fail "$path does not exist in this checkout, so the pin it is supposed to hold cannot be read. This job watches that file; fix the path in .github/scripts/check-pin-freshness.sh."
  fi
}

#
# ---------------------------------------------------------------------
# The issue: one per stale pin, updated in place on a later run.
# ---------------------------------------------------------------------
#

# gh_json runs one `gh api` call, leaves the response in GH_OUT and a
# one-line failure reason in GH_ERR, and returns gh's own exit status.
# Every caller fails the job on a non-zero return: there is no partial
# state here worth waving through.
#
# A named wrapper rather than run_capturing at every call site because
# this is also the one function the test replaces to run the whole job
# without touching GitHub.
GH_OUT=""
GH_ERR=""
gh_json() {
  local rc=0
  run_capturing gh api "$@" || rc=$?
  GH_OUT="$RUN_OUT"
  GH_ERR="$RUN_ERR"
  return "$rc"
}

# ensure_label creates the label if it does not exist yet. Whether
# POST /repos/.../issues creates an unknown label is not documented
# either way, and an unknown label is "silently dropped" for anyone
# without push access - either of which would leave an issue this job
# could never find again, so it opens a duplicate every week instead of
# updating the one it already has. Created explicitly rather than relying
# on unspecified behaviour.
#
# A failed create is re-checked with one more read before the job fails:
# a transient error on the read above is indistinguishable from "no such
# label", and the create that follows it then fails as already-existing.
# That must not be reported as a broken job.
ensure_label() {
  if gh_json -X GET "repos/$REPO/labels/$PIN_LABEL_NAME" >/dev/null 2>&1; then
    return 0
  fi
  # Handed over as a JSON body on stdin rather than as `-f` fields, so a
  # request is always valid JSON however its values are spelled. Passed
  # with a here-string, never a pipe: a function on the right of a pipe
  # runs in a subshell, and gh_json's captured error would not survive
  # it.
  local payload
  payload=$(json_object \
    name "$PIN_LABEL_NAME" \
    color "$PIN_LABEL_COLOR" \
    description "$PIN_LABEL_DESCRIPTION")
  if gh_json -X POST "repos/$REPO/labels" --input - <<<"$payload"; then
    return 0
  fi
  if gh_json -X GET "repos/$REPO/labels/$PIN_LABEL_NAME" >/dev/null 2>&1; then
    return 0
  fi
  fail "Could not create the \"$PIN_LABEL_NAME\" label on $REPO: $GH_ERR. Failing closed - without it an issue opened now could not be found again, and this job would open a second one next week."
}

# find_pin_issue prints the number of this job's own open issue for one
# pin, or nothing. Matched on the body marker, never the title.
#
# Pull requests are filtered out: GitHub's REST API "considers every pull
# request an issue", so a pull request quoting the marker would otherwise
# be mistaken for this job's issue - and "updating" a pull request means
# rewriting its body.
#
# One page of 100 is the endpoint's maximum and is not paginated: there
# are a handful of pins, so one open issue each, and `--paginate` with a
# `--jq` filter concatenates one answer per page rather than one answer.
# The first line is taken regardless, so a multi-line answer can never
# become a malformed endpoint path.
find_pin_issue() {
  local key="$1" marker
  marker=$(marker_for "$key")
  if ! gh_json -X GET "repos/$REPO/issues" \
    -f state=open \
    -f labels="$PIN_LABEL_NAME" \
    -f per_page=100 \
    --jq "[.[] | select(.pull_request == null) | select((.body // \"\") | contains(\"$marker\")) | .number] | first // empty"; then
    fail "Could not list $REPO's open \"$PIN_LABEL_NAME\" issues: $GH_ERR. Failing closed rather than opening an issue that might be a duplicate; re-run this job."
  fi
  printf '%s' "${GH_OUT%%$'\n'*}"
}

# open_or_update opens the issue for one pin, or updates the one that is
# already open for it. Title and body are both rewritten on an update, so
# an issue opened for one bump reports the newer one once upstream moves
# again.
open_or_update() {
  local key="$1" title="$2" body="$3" existing payload

  existing=$(find_pin_issue "$key")

  if [ -n "$existing" ]; then
    payload=$(json_object title "$title" body "$body")
    if ! gh_json -X PATCH "repos/$REPO/issues/$existing" --input - <<<"$payload"; then
      fail "Could not update issue #$existing on $REPO: $GH_ERR. Failing closed; re-run this job."
    fi
    echo "Updated #$existing: $title"
    return 0
  fi

  ensure_label
  payload=$(json_object title "$title" body "$body" "labels[]" "$PIN_LABEL_NAME")
  if ! gh_json -X POST "repos/$REPO/issues" --input - --jq '.html_url // empty' <<<"$payload"; then
    fail "Could not open an issue on $REPO for the $key pin: $GH_ERR. Failing closed; re-run this job."
  fi
  echo "Opened ${GH_OUT:-an issue}: $title"
}

#
# ---------------------------------------------------------------------
# One pin.
# ---------------------------------------------------------------------
#

# consider_pin decides whether one pin is behind upstream and, if it is,
# opens or updates its issue. Its inputs are the PIN_* variables the
# caller sets just above the call: a pin needs nine facts, two of them
# arrays, and nine positional parameters read far worse than nine named
# ones.
#
#   PIN_KEY       the stable identity in the issue's marker
#   PIN_LABEL     how the pin is named to a reader
#   PIN_CURRENT   what this repository pins today
#   PIN_LATEST    what upstream says today
#   PIN_MODE      "version" (ordered) or "digest" (equal or not)
#   PIN_UPSTREAM  where upstream was read, for the issue body
#   PIN_NOTE      what else has to move with this pin
#   PIN_NEEDLES   the literal text to locate in the files below
#   PIN_FILES     the files that hold this pin
consider_pin() {
  local locations stale=0 rc=0 title body current_shown latest_shown

  locations=$(pin_locations)
  if [ -z "$locations" ]; then
    fail "This job watches the $PIN_KEY pin by looking for $(printf '"%s" ' "${PIN_NEEDLES[@]}")in ${PIN_FILES[*]}, and found none of it. The pin has moved or been reworded, so this job is now watching nothing - fix .github/scripts/check-pin-freshness.sh rather than leaving it silently blind."
  fi

  if [ "$PIN_MODE" = "digest" ]; then
    if [ "$PIN_CURRENT" != "$PIN_LATEST" ]; then
      stale=1
    fi
    current_shown=$(short_digest "$PIN_CURRENT")
    latest_shown=$(short_digest "$PIN_LATEST")
  else
    newer_version "$PIN_CURRENT" "$PIN_LATEST" || rc=$?
    case "$rc" in
      0) stale=1 ;;
      1) stale=0 ;;
      *) fail "The $PIN_KEY pin could not be compared: this repository says \"$PIN_CURRENT\" and upstream says \"$PIN_LATEST\", and at least one of those is not a dotted numeric version. Failing closed rather than guessing which is newer." ;;
    esac
    current_shown="$PIN_CURRENT"
    latest_shown="$PIN_LATEST"
  fi

  if [ "$stale" -eq 0 ]; then
    echo "$PIN_KEY: $PIN_LABEL is current at $current_shown"
    return 0
  fi

  echo "$PIN_KEY: $PIN_LABEL is behind - $current_shown -> $latest_shown"
  title=$(pin_title "$PIN_LABEL" "$current_shown" "$latest_shown")
  body=$(pin_body "$locations")
  open_or_update "$PIN_KEY" "$title" "$body"
}

# pin_locations prints every line of every file this pin lives on, as
# `path:line:content` - "the exact lines to change", read out of the real
# files rather than described from memory. Multiple needles are passed to
# one grep so a line matching two of them is still listed once.
pin_locations() {
  local file needle out="" hits
  local -a patterns=()
  for needle in "${PIN_NEEDLES[@]}"; do
    patterns+=(-e "$needle")
  done
  for file in "${PIN_FILES[@]}"; do
    [ -f "$file" ] || fail "$PIN_KEY's pin is supposed to live in $file, which does not exist in this checkout. Fix the path in .github/scripts/check-pin-freshness.sh."
    hits=$(grep -n -F "${patterns[@]}" -- "$file" || true)
    [ -n "$hits" ] || continue
    while IFS= read -r hit; do
      out+="$file:$hit"$'\n'
    done <<<"$hits"
  done
  printf '%s' "$out"
}

# pin_body is the issue body: what moved, where every line that has to
# change is, what else moves with it, and the marker that makes this
# issue findable again next week.
pin_body() {
  local locations="$1"
  cat <<BODY
Upstream has moved past a pin this repository holds.

| | |
| --- | --- |
| pin | $PIN_LABEL |
| pinned here | \`$PIN_CURRENT\` |
| upstream now | \`$PIN_LATEST\` |
| upstream read from | $PIN_UPSTREAM |

### The exact lines to change

\`\`\`text
$locations
\`\`\`

### What else moves with it

$PIN_NOTE

### Before this is done

Run \`npm test\` - this repository's pins are held together by tests
(\`src/cli/node-version-pins.test.ts\` for Node,
\`src/relay/container/relay-image-digest.test.ts\` for the node base
image digest), so a partial bump fails the suite rather than landing.

---

Opened automatically by [\`.github/workflows/pin-freshness.yml\`]($SERVER_URL/$REPO/blob/master/.github/workflows/pin-freshness.yml) ($RUN_LINK). Nothing here has been
verified against this repository's own tests - that is the work this
issue is for.

While this issue is open, a later run of that job updates it in place
instead of opening a second one for the same pin. It never closes this
issue: merging the bump does that, from the pull request's own
\`Closes\` line.

$(marker_for "$PIN_KEY")
BODY
}

#
# ---------------------------------------------------------------------
# main
# ---------------------------------------------------------------------
#

NODE_INDEX_URL="https://nodejs.org/dist/index.json"
GO_RELEASES_URL="https://go.dev/dl/?mode=json"

NODE_VERSION_FILE=".node-version"
WORKER_DOCKERFILE="src/brain/adapters/docker/Dockerfile"
INSPECTOR_DOCKERFILE="Dockerfile.inspector"
RELAY_LAUNCH="src/relay/container/launch.ts"
INSPECTOR_CONSTANTS="src/inspector/doctor-checks.ts"
PACKAGE_JSON="package.json"
README="README.md"

main() {
  : "${GH_TOKEN:?a GitHub token is required to open or update an issue}"
  : "${GITHUB_REPOSITORY:?this job must know which repository to open the issue on}"
  cd "$(dirname "${BASH_SOURCE[0]}")/../.."

  REPO="$GITHUB_REPOSITORY"
  SERVER_URL="${GITHUB_SERVER_URL:-https://github.com}"
  if [ -n "${GITHUB_RUN_ID:-}" ]; then
    RUN_LINK="[this run]($SERVER_URL/$REPO/actions/runs/$GITHUB_RUN_ID)"
  else
    RUN_LINK="a run of that job"
  fi

  require_file "$WORKER_DOCKERFILE"
  local worker_dockerfile
  worker_dockerfile=$(cat "$WORKER_DOCKERFILE")

  # ---- Node, in all four places -------------------------------------
  #
  # .node-version is the one this reads, because it is the one
  # src/cli/node-version-pins.test.ts measures the other three against.
  # The major line comes from the pin itself, so this job proposes the
  # newest release of the line Fabrica is on and never a jump to the
  # next major - which is a decision, not a bump.
  require_file "$NODE_VERSION_FILE"
  local pinned_node node_major latest_node
  pinned_node=$(tr -d '[:space:]' <"$NODE_VERSION_FILE")
  case "$pinned_node" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) fail "$NODE_VERSION_FILE says \"$pinned_node\", which is not an exact major.minor.patch version. Failing closed; node-version-pins.test.ts requires an exact version and this job compares against one." ;;
  esac
  node_major="${pinned_node%%.*}"
  latest_node=$(latest_node_in_line "$node_major")

  PIN_KEY="node"
  PIN_LABEL="Node"
  PIN_CURRENT="$pinned_node"
  PIN_LATEST="$latest_node"
  PIN_MODE="version"
  PIN_UPSTREAM="[nodejs.org's release index]($NODE_INDEX_URL), newest release in the ${node_major}.x line"
  PIN_NOTE="All four Node declarations have to move together -
\`src/cli/node-version-pins.test.ts\` fails a partial bump. Bumping Node
also means the node base image digest below is re-resolved from the new
\`node:$latest_node-alpine\` tag, and \`Dockerfile.inspector\`'s
\`cimg/node\` tag needs a published CircleCI image for that version."
  PIN_NEEDLES=("$pinned_node")
  PIN_FILES=("$NODE_VERSION_FILE" "$PACKAGE_JSON" "$INSPECTOR_DOCKERFILE" "$WORKER_DOCKERFILE")
  consider_pin

  # ---- the worker image's agent CLI ---------------------------------
  #
  # Both the package name and the pinned version are read off the
  # Dockerfile's own install line, so this job asks the registry about
  # whatever that line actually installs rather than carrying a package
  # name of its own that could drift from it.
  local cli_line cli_spec cli_package cli_version latest_cli
  cli_line=$(printf '%s\n' "$worker_dockerfile" | grep -E '^RUN npm install -g [^[:space:]]+@[0-9]' | head -1 || true)
  if [ -z "$cli_line" ]; then
    fail "$WORKER_DOCKERFILE no longer carries a \`RUN npm install -g <package>@<version>\` line, so the agent CLI version this job watches cannot be read. Fix .github/scripts/check-pin-freshness.sh rather than leaving that pin unwatched."
  fi
  cli_spec="${cli_line##*npm install -g }"
  cli_spec="${cli_spec%%[[:space:]]*}"
  cli_package="${cli_spec%@*}"
  cli_version="${cli_spec##*@}"
  if [ -z "$cli_package" ] || [ -z "$cli_version" ]; then
    fail "\"$cli_spec\" in $WORKER_DOCKERFILE could not be read as <package>@<version>. Failing closed; re-run this job after fixing that line or this script."
  fi
  latest_cli=$(latest_npm_version "$cli_package")

  PIN_KEY="worker-cli"
  PIN_LABEL="worker CLI"
  PIN_CURRENT="$cli_version"
  PIN_LATEST="$latest_cli"
  PIN_MODE="version"
  PIN_UPSTREAM="\`npm view $cli_package version\` (the registry's \`latest\` dist-tag)"
  PIN_NOTE="The worker image has to be rebuilt for this to take effect, and
\`fabrica doctor\`'s **worker CLI** line compares the installed version
against this pinned one. The adapter's own notes
(\`src/brain/adapters/claude-code.md\`) record flag and output-shape
behaviour verified against the pinned version - a bump is the moment to
re-check those, which is why this is a task rather than a one-line edit."
  PIN_NEEDLES=("$cli_spec")
  PIN_FILES=("$WORKER_DOCKERFILE")
  consider_pin

  # ---- the node base image's digest ---------------------------------
  #
  # The tag comes out of the Dockerfile's own comment - the only record
  # of which Node that digest is, and the spelling
  # node-version-pins.test.ts already binds. A digest that changed while
  # the tag stayed put is a rebuild of the same version, which is
  # exactly how an Alpine or Node security rebuild arrives.
  local node_tag_version node_image_tag pinned_node_digest latest_node_digest
  node_tag_version=$(printf '%s\n' "$worker_dockerfile" | sed -n 's/.*\bnode:\([0-9][0-9.]*\)-alpine\b.*/\1/p' | head -1)
  if [ -z "$node_tag_version" ]; then
    fail "$WORKER_DOCKERFILE no longer records the \`node:<x.y.z>-alpine\` tag its digest was taken from, so that digest cannot be re-resolved. Keep that spelling (src/cli/node-version-pins.test.ts depends on it too) or fix this script."
  fi
  node_image_tag="node:$node_tag_version-alpine"
  pinned_node_digest=$(printf '%s\n' "$worker_dockerfile" | sed -n 's/^FROM node@\(sha256:[0-9a-f]\{1,\}\).*/\1/p' | head -1)
  if [ -z "$pinned_node_digest" ]; then
    fail "$WORKER_DOCKERFILE no longer pins its node base image as \`FROM node@sha256:...\` on its own line, so there is no digest to compare. Fix this script, or that line."
  fi
  latest_node_digest=$(tag_digest "$node_image_tag")

  PIN_KEY="node-image"
  PIN_LABEL="node base image digest"
  PIN_CURRENT="$pinned_node_digest"
  PIN_LATEST="$latest_node_digest"
  PIN_MODE="digest"
  PIN_UPSTREAM="\`docker buildx imagetools inspect $node_image_tag\` (the current manifest-list digest of that tag)"
  PIN_NOTE="\`$RELAY_LAUNCH\`'s \`RELAY_IMAGE\` holds the identical digest on
purpose and must move with it -
\`src/relay/container/relay-image-digest.test.ts\` fails if the two
disagree. The tag itself has not changed, so this is a rebuild of the
same Node version (an Alpine or Node security rebuild looks exactly
like this), and the Dockerfile's \"Resolves to ...\" comment should be
re-checked against what the new digest actually contains."
  PIN_NEEDLES=("$pinned_node_digest")
  PIN_FILES=("$WORKER_DOCKERFILE" "$RELAY_LAUNCH")
  consider_pin

  # ---- the worker image's Go toolchain ------------------------------
  #
  # Watched by the Go version its comment records, not by its digest -
  # see this file's header for why that is deliberate.
  local pinned_go latest_go golang_digest
  pinned_go=$(printf '%s\n' "$worker_dockerfile" | sed -n 's/.*\bgo\(1\.[0-9][0-9.]*\)\b.*/\1/p' | head -1)
  if [ -z "$pinned_go" ]; then
    fail "$WORKER_DOCKERFILE no longer records the \`go1.x.y\` version its golang stage resolves to, which is the only record of which Go that digest is. Keep that spelling or fix this script."
  fi
  golang_digest=$(printf '%s\n' "$worker_dockerfile" | sed -n 's/^FROM golang@\(sha256:[0-9a-f]\{1,\}\).*/\1/p' | head -1)
  if [ -z "$golang_digest" ]; then
    fail "$WORKER_DOCKERFILE no longer pins a \`FROM golang@sha256:...\` stage, so the Go toolchain this job watches is gone. Fix this script, or that line."
  fi
  latest_go=$(latest_go_stable)

  PIN_KEY="go-toolchain"
  PIN_LABEL="worker Go toolchain"
  PIN_CURRENT="go$pinned_go"
  PIN_LATEST="$latest_go"
  PIN_MODE="version"
  PIN_UPSTREAM="[go.dev's release list]($GO_RELEASES_URL), newest stable release"
  PIN_NOTE="This stage is pinned by digest, so taking the bump means resolving
the new digest for the \`golang\` image that carries $latest_go (by
manifest-list digest, so it stays correct on arm64 and amd64) and
updating the \"Resolves to ...\" comment with what it really contains.
The comment records no tag today, which is why this pin is watched by
its Go version rather than by its digest - writing the tag next to the
digest, the way the node line does, would let it be watched by digest
too."
  PIN_NEEDLES=("$golang_digest" "go$pinned_go")
  PIN_FILES=("$WORKER_DOCKERFILE")
  consider_pin

  # ---- the Go version Inspector needs -------------------------------
  #
  # README tells the Client which Go to have installed before
  # `go install`-ing Inspector. Inspector's own go.mod is what actually
  # decides that, so a raised directive there makes README's line wrong
  # for anyone following it.
  require_file "$README"
  require_file "$INSPECTOR_CONSTANTS"
  local readme_go inspector_module inspector_repo inspector_ref inspector_branch inspector_go
  readme_go=$(sed -n 's/.*[Gg]o \*\{0,2\}\([0-9][0-9.]*\)+\*\{0,2\}.*/\1/p' "$README" | head -1)
  if [ -z "$readme_go" ]; then
    fail "$README no longer states a minimum Go version (\"This needs **Go N.N+**\") for installing Inspector, so there is nothing to compare Inspector's own go.mod against. Fix this script if that sentence moved."
  fi
  inspector_module=$(sed -n 's/.*INSPECTOR_MODULE_PATH = "\([^"]*\)".*/\1/p' "$INSPECTOR_CONSTANTS" | head -1)
  inspector_ref=$(sed -n 's/.*INSPECTOR_MAIN_REF = "refs\/heads\/\([^"]*\)".*/\1/p' "$INSPECTOR_CONSTANTS" | head -1)
  if [ -z "$inspector_module" ] || [ -z "$inspector_ref" ]; then
    fail "$INSPECTOR_CONSTANTS no longer declares INSPECTOR_MODULE_PATH and INSPECTOR_MAIN_REF, which is where this job learns which repository and branch Inspector's go.mod lives on. Fix this script rather than hardcoding them again."
  fi
  inspector_repo="${inspector_module#github.com/}"
  inspector_branch="$inspector_ref"
  inspector_go=$(inspector_go_directive "$inspector_repo" "$inspector_branch")

  PIN_KEY="inspector-go"
  PIN_LABEL="Inspector's minimum Go"
  PIN_CURRENT="$readme_go"
  PIN_LATEST="$inspector_go"
  PIN_MODE="version"
  PIN_UPSTREAM="the \`go\` directive in [$inspector_repo's go.mod]($SERVER_URL/$inspector_repo/blob/$inspector_branch/go.mod)"
  PIN_NOTE="README's sentence is what a Client reads before \`go install\`-ing
Inspector; Inspector's own \`go\` directive is what actually decides
whether that install works. Nothing in this repository breaks - the
sentence is just wrong for anyone following it with an older toolchain."
  PIN_NEEDLES=("Go $readme_go+" "Go **$readme_go+**")
  PIN_FILES=("$README")
  consider_pin

  echo "Every pin compared."
}

# Run main() when this file is executed directly (the CI workflow step),
# never when sourced - src/cli/pin-freshness-workflow.test.ts sources
# this file to call the pure helpers above, and must not set off a real
# GitHub API run by doing so.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
