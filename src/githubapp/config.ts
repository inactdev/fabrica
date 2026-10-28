// Where the GitHub App's own credentials come from, and every refusal
// that reading them can produce.
//
// Two settings, read from Fabrica's own environment first and then from
// `<recordHome>/brain.env` - the same precedence, and the same 600-mode
// file, every other credential on this machine already uses
// (src/reviewer/resolve.ts's `credential`, src/brain/adapters's
// `credentialEnvFrom`). The key itself is deliberately NOT one of those
// values: a PEM is multi-line, and inlining it would mean either a
// base64 blob nobody can eyeball or a file format brain.env's
// one-line-per-setting reader cannot hold. `FABRICA_GITHUB_APP_KEY` is
// a path, and the file it names must be mode 600 - anything else is
// refused by name (Client ruling, issue #187's clarification 4).
//
// Nothing here reaches the network. Everything this file can answer is
// answerable from the disk, which is what lets `Inspector.prepare()`
// refuse a handoff that could not possibly work before any worker
// starts, synchronously, exactly as the missing personal token used to.

import { createPrivateKey } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { brainEnvPath, brainEnvValue } from "../brain/index.ts";
import { GithubAppError } from "./errors.ts";

/** The App's own identifier, used as the JWT's `iss`. GitHub's
 * documentation accepts either the App id or the client id here and
 * recommends the client id; both are strings this never interprets. */
export const APP_ID_VAR = "FABRICA_GITHUB_APP_ID";

/** The path to the App's private key - a `.pem` file at mode 600. Not
 * the key's contents: see this file's header. */
export const APP_KEY_VAR = "FABRICA_GITHUB_APP_KEY";

/** The mode the key file must have, exactly. Stricter than
 * `brain.env`'s own check (which refuses only a file other users can
 * read): a private key that the owner has left group- or
 * world-writable is as replaceable as it is readable. */
export const REQUIRED_KEY_MODE = 0o600;

/** What this machine has been told about the App, unvalidated - so
 * `fabrica doctor` can report which half is missing rather than only
 * refusing. `undefined` for a setting that is configured nowhere. */
export interface AppSettings {
  appId?: string;
  keyPath?: string;
}

/** Everything needed to sign a JWT for the App. */
export interface AppCredentials {
  appId: string;
  /** The path as resolved, for naming in a message - never the key. */
  keyPath: string;
  privateKeyPem: string;
}

/** The one-step-at-a-time setup the Client does by hand, once per
 * machine (issue #187: "Setup steps the Client does by hand
 * (registering the App) to be written as one-step-at-a-time
 * instructions"). Written here rather than only in README.md so that
 * every refusal - a task's, a handoff's, `fabrica doctor`'s - can print
 * the real steps instead of pointing at a document the Client may not
 * have open. */
export function appSetupSteps(recordHome: string): string {
  return [
    "  1. Open https://github.com/settings/apps/new and register a GitHub App.",
    "     Name it anything; leave the callback URL and webhook empty, and untick",
    '     "Active" under Webhook.',
    "  2. Under Repository permissions, grant exactly these, and nothing else:",
    "     Contents: Read and write; Pull requests: Read and write;",
    "     Commit statuses: Read and write; Issues: Read-only; Checks: Read-only;",
    "     Actions: Read-only.",
    "     Commit statuses has to be Read and write, not Read-only: Inspector posts",
    "     the `inspector` commit status that gates the merge (issue #304 - these",
    "     steps said Read-only, and four green tasks could not be published).",
    '  3. Under "Where can this GitHub App be installed?", choose "Only on this',
    '     account", then click "Create GitHub App".',
    '  4. On the App\'s settings page, click "Generate a private key". A .pem file',
    "     downloads. Move it somewhere only you can read, e.g.",
    `     \`mv ~/Downloads/*.private-key.pem ${join(recordHome, "github-app.pem")}\`,`,
    `     then \`chmod 600 ${join(recordHome, "github-app.pem")}\`.`,
    '  5. On the same page, copy the "Client ID" (it starts with `Iv`).',
    `  6. Add both to ${brainEnvPath(recordHome)} - one per line:`,
    `       ${APP_ID_VAR}=<the Client ID from step 5>`,
    `       ${APP_KEY_VAR}=${join(recordHome, "github-app.pem")}`,
    `     then \`chmod 600 ${brainEnvPath(recordHome)}\`.`,
    '  7. Back on the App\'s settings page, click "Install App", pick your account,',
    '     and select the repositories Fabrica runs tasks on ("Only select',
    '     repositories").',
    "  8. Run `fabrica doctor` - the \"github app\" line should now read OK and name",
    "     your App.",
  ].join("\n");
}

/** The one-line version, for a `fabrica doctor` fix that is printed
 * inline beside the check it belongs to. */
export function appSetupFix(): string {
  return "register a GitHub App and configure it - run `fabrica doctor` after each step, or see README.md's \"The GitHub App\"";
}

/** What this machine has been told, with no validation at all. */
export function appSettings(env: NodeJS.ProcessEnv, recordHome: string): AppSettings {
  return {
    appId: setting(env, recordHome, APP_ID_VAR),
    keyPath: setting(env, recordHome, APP_KEY_VAR),
  };
}

/** Fabrica's own environment first, then `brain.env`. A world-readable
 * `brain.env` throws from `brainEnvValue`, which is the right answer and
 * is deliberately not caught here: a credential file anyone can read is
 * not a credential, and hiding that would hide the one problem worth
 * stopping for. */
