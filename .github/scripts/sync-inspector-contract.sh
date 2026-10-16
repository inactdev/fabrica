#!/usr/bin/env bash
# sync-inspector-contract (issue #109, "Fabrica side"). Fabrica commits
# src/inspector/consumer-contract.json as the one ratified copy of the
# call it makes to Inspector (flags, exit codes, the pull-request stdout
# line, the token env var); Inspector keeps its own copy at
# cmd/inspector/testdata/fabrica-consumer-contract.json, read by
# TestFabricaConsumerContract. Nothing kept the two in step on its own -
# a sentence telling people to do it by hand is not reliable (Client
# ruling, issue #109). This script is the half that runs here: on every
# push to Fabrica's default branch that changes the file (the workflow's
# own path filter), it reads Inspector's current copy through the GitHub
# Contents API - the same kind of read inspector's own
# fabrica-contract-check.sh does in the other direction - and, if the two
# no longer match byte-for-byte, opens or updates a pull request on
# inactdev/inspector that replaces Inspector's copy wholesale with
# Fabrica's file. The Inspector-side half (inspector PR #45) is what then
# fails Inspector's own CI on any other way of changing that file.
#
# Every GitHub call fails the job closed, naming the cause: there is no
# partial state here that is safe to wave through, and "worked last time"
# is not evidence the sync itself happened.
#
# This file has two callers, matching inspector's own
# fabrica-contract-check.sh split:
#   - the CI workflow step, which executes it directly; the guard at the
#     bottom calls main() to do the real GitHub API work
#   - nothing yet unit-tests main()'s own API orchestration outside a
#     real Actions run, the same honest limitation
#     fabrica-contract-check.sh documents for itself; this is proven
#     instead by contract-sync-workflow.test.ts reading this file's and
#     the workflow's own source for the facts that matter.
set -euo pipefail

INSPECTOR_REPO="inactdev/inspector"
INSPECTOR_CONTRACT_PATH="cmd/inspector/testdata/fabrica-consumer-contract.json"
FABRICA_CONTRACT_PATH="src/inspector/consumer-contract.json"
# Fixed, so a second change re-pushes onto the same open pull request
# instead of opening a second one (Client ruling, issue #109).
SYNC_BRANCH="fabrica-sync/consumer-contract"

# api_failure_reason turns a failed `gh` call's captured stderr into one
# annotation-safe line - a raw newline ends a `::error::` annotation.
# Duplicated from inspector's own fabrica-contract-check.sh rather than
# shared, for the same reason that file gives: this script must not
# depend on state defined anywhere else.
api_failure_reason() {
  local stderr_text="$1" exit_status="$2"
  local joined
  joined=$(printf '%s\n' "$stderr_text" | tr -d '\r' |
    awk 'NF { gsub(/^[[:space:]]+|[[:space:]]+$/, ""); out = (out == "" ? $0 : out "; " $0) } END { print out }')
  if [ -z "$joined" ]; then
    printf 'gh exited %s without printing a reason\n' "$exit_status"
    return
  fi
  printf '%s\n' "$joined"
}

# gh_api_call runs one `gh api` call with its stderr captured instead of
# left to reach the log raw, puts the response (or empty) in GH_API_OUT
# and a human-readable failure reason in GH_API_ERROR, and returns gh's
# own exit status.
GH_API_OUT=""
GH_API_ERROR=""
gh_api_call() {
  local stderr_file rc=0
  GH_API_OUT=""
  GH_API_ERROR=""
  stderr_file=$(mktemp) || {
    GH_API_ERROR="a temporary file to capture gh's stderr could not be created"
    return 1
  }
  GH_API_OUT=$(gh api "$@" 2>"$stderr_file") || rc=$?
  if [ "$rc" -ne 0 ]; then
    GH_API_ERROR=$(api_failure_reason "$(cat "$stderr_file")" "$rc")
  fi
  rm -f "$stderr_file"
  return "$rc"
}

