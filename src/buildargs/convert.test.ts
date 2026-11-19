import { test } from "node:test";
import assert from "node:assert/strict";
import { configWithBuildArgs, planVersionPinConversion, replacementLinesFor } from "./convert.ts";

function repo(files: Record<string, string>) {
  return (path: string) => files[path] ?? null;
}

/** Issue #355's own fixture, in its own numbers: the terms say 3.4.8,
 * the repository says 3.4.13. */
const RUBY_REPO = repo({ ".ruby-version": "3.4.13\n" });

const HARD_CODED = [
  "# The image inspector runs ./check.sh in.",
  "FROM ruby:3.4.8",
  "USER root",
  "COPY Gemfile Gemfile.lock /deps/",
  "RUN cd /deps && bundle install",
  "",
].join("\n");

test("a hard-coded FROM becomes an ARG with that version as its default", () => {
  const plan = planVersionPinConversion(HARD_CODED, RUBY_REPO);

  assert.equal(plan.conversions.length, 1);
  const [conversion] = plan.conversions;
  assert.equal(conversion.arg, "RUBY_VERSION");
  assert.equal(conversion.pinned, "3.4.8");
  assert.equal(conversion.declared, "3.4.13");
  assert.equal(conversion.file, ".ruby-version");
  // The default is the version that WAS there, never the declared one:
  // a build that passes no value has to produce exactly what it
  // produced before the conversion.
  assert.equal(conversion.argLine, "ARG RUBY_VERSION=3.4.8");
  assert.deepEqual(conversion.froms, [{ before: "FROM ruby:3.4.8", after: "FROM ruby:${RUBY_VERSION}" }]);

  const lines = plan.text.split("\n");
  assert.ok(lines.includes("ARG RUBY_VERSION=3.4.8"));
  assert.ok(lines.includes("FROM ruby:${RUBY_VERSION}"));
  assert.equal(lines.includes("FROM ruby:3.4.8"), false);
  // Above the first FROM, which is the only place a FROM may read one.
  assert.ok(lines.indexOf("ARG RUBY_VERSION=3.4.8") < lines.indexOf("FROM ruby:${RUBY_VERSION}"));
  // Everything else is left exactly as it was.
  assert.ok(plan.text.includes("RUN cd /deps && bundle install"));
  assert.deepEqual(plan.skipped, []);
});

test("the config entry is written against the same file the version came from", () => {
  const [conversion] = planVersionPinConversion(HARD_CODED, RUBY_REPO).conversions;
  assert.deepEqual(conversion.entry, {
    RUBY_VERSION: { file: ".ruby-version", pattern: "^(?:ruby-)?([0-9][^\\s]*)$" },
  });
});

test("flags, aliases and a tag suffix all survive the rewrite", () => {
  const plan = planVersionPinConversion(
    ["FROM --platform=linux/amd64 ruby:3.4.8-slim AS app", "RUN true", ""].join("\n"),
    RUBY_REPO
  );
  assert.deepEqual(plan.conversions[0].froms, [
    {
      before: "FROM --platform=linux/amd64 ruby:3.4.8-slim AS app",
      after: "FROM --platform=linux/amd64 ruby:${RUBY_VERSION}-slim AS app",
    },
  ]);
});

test("two stages on the same version share one argument", () => {
  const plan = planVersionPinConversion(
    ["FROM ruby:3.4.8 AS deps", "RUN true", "FROM ruby:3.4.8", "COPY --from=deps /deps /deps", ""].join("\n"),
    RUBY_REPO
  );
  assert.equal(plan.conversions.length, 1);
  assert.equal(plan.conversions[0].froms.length, 2);
  assert.equal(plan.text.split("ARG RUBY_VERSION=3.4.8").length - 1, 1);
  assert.equal(plan.text.includes("FROM ruby:3.4.8"), false);
});

// One argument cannot carry two versions, and picking one of them would
// quietly move the other stage's image - so this is said out loud and
// left alone.
test("two stages on different versions of one language are skipped, loudly", () => {
  const plan = planVersionPinConversion(["FROM ruby:3.4.8 AS old", "FROM ruby:3.3.4", ""].join("\n"), RUBY_REPO);
  assert.deepEqual(plan.conversions, []);
  assert.equal(plan.text, ["FROM ruby:3.4.8 AS old", "FROM ruby:3.3.4", ""].join("\n"));
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /2 different ruby versions \(3\.4\.8, 3\.3\.4\)/);
});

