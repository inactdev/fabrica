import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import {
  branchExistsLocally,
  branchExistsOnOrigin,
  fileExistsOnRef,
  hostFromOriginUrl,
  inspectorConfiguredOnOrigin,
  notSetUpMessage,
  originUrl,
  repoNameFromOriginUrl,
} from "./origin.ts";

test("repoNameFromOriginUrl: every spelling git accepts for one remote gives one name", () => {
  const cases: [string, string][] = [
    ["git@github.com:inactdev/fabrica.git", "fabrica"],
    ["git@github.com:inactdev/fabrica", "fabrica"],
    ["https://github.com/inactdev/fabrica.git", "fabrica"],
    ["https://github.com/inactdev/fabrica", "fabrica"],
    ["https://github.com/inactdev/fabrica/", "fabrica"],
    ["ssh://git@github.com/inactdev/fabrica.git", "fabrica"],
    ["/srv/git/spending-app.git", "spending-app"],
    ["/srv/git/spending-app", "spending-app"],
  ];
  for (const [url, name] of cases) {
    assert.equal(repoNameFromOriginUrl(url), name, url);
  }
});

// gh auth status exits 1 if ANY stored host has a problem, so register
// always scopes it to origin's own host - which means parsing that host
// right matters, including for the scp-style form that isn't a URL.
test("hostFromOriginUrl: the scp-style form, real URLs, and a local path with no host", () => {
  assert.equal(hostFromOriginUrl("git@github.com:inactdev/fabrica.git"), "github.com");
  assert.equal(hostFromOriginUrl("git@git.example.co.uk:team/repo.git"), "git.example.co.uk");
  assert.equal(hostFromOriginUrl("https://github.com/inactdev/fabrica.git"), "github.com");
  assert.equal(hostFromOriginUrl("ssh://git@git.example.com:2222/team/repo.git"), "git.example.com");
  assert.equal(hostFromOriginUrl("/srv/git/spending-app.git"), null);
  assert.equal(hostFromOriginUrl("../sibling-repo"), null);
});

test("originUrl: reads origin, and is null when there is no origin at all", () => {
  assert.notEqual(originUrl(makeFixtureRepo("exit 0")), null);
  assert.equal(originUrl(makeFixtureRepo("exit 0", { origin: false })), null);
});

test("fileExistsOnRef asks git's tree, not the working directory", () => {
  const project = makeFixtureRepo("exit 0");
  const branch = execFileSync("git", ["branch", "--show-current"], { cwd: project, encoding: "utf8" }).trim();

  assert.equal(fileExistsOnRef(project, `origin/${branch}`, ".inspector.json"), true);
  assert.equal(fileExistsOnRef(project, `origin/${branch}`, "nothing-here.txt"), false);

  // Deleting it from the working tree changes nothing about the commit.
  rmSync(join(project, ".inspector.json"));
  assert.equal(fileExistsOnRef(project, `origin/${branch}`, ".inspector.json"), true);
});

test("branchExistsOnOrigin / branchExistsLocally tell origin's branches from the local ones", () => {
  const project = makeFixtureRepo("exit 0");

  assert.equal(branchExistsOnOrigin(project, "fabrica/register"), false);
  assert.equal(branchExistsLocally(project, "fabrica/register"), false);

  execFileSync("git", ["branch", "fabrica/register"], { cwd: project });
  assert.equal(branchExistsLocally(project, "fabrica/register"), true);
  assert.equal(branchExistsOnOrigin(project, "fabrica/register"), false, "a local branch is not an origin branch");

  execFileSync("git", ["push", "-q", "origin", "fabrica/register"], { cwd: project });
  assert.equal(branchExistsOnOrigin(project, "fabrica/register"), true);
});

test("inspectorConfiguredOnOrigin: true when origin's default branch carries the config", () => {
  assert.equal(inspectorConfiguredOnOrigin(makeFixtureRepo("exit 0")), true);
});

test("inspectorConfiguredOnOrigin: false when it does not - the case `fabrica do` refuses on", () => {
  assert.equal(inspectorConfiguredOnOrigin(makeFixtureRepo("exit 0", { inspector: false })), false);
});

// "Could not find out" must never read as "not set up": telling the
// Client to run `fabrica register` because his network is down would be
// both wrong and less use than the real git error that follows.
test("inspectorConfiguredOnOrigin: null - never false - when the question cannot be answered", () => {
  assert.equal(inspectorConfiguredOnOrigin(makeFixtureRepo("exit 0", { origin: false })), null);
});

test("notSetUpMessage names the command that fixes it, with the real path", () => {
  const message = notSetUpMessage("/srv/spending-app");
  assert.ok(message.startsWith("this project isn't set up for Fabrica yet: "));
  assert.ok(message.includes("run fabrica register /srv/spending-app --check ... --image ..."));
});
