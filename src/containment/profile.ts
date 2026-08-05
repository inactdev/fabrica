// Builds the Seatbelt (macOS sandbox) profile `runContained` hands to
// `sandbox-exec -f`. Every rule here was chosen by running it against the
// real binary on the real machine, not by assuming what it should be -
// see README.md's "What was tried and rejected" for the two designs that
// looked reasonable on paper and broke in practice.

function sbplString(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildProfile(opts: { workdir: string; homeDir: string; network: "denied" | "allowed" }): string {
  const workdir = sbplString(opts.workdir);
  const homeDir = sbplString(opts.homeDir);

  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec*)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    // Broad reads, minus one exclusion, rather than a hand-picked allowlist
    // of "the usual" system directories (/usr, /bin, /System, ...): modern
    // macOS's sealed, cryptex-based system volume (see `mount` and
    // `/System/Volumes/Preboot/Cryptexes` on the real machine) has no
    // stable, enumerable set of paths a process needs just to start up -
    // that allowlist was tried first and starved dyld until even
    // `/usr/bin/true` aborted with no error output. What's both
    // enforceable and actually verified is the inverse: allow everything,
    // except the one directory that matters.
    `(allow file-read* (require-all (subpath "/") (require-not (subpath ${homeDir}))))`,
    // workdir is re-opened explicitly because it usually lives INSIDE
    // homeDir (Fabrica's own recordHome defaults to ~/.fabrica) - without
    // this line the rule above would exclude the one place this run is
    // actually meant to read and write.
    `(allow file-read* (subpath ${workdir}))`,
    `(allow file-write* (subpath ${workdir}))`,
  ];

  if (opts.network === "allowed") {
    lines.push("(allow network*)", "(allow system-socket)");
  }

  return lines.join("\n");
}
