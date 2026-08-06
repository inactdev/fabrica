// Resolves a ProductionLine workdir's real git directory - the shared
// object database and refs every worktree points back to - straight
// from the worktree's own `.git` pointer file, without needing the
// `ProductionLine` object itself (only `workdir`, which is all a `Brain`
// adapter's `work(brief, workdir, opts)` ever receives - contract/
// surface.ts's `Brain` interface has no room to also pass `project` or
// `taskId` through).
//
// `git worktree add` always leaves `<workdir>/.git` as a one-line
// pointer file, `gitdir: <project>/.git/worktrees/<taskId>` - a real,
// absolute host path outside `workdir` entirely. That file's own
// `commondir` (relative to it) names the actual shared `.git` - the
// object database, refs, and config every worktree of the same project
// shares. This is what a contained process needs mounted (read-only) to
// use git at all; see src/containment/README.md and this project's
// AGENTS.md for why.

import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LineError } from "./errors.ts";

export function resolveCommonGitDir(workdir: string): string {
  const pointerPath = join(workdir, ".git");
  let pointer: string;
  try {
    pointer = readFileSync(pointerPath, "utf8").trim();
  } catch (err) {
    throw new LineError(
      "not-a-worktree",
      `Fabrica needs a git repository in the working directory: "${pointerPath}" could not be read (${
        err instanceof Error ? err.message : String(err)
      }). Initialize git in the project first - Fabrica cuts its ProductionLine worktrees from a real repository.`
    );
  }

  const match = pointer.match(/^gitdir: (.+)$/);
  if (!match) {
    throw new LineError(
      "not-a-worktree",
      `"${pointerPath}" is not a git worktree pointer file (expected "gitdir: <path>", found "${pointer}")`
    );
  }
  // git 2.48+ can write a relative gitdir here (worktree.useRelativePaths
  // / extensions.relativeWorktrees), resolved relative to the pointer
  // file's own directory - never the process's cwd.
  const worktreeGitDir = resolve(workdir, match[1]);

  let commondir: string;
  try {
    commondir = readFileSync(join(worktreeGitDir, "commondir"), "utf8").trim();
  } catch (err) {
    throw new LineError(
      "not-a-worktree",
      `"${worktreeGitDir}/commondir" could not be read: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const commonGitDir = resolve(worktreeGitDir, commondir);
  try {
    return realpathSync(commonGitDir);
  } catch (err) {
    throw new LineError(
      "not-a-worktree",
      `"${commonGitDir}" (the shared .git this worktree points to) does not resolve to a real, existing path: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

// The shared .git's `config` can carry a credential in more ways than
// one: a remote URL like https://user:token@host/repo.git (quoted
// [remote "origin"] or git's deprecated dotted [remote.origin] form),
// an http.<url>.extraheader authorization line, a url.<base>.insteadOf
// rewrite with an embedded credential, a [credential] helper setting,
// or an [include]/[includeIf] path pulling any of those in. A contained
// process that can read one (and is allowed network) could push with it
// - so the config mounted into a container must never be the real one.
// This writes a throwaway sanitized copy that copies forward ONLY the
// [core] section, plus individually allowlisted [extensions] keys, and
// drops every other section by default - an allowlist, so anything not
// explicitly forwarded is invisible by construction, rather than a
// denylist that fails open on the first unanticipated form. The caller
// shadow-mounts the copy over the real config's path and deletes it
// after the call. A [core]-only config is enough for an ordinary repo:
// git refuses to detect a repository with no config at all ("fatal:
// not a git repository: (null)", verified live), but status/log/diff
// all work normally with only [core] present.
//
// [extensions] keys are the one thing that can't just be dropped: they
// are structural (hash algorithm, ref storage backend, relative
// worktree paths), so a git that can't see them misreads the repo
// outright. Each key documented by the installed git that is
// credential-free by construction is forwarded individually below; any
// other [extensions] key fails the run with an error naming it - never
// silently dropped (which would misread the repo), never passed
// through (a future key's value may not be credential-free:
// refStorage already accepts a URI payload, and git's manual
// anticipates backends like postgres:// whose URI could carry a
// password). A URI-form refStorage value (<format>://<payload>) fails
// for the same reason - its payload names a host location the
// container can't see - while a bare format name (files, reftable)
// forwards normally. worktreeConfig is deliberately not allowlisted:
// forwarding it would make git honor an unsanitized config.worktree
// file inside the mount, reopening the config-borne credential channel
// this sanitizer exists to close.
const FORWARDED_EXTENSION_KEYS = new Set([
  "compatobjectformat",
  "noop",
  "noop-v1",
  "objectformat",
  "partialclone",
  "preciousobjects",
  "refstorage",
  "relativeworktrees",
  "submodulepathconfig",
]);

// git accepts a variable written on the same line as its section header
// ("[extensions] objectFormat = sha256" sets extensions.objectFormat,
// verified live), so a key can arrive either on its own line or riding
// the header. Both forms go through this one check.
function checkExtensionEntry(entryText: string, configPath: string): void {
  const entry = entryText.match(/^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/);
  if (!entry) {
    throw new LineError(
      "unsanitizable-config",
      `"${configPath}" has an [extensions] line ("${entryText}") this sanitizer cannot parse - refusing to guess whether it is credential-free`
    );
  }
  const key = entry[1];
  if (!FORWARDED_EXTENSION_KEYS.has(key.toLowerCase())) {
    throw new LineError(
      "unsanitizable-config",
      `"${configPath}" sets extensions.${key}, which is not on the sanitizer's allowlist of known credential-free extension keys - refusing to forward it into the container or silently drop it`
    );
  }
  if (key.toLowerCase() === "refstorage" && (entry[2] ?? "").includes("://")) {
    throw new LineError(
      "unsanitizable-config",
      `"${configPath}" sets extensions.refStorage to a URI-form value, whose payload names a host location not visible inside the container - only a bare format name (files, reftable) can be forwarded`
    );
  }
}

export function writeSanitizedGitConfig(commonGitDir: string): string {
  const configPath = join(commonGitDir, "config");
  let config: string;
  try {
    config = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new LineError(
      "not-a-worktree",
      `"${configPath}" could not be read: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const kept: string[] = [];
  const extensionLines: string[] = [];
  let section: "core" | "extensions" | "other" = "other";
  for (const line of config.split("\n")) {
    const header = line.match(/^\s*\[\s*([^\s\]"]+)/);
    if (header) {
      const name = header[1].toLowerCase();
      if (name === "core") {
        section = "core";
      } else if (name === "extensions" || name.startsWith("extensions.")) {
        if (!/^\s*\[\s*extensions\s*\]/i.test(line)) {
          throw new LineError(
            "unsanitizable-config",
            `"${configPath}" has an [extensions] header with a subsection ("${line.trim()}"), which no documented extension key uses - refusing to forward it into the container or silently drop it`
          );
        }
        section = "extensions";
        const inline = line.replace(/^\s*\[\s*extensions\s*\]/i, "").trim();
        if (inline !== "" && !inline.startsWith("#") && !inline.startsWith(";")) {
          checkExtensionEntry(inline, configPath);
          extensionLines.push(`\t${inline}`);
        }
      } else {
        section = "other";
      }
      if (section === "core") kept.push(line);
      continue;
    }
    if (section === "core") {
      kept.push(line);
    } else if (section === "extensions") {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
      checkExtensionEntry(trimmed, configPath);
      extensionLines.push(line);
    }
  }
  if (extensionLines.length > 0) kept.push("[extensions]", ...extensionLines);

  const dir = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-sanitized-git-config-"));
  const sanitizedPath = join(dir, "config");
  writeFileSync(sanitizedPath, `${kept.join("\n")}\n`);
  return sanitizedPath;
}