test("two languages in one file each get their own argument", () => {
  const plan = planVersionPinConversion(
    ["FROM node:24.18.0 AS assets", "FROM ruby:3.4.8", ""].join("\n"),
    repo({ ".ruby-version": "3.4.13\n", ".node-version": "24.19.0\n" })
  );
  assert.deepEqual(
    plan.conversions.map((one) => one.arg),
    ["NODE_VERSION", "RUBY_VERSION"]
  );
  assert.ok(plan.text.includes("ARG NODE_VERSION=24.18.0"));
  assert.ok(plan.text.includes("ARG RUBY_VERSION=3.4.8"));
  assert.ok(plan.text.includes("FROM node:${NODE_VERSION} AS assets"));
  assert.ok(plan.text.includes("FROM ruby:${RUBY_VERSION}"));
});

test("nothing to convert leaves the file byte-for-byte alone", () => {
  for (const [text, files] of [
    // Already converted.
    ["ARG RUBY_VERSION=3.4.8\nFROM ruby:${RUBY_VERSION}\n", { ".ruby-version": "3.4.13\n" }],
    // An image whose tag is not a language version.
    ["FROM postgres:17\n", { ".ruby-version": "3.4.13\n" }],
    // A version in no file of the repository's.
    ["FROM ruby:3.4.8\n", {}],
    // A digest pin, where the version is not in the tag at all.
    [`FROM ruby@sha256:${"a".repeat(64)}\n`, { ".ruby-version": "3.4.13\n" }],
    // No FROM at all.
    ["# nothing here\n", { ".ruby-version": "3.4.13\n" }],
  ] as [string, Record<string, string>][]) {
    const plan = planVersionPinConversion(text, repo(files));
    assert.deepEqual(plan.conversions, [], text);
    assert.equal(plan.text, text, text);
  }
});

test("the replacement line names the ARG, both FROM forms and the config entry", () => {
  const line = replacementLinesFor(planVersionPinConversion(HARD_CODED, RUBY_REPO).conversions);
  assert.match(line, /add "ARG RUBY_VERSION=3\.4\.8" above the first FROM/);
  assert.match(line, /"FROM ruby:3\.4\.8" -> "FROM ruby:\$\{RUBY_VERSION\}"/);
  assert.match(line, /\.inspector\.json's buildArgs/);
  assert.match(line, /"\.ruby-version"/);
});

test("the config keeps every key it had and gains the entry", () => {
  const before = `${JSON.stringify({ check: "sh /terms/check.sh", protectedPaths: ["check.sh"] }, null, 2)}\n`;
  const after = configWithBuildArgs(before, planVersionPinConversion(HARD_CODED, RUBY_REPO).conversions);
  assert.ok(after);
  assert.deepEqual(JSON.parse(after), {
    check: "sh /terms/check.sh",
    protectedPaths: ["check.sh"],
    buildArgs: { RUBY_VERSION: { file: ".ruby-version", pattern: "^(?:ruby-)?([0-9][^\\s]*)$" } },
  });
  // Pretty-printed with a trailing newline, the way `fabrica register`
  // writes this file - it is one a human reads and edits.
  assert.ok(after.endsWith("}\n"));
  assert.ok(after.includes(`\n  "check"`));
});

test("an entry already there for the same name is replaced, not duplicated", () => {
  const before = JSON.stringify({ buildArgs: { RUBY_VERSION: { file: "old-file" }, MINE: { file: "keep-me" } } });
  const after = configWithBuildArgs(before, planVersionPinConversion(HARD_CODED, RUBY_REPO).conversions);
  assert.ok(after);
  assert.deepEqual(JSON.parse(after).buildArgs, {
    RUBY_VERSION: { file: ".ruby-version", pattern: "^(?:ruby-)?([0-9][^\\s]*)$" },
    MINE: { file: "keep-me" },
  });
});

test("a config that is not a JSON object is never rewritten", () => {
  const conversions = planVersionPinConversion(HARD_CODED, RUBY_REPO).conversions;
  assert.equal(configWithBuildArgs("{ not json", conversions), null);
  assert.equal(configWithBuildArgs("[]", conversions), null);
});
