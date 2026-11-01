// A Rails-shaped repository, for the tests of issue #324's Ruby shape.
//
// Test-only, and deliberately small: every file here exists because one
// of `register`'s own rules reads it, so a reader can see at a glance
// which signal each test is actually exercising. The `Gemfile.lock` is
// bundler's own format, down to the indentation the parser depends on -
// four spaces for a resolved gem under `specs:`, six for that gem's own
// requirements, two for `DEPENDENCIES` - since `gemsIn` reads exactly
// that and a fixture that got it wrong would prove nothing.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * `Gemfile.lock`'s own contents.
 *
 * `pg` and `redis` are resolved gems, so the shape installs a server for
 * each. `rspec-rails` (with the `rspec-core` it pulls in) is what makes
 * the suite `bundle exec rspec`. `capybara` is there so the
 * out-of-scope note about browser tests has something to see, and
 * `nokogiri` is listed as a *requirement* of another gem at six spaces
 * while never being a resolved gem itself - a parser reading those
 * deeper lines would wrongly call it installed.
 */
export const RAILS_GEMFILE_LOCK = `GEM
  remote: https://rubygems.org/
  specs:
    actionpack (7.1.3.2)
      rack (>= 2.2.4)
    activerecord (7.1.3.2)
      activemodel (= 7.1.3.2)
    capybara (3.40.0)
      nokogiri (~> 1.11)
    pg (1.5.6)
    rack (3.0.11)
    rails (7.1.3.2)
      actionpack (= 7.1.3.2)
      activerecord (= 7.1.3.2)
    redis (5.2.0)
      redis-client (>= 0.22.0)
    redis-client (0.22.2)
    rspec-core (3.13.0)
    rspec-rails (6.1.2)
      rspec-core (~> 3.13)

PLATFORMS
  ruby

DEPENDENCIES
  capybara
  pg (~> 1.5)
  rails (~> 7.1.3)
  redis (~> 5.0)
  rspec-rails

RUBY VERSION
   ruby 3.3.4p94

BUNDLED WITH
   2.5.9
`;

/** `Gemfile`, with the `ruby` line a `.ruby-version`-less repository is
 * read for. */
export const RAILS_GEMFILE = `source "https://rubygems.org"

ruby "3.3.4"

gem "rails", "~> 7.1.3"
gem "pg", "~> 1.5"
gem "redis", "~> 5.0"

group :test do
  gem "rspec-rails"
  gem "capybara"
end
`;

/** The exact Ruby version `.ruby-version` pins - the first file the
 * `FROM` line is derived from. */
export const RAILS_RUBY_VERSION = "3.3.4\n";

/** Every file the fixture repository carries, by repository-relative
 * path. `bin/rails` is a real Rails application's own launcher, and its
 * presence is the whole signal behind `bin/rails db:test:prepare`. */
export function railsFixtureFiles(): Record<string, string> {
  return {
    Gemfile: RAILS_GEMFILE,
    "Gemfile.lock": RAILS_GEMFILE_LOCK,
    ".ruby-version": RAILS_RUBY_VERSION,
    "bin/rails": `#!/usr/bin/env ruby\nAPP_PATH = File.expand_path("../config/application", __dir__)\n`,
    "config/database.yml": `test:\n  adapter: postgresql\n  database: fixture_test\n`,
  };
}

/** Writes those files into a directory, creating the directories a
 * nested one needs. Committing them is the caller's business: a test
 * reading signals off a ref has to decide which commit they are on. */
export function writeRailsFixture(dir: string, files = railsFixtureFiles()): void {
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
}