function setting(env: NodeJS.ProcessEnv, recordHome: string, name: string): string | undefined {
  const fromEnv = env[name];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();
  const fromFile = brainEnvValue(recordHome, name);
  return fromFile === undefined || fromFile.trim().length === 0 ? undefined : fromFile.trim();
}

/** A hand-written path may start with `~` (brain.env is edited by hand,
 * and `projects.toml`'s own loader expands the same shorthand) and may
 * be relative to nothing in particular - so it is resolved against the
 * record home rather than the process's working directory, which for a
 * detached task is wherever `fabrica do` happened to be run from. */
export function resolveKeyPath(keyPath: string, recordHome: string): string {
  if (keyPath === "~") return homedir();
  if (keyPath.startsWith("~/")) return join(homedir(), keyPath.slice(2));
  return isAbsolute(keyPath) ? keyPath : resolve(recordHome, keyPath);
}

/**
 * The App's credentials, or the exact reason this machine has none.
 * Throws `GithubAppError`; every message is one complete explanation
 * plus the step that fixes it, written to be printed verbatim.
 */
export function requireAppCredentials(env: NodeJS.ProcessEnv, recordHome: string): AppCredentials {
  const { appId, keyPath } = appSettings(env, recordHome);

  if (appId === undefined && keyPath === undefined) {
    throw new GithubAppError(
      "app-not-configured",
      `No GitHub App is configured, and every push, pull request, issue read and check read Fabrica makes ` +
        `now goes through one - there is no personal-token fallback. Set ${APP_ID_VAR} and ${APP_KEY_VAR} in ` +
        `${brainEnvPath(recordHome)}:\n\n${appSetupSteps(recordHome)}`
    );
  }
  if (appId === undefined || keyPath === undefined) {
    const have = appId === undefined ? APP_KEY_VAR : APP_ID_VAR;
    const missing = appId === undefined ? APP_ID_VAR : APP_KEY_VAR;
    throw new GithubAppError(
      "app-half-configured",
      `The GitHub App is half configured: ${have} is set but ${missing} is not, and both are needed to mint a ` +
        `token. Add ${missing} to ${brainEnvPath(recordHome)}${
          missing === APP_KEY_VAR
            ? " as the path to the App's private key (a .pem file at mode 600)"
            : " as the App's Client ID, from its settings page on github.com"
        }.`
    );
  }

  const path = resolveKeyPath(keyPath, recordHome);

  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (err) {
    throw new GithubAppError(
      "app-key-unreadable",
      `${APP_KEY_VAR} points at ${path}, which could not be read (${
        err instanceof Error ? err.message : String(err)
      }). Point it at the .pem file GitHub gave you when you generated the App's private key.`
    );
  }
  if ((mode & 0o777) !== REQUIRED_KEY_MODE) {
    throw new GithubAppError(
      "app-key-permissions",
      `${path} is mode ${(mode & 0o777).toString(8)} and holds the GitHub App's private key, which must be ` +
        `readable and writable by its owner alone. Run \`chmod 600 ${path}\`, then try again.`
    );
  }

  let privateKeyPem: string;
  try {
    privateKeyPem = readFileSync(path, "utf8");
  } catch (err) {
    throw new GithubAppError(
      "app-key-unreadable",
      `${path} is mode 600 but could not be read (${err instanceof Error ? err.message : String(err)}). Check ` +
        `that you own the file.`
    );
  }

  // Parsed now rather than at the first signature: a key this machine
  // cannot sign with is a configuration problem, and a configuration
  // problem must be findable by `fabrica doctor` and by
  // `Inspector.prepare()`, not only by a task that has already started.
  // The error from node's own parser names no key material - it says
  // only that the PEM could not be decoded - but it is not forwarded
  // anyway, since it would tell the Client nothing he can act on.
  try {
    createPrivateKey(privateKeyPem);
  } catch {
    throw new GithubAppError(
      "app-key-invalid",
      `${path} is not a private key this machine can sign with. It should be the .pem file GitHub downloaded ` +
        `when you clicked "Generate a private key" on the App's settings page, unchanged - beginning with ` +
        `"-----BEGIN RSA PRIVATE KEY-----".`
    );
  }

  return { appId, keyPath: path, privateKeyPem };
}

/** Whether a personal GitHub token is still sitting in Fabrica's own
 * configuration - its environment, or `brain.env`. Issue #187 asks
 * `fabrica doctor` to warn while one is still there: nothing reads it
 * any more, so it is not a failure, but a credential nothing uses is a
 * credential to revoke.
 *
 * `gh auth token` is deliberately not probed. A `gh` login on this
 * machine is the Client's own, not Fabrica's configuration, and warning
 * about it would be warning about the wrong thing. */
export function leftoverPersonalToken(env: NodeJS.ProcessEnv, recordHome: string): string | null {
  const name = "GITHUB_TOKEN";
  if (env[name] !== undefined && env[name]!.trim().length > 0) return "the environment";
  let fromFile: string | undefined;
  try {
    fromFile = brainEnvValue(recordHome, name);
  } catch {
    // A brain.env nobody can safely read is `workerTokenStatus`'s own
    // finding to report, not this one's to duplicate.
    return null;
  }
  return fromFile !== undefined && fromFile.trim().length > 0 ? brainEnvPath(recordHome) : null;
}
