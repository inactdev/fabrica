// sync-inspector-contract (issue #109, "Fabrica side") keeps Inspector's
// copy of the consumer contract in step with Fabrica's own
// consumer-contract.json via a CI job, not a sentence telling people to do
// it by hand. The job's own GitHub API orchestration can only be exercised
// inside a real Actions run (the same honest limitation inspector's own
// fabrica-contract-check.sh documents for itself) - what's provable here
// is that the workflow and script carry the facts the issue ratified:
// which file triggers it, which repo and path it writes to, the fixed
// branch name that keeps a second change from opening a second pull
// request, and the token it authenticates with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const workflowPath = join(repoRoot, ".github", "workflows", "sync-inspector-contract.yml");
const scriptPath = join(repoRoot, ".github", "scripts", "sync-inspector-contract.sh");

test("sync-inspector-contract.yml triggers only on a push to master that touches the consumer contract", () => {
  const source = readFileSync(workflowPath, "utf8");

  assert.match(source, /^\s*push:\s*$/m, "must trigger on push, not pull_request_target - this runs on already-merged content");
  assert.match(source, /^\s*branches:\s*\[master\]\s*$/m, "must trigger only on Fabrica's default branch");
  assert.match(
    source,
    /^\s*paths:\s*\n\s*-\s*src\/inspector\/consumer-contract\.json\s*$/m,
    "must only fire when the consumer contract itself changes"
  );

  // Authenticates with a repository secret scoped to Inspector, never
  // this repo's own default token (which has no access to a different
  // repository anyway).
  assert.match(source, /GH_TOKEN:\s*\$\{\{\s*secrets\.INSPECTOR_SYNC_TOKEN\s*\}\}/, "must authenticate with the Inspector-scoped secret");
  assert.doesNotMatch(source, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/, "must not use this repo's own default token for a cross-repo write");

  assert.match(source, /FABRICA_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/, "must name the Fabrica commit the sync ran from");
  assert.match(source, /run:\s*\.github\/scripts\/sync-inspector-contract\.sh/, "must run the sync script");

  // #187 (the GitHub App) is where this secret gets replaced - named here
  // so the sharp edge travels with the file, not just the project's root
  // agent-memory file.
  assert.match(source, /#187/, "must name the issue that replaces this secret with the GitHub App's key");
});

test("sync-inspector-contract.sh targets Inspector's exact file path and a fixed sync branch", () => {
  const source = readFileSync(scriptPath, "utf8");

  assert.match(
    source,
    /INSPECTOR_REPO="inactdev\/inspector"/,
    "must target the real inspector repository"
  );
  assert.match(
    source,
    /INSPECTOR_CONTRACT_PATH="cmd\/inspector\/testdata\/fabrica-consumer-contract\.json"/,
    "must write to Inspector's own documented path for its copy"
  );
  assert.match(
    source,
    /FABRICA_CONTRACT_PATH="src\/inspector\/consumer-contract\.json"/,
    "must read Fabrica's own committed file"
  );

  // A fixed branch name, not a per-run one - so a second change updates
  // the same open pull request instead of opening another.
  const branchMatch = source.match(/SYNC_BRANCH="([^"]+)"/);
  assert.ok(branchMatch, "must declare a fixed sync branch name");
  assert.doesNotMatch(branchMatch![1], /\$|\{\{/, "the branch name must be a literal constant, not computed per run");
  const branchUses = [...source.matchAll(/\$SYNC_BRANCH\b/g)].length;
  assert.ok(branchUses >= 3, "the fixed branch variable must be reused for the branch check, reset/create, and file write - not recomputed per run");

  assert.match(source, /git\/refs\/heads\/\$SYNC_BRANCH.*-F force=true/, "must force-reset an existing sync branch to the default branch tip, never drift");
  assert.match(source, /repos\/\$INSPECTOR_REPO\/pulls/, "must look for and act on Inspector's pull requests");
});

test("sync-inspector-contract.sh fails closed, naming the cause, on every GitHub call it makes", () => {
  const source = readFileSync(scriptPath, "utf8");
  const errorAnnotations = [...source.matchAll(/::error::[^\n"]*\$GH_API_ERROR/g)];
  assert.ok(
    errorAnnotations.length >= 5,
    `expected several distinct failure points to name $GH_API_ERROR, found ${errorAnnotations.length}`
  );
  assert.match(source, /set -euo pipefail/, "must fail closed on any unexpected error, not just the ones it checks explicitly");
});
