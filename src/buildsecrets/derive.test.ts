import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSecretsFor, bundlerVariableFor, gemRemotesIn, hostOfRemote, PUBLIC_GEM_HOST } from "./derive.ts";
import {
  PAID_SOURCE,
  PAID_SOURCE_VARIABLE,
  RAILS_GEMFILE_LOCK,
  RAILS_GEMFILE_LOCK_PAID_SOURCE,
} from "../register/helpers/rails-fixture.ts";

// ------------------------------------------------- bundler's own naming

test("bundler's variable for a host is the host uppercased, dots doubled, dashes tripled", () => {
  // The issue's own example, which is also Sidekiq's documented one.
  assert.equal(bundlerVariableFor("enterprise.contribsys.com"), "BUNDLE_ENTERPRISE__CONTRIBSYS__COM");
  assert.equal(bundlerVariableFor("gems.contribsys.com"), "BUNDLE_GEMS__CONTRIBSYS__COM");
  // A dash, which is three underscores and not two - a substitution
  // order that ran them together would give "MY______GEMS..." here.
  assert.equal(bundlerVariableFor("my-gems.example.com"), "BUNDLE_MY___GEMS__EXAMPLE__COM");
});

test("a host that cannot be a variable name answers null rather than a mangled one", () => {
  // A port is the realistic case: bundler keys its own configuration on
  // the host as written, and dropping the port would name the variable
  // for a different source.
  assert.equal(bundlerVariableFor("gems.example.com:8080"), null);
  assert.equal(bundlerVariableFor("user:pw@gems.example.com"), null);
});

// ---------------------------------------------- reading the lockfile

test("a lockfile's gem sources are its GEM remotes, and only those", () => {
  const remotes = gemRemotesIn(RAILS_GEMFILE_LOCK_PAID_SOURCE);
  assert.deepEqual(remotes, ["https://rubygems.org/", PAID_SOURCE]);
  // The GIT section's own remote is a repository, not a gem server. A
  // parser that read every `remote:` would derive a credential variable
  // for github.com and then fail doctor on a variable nobody needs.
  assert.ok(
    !remotes.some((remote) => remote.includes("github.com")),
    `a GIT section's remote must not be read as a gem source: ${remotes.join(", ")}`
  );
});

test("several remotes in one GEM block are all read, and duplicates are dropped", () => {
  // The other shape bundler writes: one GEM block, several global
  // sources.
  const lockfile = `GEM
  remote: https://rubygems.org/
  remote: https://gems.example.com/
  remote: https://gems.example.com/
  specs:
    widget (1.0.0)

PLATFORMS
  ruby
`;
  assert.deepEqual(gemRemotesIn(lockfile), ["https://rubygems.org/", "https://gems.example.com/"]);
});

test("a remote's host is read off the URL, port and all", () => {
  assert.equal(hostOfRemote("https://enterprise.contribsys.com/"), "enterprise.contribsys.com");
  assert.equal(hostOfRemote("https://gems.example.com:8080/"), "gems.example.com:8080");
  assert.equal(hostOfRemote("not a url"), null);
});

// ------------------------------------------------- the whole derivation

test("a lockfile with a paid gem source names bundler's variable for it, and nothing for rubygems", () => {
  const derived = buildSecretsFor(RAILS_GEMFILE_LOCK_PAID_SOURCE);
  assert.deepEqual(derived.names, [PAID_SOURCE_VARIABLE]);
  assert.deepEqual(derived.notes, []);
});

test("a lockfile installing only from the public source needs no credential at all", () => {
  assert.deepEqual(buildSecretsFor(RAILS_GEMFILE_LOCK), { names: [], notes: [] });
  // Whatever the spelling: no trailing slash, and plain http on an old
  // lockfile, are the same source that needs nothing.
  for (const spelling of [`http://${PUBLIC_GEM_HOST}`, `https://${PUBLIC_GEM_HOST}`, `https://RubyGems.org/`]) {
    const lockfile = `GEM\n  remote: ${spelling}\n  specs:\n    widget (1.0.0)\n`;
    assert.deepEqual(buildSecretsFor(lockfile).names, [], `${spelling} needs no credential`);
  }
});

test("a project with no lockfile at all derives nothing, and is not an error", () => {
  assert.deepEqual(buildSecretsFor(null), { names: [], notes: [] });
  assert.deepEqual(buildSecretsFor(undefined), { names: [], notes: [] });
  assert.deepEqual(buildSecretsFor(""), { names: [], notes: [] });
});

test("a source whose credential variable cannot be named is reported, never dropped", () => {
  const lockfile = `GEM
  remote: https://rubygems.org/
  remote: https://gems.example.com:8080/
  specs:
    widget (1.0.0)
`;
  const derived = buildSecretsFor(lockfile);
  assert.deepEqual(derived.names, []);
  assert.equal(derived.notes.length, 1);
  // The remote, the reason, and what the Client has to do - a silently
  // missing name is an install step that fails on an authentication
  // error naming none of this.
  assert.match(derived.notes[0], /gems\.example\.com:8080/);
  assert.match(derived.notes[0], /buildSecrets/);
});

test("two paid sources give two names, in the order the lockfile names them", () => {
  const lockfile = `GEM
  remote: https://gems.b.example.com/
  specs:
    b (1.0.0)

GEM
  remote: https://gems.a.example.com/
  specs:
    a (1.0.0)
`;
  assert.deepEqual(buildSecretsFor(lockfile).names, [
    "BUNDLE_GEMS__B__EXAMPLE__COM",
    "BUNDLE_GEMS__A__EXAMPLE__COM",
  ]);
});