# decode_contents_response turns one GitHub Contents API `--include`
# response (status line, headers, blank line, base64 body) into the
# file's decoded content, or fails closed with one reason line printed to
# stdout and a non-zero return. Ported from inspector's own
# fabrica-contract-check.sh (same shape, read in the other direction).
decode_contents_response() {
  local raw="$1" gh_error="${2:-}"
  local proto http_status rest body encoded content

  if [ -z "$raw" ]; then
    if [ -n "$gh_error" ]; then
      echo "the request produced no HTTP response at all: $gh_error"
    else
      echo "the request produced no HTTP response at all (a network failure, or gh could not reach GitHub)"
    fi
    return 1
  fi
  read -r proto http_status rest <<< "$raw" || true
  http_status="${http_status%$'\r'}"
  case "$proto" in
  HTTP/*) ;;
  *)
    echo "the reply did not come back as an HTTP response (its first line was \"$proto\")"
    return 1
    ;;
  esac
  if [ "$http_status" != "200" ]; then
    echo "the GitHub Contents API returned HTTP $http_status"
    return 1
  fi

  body=$(awk 'in_body { print } /^\r?$/ { in_body = 1 }' <<< "$raw")

  if ! encoded=$(jq -r '.content // ""' <<< "$body" 2>/dev/null); then
    echo "its response body was not readable JSON, so the file's content could not be found in it"
    return 1
  fi
  encoded=$(tr -d '\n' <<< "$encoded")
  if [ -z "$encoded" ]; then
    echo "it came back with empty content (the Contents API only inlines files up to 1MB, so a larger one reads as empty here)"
    return 1
  fi
  if ! content=$(base64 -d <<< "$encoded" 2>/dev/null); then
    echo "its content was not valid base64, so the file could not be decoded"
    return 1
  fi
  printf '%s' "$content"
}

# response_status reads just the HTTP status line from a `--include`
# response, or fails if the response isn't HTTP at all (no response, a
# gh crash, a network failure) - the same "can't even tell what
# happened" case decode_contents_response fails closed on. Used where a
# 404 is a meaningful, safe-to-act-on answer ("this doesn't exist yet")
# that must not be confused with a genuine failure to reach GitHub.
response_status() {
  local raw="$1" proto http_status rest
  if [ -z "$raw" ]; then
    return 1
  fi
  read -r proto http_status rest <<< "$raw" || true
  case "$proto" in
  HTTP/*)
    printf '%s' "${http_status%$'\r'}"
    return 0
    ;;
  *)
    return 1
    ;;
  esac
}

# main reads Fabrica's own consumer contract from this checkout, compares
# it against Inspector's current copy, and - if they differ - opens or
# updates the one pull request that replaces Inspector's copy wholesale.
main() {
  : "${GH_TOKEN:?}"
  : "${FABRICA_SHA:?}"
  cd "$(dirname "${BASH_SOURCE[0]}")/../.."

  if [ ! -f "$FABRICA_CONTRACT_PATH" ]; then
    echo "::error::$FABRICA_CONTRACT_PATH does not exist in this checkout, so there is nothing to sync to Inspector."
    exit 1
  fi
  local_content=$(cat "$FABRICA_CONTRACT_PATH")

  if ! gh_api_call "repos/$INSPECTOR_REPO" --jq '.default_branch'; then
    echo "::error::Could not read Inspector's default branch from the GitHub API: $GH_API_ERROR. Failing closed rather than guessing; re-run this job."
    exit 1
  fi
  default_branch="$GH_API_OUT"
  if [ -z "$default_branch" ]; then
    echo "::error::Inspector's default branch came back empty from the GitHub API. Failing closed rather than guessing; re-run this job."
    exit 1
  fi

  gh_api_call -X GET --include "repos/$INSPECTOR_REPO/contents/$INSPECTOR_CONTRACT_PATH" -f ref="$default_branch" || true
  local inspector_content
  if ! inspector_content=$(decode_contents_response "$GH_API_OUT" "$GH_API_ERROR"); then
    echo "::error::Could not read Inspector's copy (repos/$INSPECTOR_REPO/contents/$INSPECTOR_CONTRACT_PATH @ $default_branch) from the GitHub API: $inspector_content. Failing closed rather than passing unchecked; re-run this job."
    exit 1
  fi

  if [ "$local_content" = "$inspector_content" ]; then
    echo "$INSPECTOR_CONTRACT_PATH on $INSPECTOR_REPO@$default_branch already matches $FABRICA_CONTRACT_PATH@$FABRICA_SHA. Nothing to do."
    return 0
  fi

  local diff_text
  diff_text=$(diff -u <(printf '%s\n' "$inspector_content") <(printf '%s\n' "$local_content") || true)

  if ! gh_api_call "repos/$INSPECTOR_REPO/git/ref/heads/$default_branch" --jq '.object.sha'; then
    echo "::error::Could not read the tip of Inspector's default branch ($default_branch) from the GitHub API: $GH_API_ERROR. Failing closed rather than guessing; re-run this job."
    exit 1
  fi
  local tip_sha="$GH_API_OUT"

  gh_api_call --include "repos/$INSPECTOR_REPO/git/ref/heads/$SYNC_BRANCH" || true
  local sync_branch_status
  if ! sync_branch_status=$(response_status "$GH_API_OUT"); then
    echo "::error::Could not check whether the sync branch ($SYNC_BRANCH) exists on $INSPECTOR_REPO: $GH_API_ERROR. Failing closed rather than guessing; re-run this job."
    exit 1
  fi

  if [ "$sync_branch_status" = "200" ]; then
    # Reset to the default branch's current tip every run, so the sync
    # branch never drifts and carries nothing but this one file change.
    if ! gh_api_call -X PATCH "repos/$INSPECTOR_REPO/git/refs/heads/$SYNC_BRANCH" -f sha="$tip_sha" -F force=true; then
      echo "::error::Could not reset the sync branch ($SYNC_BRANCH) on Inspector to its default branch tip: $GH_API_ERROR. Failing closed rather than writing onto a stale branch; re-run this job."
      exit 1
    fi
  elif [ "$sync_branch_status" = "404" ]; then
    if ! gh_api_call -X POST "repos/$INSPECTOR_REPO/git/refs" -f ref="refs/heads/$SYNC_BRANCH" -f sha="$tip_sha"; then
      echo "::error::Could not create the sync branch ($SYNC_BRANCH) on Inspector from its default branch tip: $GH_API_ERROR. Failing closed; re-run this job."
      exit 1
    fi
  else
    echo "::error::Checking whether the sync branch ($SYNC_BRANCH) exists on $INSPECTOR_REPO returned HTTP $sync_branch_status, neither 200 nor 404. Failing closed rather than guessing; re-run this job."
    exit 1
  fi

  # The branch now equals the default branch's tip exactly, so the
  # file's blob sha there (if it exists at all) is read fresh rather than
  # reused from the earlier default-branch read, in case a commit landed
  # on the default branch in between. A 404 here is a safe, meaningful
  # answer ("no file yet, so create rather than update") - the one place
  # in this script where that's true, unlike every contents read above.
  gh_api_call -X GET --include "repos/$INSPECTOR_REPO/contents/$INSPECTOR_CONTRACT_PATH" -f ref="$SYNC_BRANCH" || true
  local current_sha_status
  if ! current_sha_status=$(response_status "$GH_API_OUT"); then
    echo "::error::Could not read $INSPECTOR_CONTRACT_PATH's current state on $INSPECTOR_REPO@$SYNC_BRANCH: $GH_API_ERROR. Failing closed rather than guessing; re-run this job."
    exit 1
  fi
  local current_sha=""
  if [ "$current_sha_status" = "200" ]; then
    local current_sha_body
    current_sha_body=$(awk 'in_body { print } /^\r?$/ { in_body = 1 }' <<< "$GH_API_OUT")
    current_sha=$(jq -r '.sha // empty' <<< "$current_sha_body" 2>/dev/null) || current_sha=""
  elif [ "$current_sha_status" != "404" ]; then
    echo "::error::Reading $INSPECTOR_CONTRACT_PATH's current state on $INSPECTOR_REPO@$SYNC_BRANCH returned HTTP $current_sha_status, neither 200 nor 404. Failing closed rather than guessing; re-run this job."
    exit 1
  fi

  local encoded_content
  encoded_content=$(printf '%s' "$local_content" | base64 | tr -d '\n')
  local commit_message="Sync fabrica-consumer-contract.json from inactdev/fabrica@$FABRICA_SHA"
  local put_args=(-X PUT "repos/$INSPECTOR_REPO/contents/$INSPECTOR_CONTRACT_PATH" -f message="$commit_message" -f content="$encoded_content" -f branch="$SYNC_BRANCH")
  if [ -n "$current_sha" ]; then
    put_args+=(-f sha="$current_sha")
  fi
  if ! gh_api_call "${put_args[@]}"; then
    echo "::error::Could not write $INSPECTOR_CONTRACT_PATH on $INSPECTOR_REPO@$SYNC_BRANCH: $GH_API_ERROR. Failing closed; re-run this job."
    exit 1
  fi

  if ! gh_api_call -X GET "repos/$INSPECTOR_REPO/pulls" -f head="inactdev:$SYNC_BRANCH" -f state="open" --jq '.[0].number // empty'; then
    echo "::error::Could not list Inspector's open pull requests for branch $SYNC_BRANCH: $GH_API_ERROR. Failing closed; re-run this job - the file was already written to that branch, so re-running is safe."
    exit 1
  fi
  local existing_pr="$GH_API_OUT"

  local pr_title="Sync fabrica-consumer-contract.json from fabrica@${FABRICA_SHA:0:12}"
  local pr_body
  pr_body=$(printf '%s\n\n%s\n\n```diff\n%s\n```\n' \
    "This pull request was opened automatically because \`$FABRICA_CONTRACT_PATH\` changed on inactdev/fabrica's default branch at commit $FABRICA_SHA (https://github.com/inactdev/fabrica/commit/$FABRICA_SHA)." \
    "$INSPECTOR_CONTRACT_PATH is replaced wholesale with Fabrica's file. A later push to Fabrica's default branch that changes the contract again updates this same pull request instead of opening a new one." \
    "$diff_text")

  if [ -n "$existing_pr" ]; then
    if ! gh_api_call -X PATCH "repos/$INSPECTOR_REPO/pulls/$existing_pr" -f title="$pr_title" -f body="$pr_body"; then
      echo "::error::Could not update pull request #$existing_pr on $INSPECTOR_REPO: $GH_API_ERROR. Failing closed - the file was already written to $SYNC_BRANCH, so re-running this job is safe."
      exit 1
    fi
    echo "Updated pull request #$existing_pr on $INSPECTOR_REPO with the latest consumer contract."
  else
    if ! gh_api_call -X POST "repos/$INSPECTOR_REPO/pulls" -f title="$pr_title" -f head="$SYNC_BRANCH" -f base="$default_branch" -f body="$pr_body"; then
      echo "::error::Could not open a pull request on $INSPECTOR_REPO: $GH_API_ERROR. Failing closed - the file was already written to $SYNC_BRANCH, so re-running this job is safe."
      exit 1
    fi
    local pr_url
    pr_url=$(printf '%s' "$GH_API_OUT" | jq -r '.html_url // empty')
    echo "Opened pull request on $INSPECTOR_REPO: $pr_url"
  fi
}

# Run main() when this file is executed directly (the CI workflow step),
# never when sourced - there is no second caller yet, unlike inspector's
# own fabrica-contract-check.sh, since nothing here is tested by sourcing
# it. See this file's header.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
