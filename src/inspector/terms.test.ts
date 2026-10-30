import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { termsProblem, termsSetup, TERMS_REQUIRED_FILES } from "./terms.ts";

function dir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `fabrica-terms-${prefix}-`));
}

/** A terms folder Inspector would accept: both files it reads by name,
 * and a config carrying none of the retired keys. */
function goodTerms(config: string = "{}\n"): string {
  const terms = dir("good");
  writeFileSync(join(terms, ".inspector.json"), config);
  writeFileSync(join(terms, "Dockerfile.inspector"), "FROM node:24\n");
  return terms;
}

test("termsProblem: a folder holding both files, with a clean config, is accepted", () => {
  assert.equal(termsProblem(goodTerms(), dir("repo")), null);
});

test("termsProblem: the two files it reads by name are the config and the Dockerfile", () => {
  assert.deepEqual([...TERMS_REQUIRED_FILES], [".inspector.json", "Dockerfile.inspector"]);
});

test("termsProblem: a folder that is not there is refused, naming the path", () => {
  const missing = join(dir("parent"), "nope");
  const problem = termsProblem(missing, dir("repo"));

  assert.equal(problem?.refusal, "terms-missing");
  assert.match(problem!.detail, new RegExp(missing.replace(/[/\\]/g, "\\$&")));
});

test("termsProblem: a file where a folder should be is refused", () => {
  const file = join(dir("parent"), "terms");
  writeFileSync(file, "not a folder\n");

  assert.equal(termsProblem(file, dir("repo"))?.refusal, "terms-not-a-directory");
});

test("termsProblem: a path with a colon in it is refused - Docker's mount syntax splits on it", () => {
  const terms = join(dir("parent"), "widgets:terms");
  mkdirSync(terms);
  for (const file of TERMS_REQUIRED_FILES) writeFileSync(join(terms, file), "{}\n");

  const problem = termsProblem(terms, dir("repo"));
  assert.equal(problem?.refusal, "terms-unmountable");
  assert.match(problem!.detail, /colon/);
});

test("termsProblem: a folder inside the repository is refused - those are in-repo terms", () => {
  const repo = dir("repo");
  const terms = join(repo, "fabrica");
  mkdirSync(terms);
  for (const file of TERMS_REQUIRED_FILES) writeFileSync(join(terms, file), "{}\n");

  const problem = termsProblem(terms, repo);
  assert.equal(problem?.refusal, "terms-inside-repo");
  assert.match(problem!.fix, /commit this project's terms at its repository root/);
});

test("termsProblem: the repository itself as the terms folder is refused the same way", () => {
  const repo = goodTerms();
  assert.equal(termsProblem(repo, repo)?.refusal, "terms-inside-repo");
});

test("termsProblem: a folder containing the repository is refused - the whole of it would be mounted", () => {
  const parent = dir("parent");
  const repo = join(parent, "widgets");
  mkdirSync(repo);
  for (const file of TERMS_REQUIRED_FILES) writeFileSync(join(parent, file), "{}\n");

  assert.equal(termsProblem(parent, repo)?.refusal, "terms-contains-repo");
});

test("termsProblem: a folder missing either file Inspector reads is refused, naming that file", () => {
  for (const missing of TERMS_REQUIRED_FILES) {
    const terms = dir("partial");
    for (const file of TERMS_REQUIRED_FILES) {
      if (file !== missing) writeFileSync(join(terms, file), "{}\n");
    }

    const problem = termsProblem(terms, dir("repo"));
    assert.equal(problem?.refusal, "terms-incomplete", `${missing} missing should have been refused`);
    assert.match(problem!.detail, new RegExp(missing.replace(".", "\\.")));
    assert.match(problem!.fix, new RegExp(`add ${missing.replace(".", "\\.")}`));
  }
});

test("termsProblem: a retired key in the terms folder's own config is refused, the same as an in-repo one", () => {
  const problem = termsProblem(goodTerms(`{ "image": "node:24" }\n`), dir("repo"));
  assert.equal(problem?.refusal, "retired-image-key");
});

test("termsProblem: a terms folder is never asked to be committed - it is not under git at all", () => {
  // The in-repo check refuses a Dockerfile git does not track. These
  // files are in a plain folder with no repository anywhere above them,
  // and that is exactly the configuration this setting is for.
  assert.equal(termsProblem(goodTerms(), dir("repo")), null);
});

test("termsSetup: a project naming a terms folder is set up for Fabrica by that setting", () => {
  assert.deepEqual(termsSetup(goodTerms()), { inspectorConfigured: true, declaresTestPaths: false });
});

test("termsSetup: testPaths is read out of the terms folder, which no Worker can reach", () => {
  const terms = goodTerms(`{ "testPaths": ["spec/"] }\n`);
  assert.deepEqual(termsSetup(terms), { inspectorConfigured: true, declaresTestPaths: true });
});

test("termsSetup: a folder that cannot be read still reads as set up - its own refusal says why", () => {
  assert.deepEqual(termsSetup(join(dir("parent"), "nope")), {
    inspectorConfigured: true,
    declaresTestPaths: false,
  });
});

// In Inspector's own order: a folder that is both missing and has a
// colon in its path is named by the missing path, because that is the
// first thing Inspector itself checks.
test("termsProblem: a folder with more than one problem is named by Inspector's own first one", () => {
  const missingWithColon = join(dir("parent"), "widgets:terms");
  assert.equal(termsProblem(missingWithColon, dir("repo"))?.refusal, "terms-missing");
});
