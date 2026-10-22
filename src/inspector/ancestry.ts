// Which way round two commits are - the one question two hashes cannot
// answer (task: "make fabrica update keep Inspector current too").
//
// `doctor-checks.ts` can read the installed Inspector's own commit and
// `main`'s tip cheaply, but "different from main's tip" is not "behind
// main": a commit ahead of main, or one on a branch, is different
// without being stale. Ordering them needs main's commit graph, so this
// fetches one into a throwaway temp repository - commits and trees, no
// file contents (`--filter=blob:none`, a quarter of a megabyte for
// Inspector's repository, measured) - asks `git merge-base
// --is-ancestor`, and deletes it again. Nothing outside that temp
// directory is read or written, and no ref of any local repository is
// touched.
//
// Separate from doctor-checks.ts because both callers need it - the
// doctor line and `fabrica update`'s install step - and because it is
// the one probe here that costs real bytes, so where it is reached from
// should be obvious rather than buried.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Whether a commit is in the compared branch's history. "unknown" is a
 * failure to find out (no network, no git), never a verdict. */
export type CommitAncestry = "behind" | "not-behind" | "unknown";

export interface CommitAncestryOptions {
  /** The repository to ask - a URL, or a local path in a test. */
  repoUrl: string;
  /** The branch to measure against. Inspector's is `main`. */
  ref?: string;
  env?: NodeJS.ProcessEnv;
}

/** Whether `commit` is a *strict* ancestor of `ref`'s tip.
 *
 * Strict on purpose: git calls every commit its own ancestor, so the tip
 * itself would otherwise come back "behind". Callers reach this only for
 * a commit already known to differ from the tip they have, but an answer
 * that is wrong for one input is a trap for the next caller, so the tip
 * is ruled out here rather than upstream.
 *
 * A commit that does not resolve inside the fetched history is not in
 * that branch's history at all - a branch of its own, or something ahead
 * of the tip - and that is "not-behind", not a failure. Only a fetch
 * that never landed is "unknown".
 *
 * The answer is relative to the branch as the remote has it *now*:
 * should it move between the `ls-remote` that found the tip and this
 * fetch, "behind" is still behind, only by one commit more. */
export function commitAncestry(commit: string, opts: CommitAncestryOptions): CommitAncestry {
  const ref = opts.ref ?? "main";
  const env = opts.env ?? process.env;
  const dir = mkdtempSync(join(tmpdir(), "fabrica-inspector-ancestry-"));
  try {
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: dir, env, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });

    if (git(["init", "-q"]).status !== 0) return "unknown";
    const fetch = (args: string[]) => git(["fetch", "-q", "--no-tags", ...args, opts.repoUrl, ref]);
    // Blobless first - every commit and tree, no file contents. A server
    // or a git too old for partial clone refuses it, and the ordinary
    // fetch is tried instead rather than reporting a false "unknown".
    if (fetch(["--filter=blob:none"]).status !== 0 && fetch([]).status !== 0) return "unknown";

    const resolved = git(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
    if (resolved.status !== 0) return "not-behind";
    const tip = git(["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"]);
    if (tip.status !== 0) return "unknown";
    if (`${resolved.stdout}`.trim() === `${tip.stdout}`.trim()) return "not-behind";

    const ancestor = git(["merge-base", "--is-ancestor", commit, "FETCH_HEAD"]);
    if (ancestor.status === 0) return "behind";
    if (ancestor.status === 1) return "not-behind";
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
