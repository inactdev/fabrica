// Builds the argument list `runContained` hands to `docker run`. Every
// flag here was chosen by running it against the real Docker daemon on
// the real machine, not guessed - see README.md for what was verified.

export function buildDockerArgs(opts: {
  workdir: string;
  network: "denied" | "allowed";
  env?: Record<string, string>;
  image: string;
  user?: string;
}): string[] {
  // The long `--mount` form, not `-v`: its key=value fields don't split
  // on a ':' appearing in the workdir path the way the short form does.
  const args = ["run", "--rm", "--mount", `type=bind,source=${opts.workdir},target=/workdir`, "-w", "/workdir"];

  // Run as the invoking host user, not root: on native Linux, files a
  // root container writes into the bind mount come out root-owned on
  // the host, breaking host-side git and teardown - see README.md.
  if (opts.user !== undefined) args.push("--user", opts.user);

  // Denied is the absence of network access, not a rule fenced around
  // it - Docker's own `--network none` gives the container no network
  // interface at all (verified: DNS resolution itself fails under it).
  if (opts.network === "denied") args.push("--network", "none");

  // Docker never auto-inherits the host's environment into a container
  // (verified), so nothing needs filtering here - only what's listed
  // reaches the container, exactly "the worker has what it needs."
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(opts.image);
  return args;
}
