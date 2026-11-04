// Which credential variables a project's own `Gemfile.lock` says its
// image build needs (issue #342).
//
// A work project installs gems from a paid source - sidekiq-pro and
// sidekiq-ent from `https://enterprise.contribsys.com/` - whose
// credential is deliberately not in the repository. `bundle install`
// runs at **image build time** (the check box has no network), so that
// build is where the credential has to be, and nowhere else.
//
// Bundler already has a name for it, so nothing here is invented: any
// `bundle config` key can be given as an environment variable instead,
// which is `BUNDLE_` plus the key uppercased, with the two characters a
// hostname has and a variable name cannot - a dot and a dash - written
// as a double and a triple underscore. So the source above is configured
// by `BUNDLE_ENTERPRISE__CONTRIBSYS__COM`, and that is the name this
// derives (the issue states the rule; Sidekiq's own "Commercial
// Installation" wiki and Heroku's "Bundler Configuration" document the
// same substitutions).
//
// Only the *name* is derived here. Nothing in this file reads a value,
// and nothing in it reads `brain.env` - see `resolve.ts` for the one
// place that does.

/**
 * The public gem source every Ruby project has and no project needs a
 * credential for. Compared by **host**, not by the URL as written: a
 * lockfile may spell it `https://rubygems.org/`, without the trailing
 * slash, or (on an old lockfile) over plain http, and all three are the
 * same source that needs nothing.
 */
export const PUBLIC_GEM_HOST = "rubygems.org";

/** `Gemfile.lock`'s own section headings, which sit at column 0. Only a
 * `GEM` section's `remote:` is a gem source: a `GIT` block carries the
 * repository it cloned from and a `PATH` block a directory, and reading
 * either as a gem source would derive a credential variable for
 * `github.com`. */
const GEM_SECTION = "GEM";

/**
 * Every gem source `Gemfile.lock` resolved gems from, in the order the
 * file names them and with duplicates dropped - as the file spells them.
 *
 * Section-aware, because `remote:` appears under three different
 * headings and only one of them is a gem server. Both lockfile shapes
 * are covered by the same loop: bundler writes one `GEM` block per
 * source when the Gemfile scopes them (`source "..." do ... end`), and
 * one `GEM` block carrying several `remote:` lines when the Gemfile
 * declares several global sources.
 */
export function gemRemotesIn(lockfile: string): string[] {
  const remotes: string[] = [];
  let section: string | null = null;
  for (const line of lockfile.split("\n")) {
    // A heading is the only thing in this file at column 0 that is not
    // blank: "GEM", "GIT", "PATH", "DEPENDENCIES", "RUBY VERSION", ...
    if (/^\S/.test(line)) {
      section = line.trim();
      continue;
    }
    if (section !== GEM_SECTION) continue;
    const remote = /^\s{2}remote:\s*(\S+)\s*$/.exec(line);
    if (remote !== null && !remotes.includes(remote[1])) remotes.push(remote[1]);
  }
  return remotes;
}

/** A remote's host, or `null` when the value is not a URL this can read
 * one out of. A `mirror`ed or otherwise unusual entry is not guessed at:
 * `buildSecretsFor` names it in its notes instead. */
export function hostOfRemote(remote: string): string | null {
  try {
    const url = new URL(remote);
    // `host`, not `hostname`: a non-default port is part of what bundler
    // keys its own configuration on, and dropping it here would derive
    // the name of a variable that configures a different source. A port
    // then makes the name illegal below, which is reported rather than
    // silently repaired.
    return url.host.length > 0 ? url.host : null;
  } catch {
    return null;
  }
}

/**
 * Bundler's own environment-variable name for a gem source host, or
 * `null` when the host cannot become a legal variable name at all.
 *
 * The dash is replaced before the dot, and both before the uppercasing,
 * so the two substitutions cannot run into one another.
 */
export function bundlerVariableFor(host: string): string | null {
  const name = `BUNDLE_${host.replace(/-/g, "___").replace(/\./g, "__").toUpperCase()}`;
  // Letters, digits and underscores only, which is both what a shell
  // variable may hold and what Inspector accepts in `buildSecrets`
  // (inspector#86: "anything else is refused by name"). A host with a
  // port, a userinfo or an escape in it lands here.
  return /^[A-Z0-9_]+$/.test(name) ? name : null;
}

/** What one lockfile says: the variables to list, and anything it names
 * that could not be turned into one. */
export interface DerivedBuildSecrets {
  /** The variable names, in the order the lockfile names their sources.
   * Empty for a project whose only gem source is the public one, which
   * is almost every project. */
  names: string[];
  /** One sentence per remote that needs a credential variable this could
   * not name - printed by `fabrica register` rather than dropped, since
   * a silently missing name is a build that fails at `bundle install`
   * with no explanation of what is missing. */
  notes: string[];
}

/**
 * The credential variables a `Gemfile.lock` says its `bundle install`
 * needs - every gem source other than the public one.
 *
 * A project with no lockfile, or one that only uses rubygems.org, yields
 * no names at all, and then nothing downstream changes: no `buildSecrets`
 * key is written, no secret is mounted, and no variable is looked for in
 * `brain.env`.
 */
export function buildSecretsFor(lockfile: string | null | undefined): DerivedBuildSecrets {
  if (lockfile === null || lockfile === undefined) return { names: [], notes: [] };

  const names: string[] = [];
  const notes: string[] = [];
  for (const remote of gemRemotesIn(lockfile)) {
    const host = hostOfRemote(remote);
    if (host === null) {
      notes.push(
        `${remote} is a gem source this cannot read a host out of, so the credential variable bundler would ` +
          `read for it cannot be named here. If that source needs one, add its name to buildSecrets yourself.`
      );
      continue;
    }
    if (host.toLowerCase() === PUBLIC_GEM_HOST) continue;
    const variable = bundlerVariableFor(host);
    if (variable === null) {
      notes.push(
        `${remote} needs a credential, and "${host}" cannot become an environment variable name (letters, ` +
          `digits and underscores only - a port or an escape in the host does it). Configure that source the ` +
          `way bundler documents and add the variable's name to buildSecrets yourself.`
      );
      continue;
    }
    if (!names.includes(variable)) names.push(variable);
  }
  return { names, notes };
}
