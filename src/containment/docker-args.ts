// Builds the argument list `runContained` hands to `docker run`. Every
// flag here was chosen by running it against the real Docker daemon on
// the real machine, not guessed - see README.md for what was verified.

export function buildDockerArgs(opts: {
  workdir: string;
  network: "denied" | "allowed";
  env?: Record<string, string>;
  image: string;
}): string[] {
  const args = ["run", "--rm", "-v", `${opts.workdir}:/workdir`, "-w", "/workdir"];

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
