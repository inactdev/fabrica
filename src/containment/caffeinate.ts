// Keeps the Mac awake for the duration of a worker run (every real OS
// process runContained spawns - a worker's own work()/ask() call and an
// in-box check run alike, since both go through the one `docker` spawn
// in run.ts). macOS only: `caffeinate` doesn't exist anywhere else, and
// this project's own tests and CI run on Linux - spawning a nonexistent
// binary there would turn every contained run into a spawn failure, so
// this is a pure, platform-gated rewrite rather than something run.ts
// has to know about.
//
// Verified against Apple's own source (apple-oss-distributions/
// PowerManagement, caffeinate/caffeinate.c), not assumed: caffeinate
// forks, and the ORIGINAL process - the pid a caller's `spawn` is
// already tracking - immediately `execvp`s into the wrapped utility, so
// that pid becomes the utility itself. A separate, independent child
// holds the sleep-prevention assertion and exits once that pid is gone.
// So wrapping is exit-code- and stdio-transparent: the pid run.ts spawns
// still ends up running `docker` directly (inherited stdout/stderr, and
// `child.on("close")` sees docker's own real exit code), with nothing
// else in run.ts needing to change.
//
// `-i` prevents idle sleep unconditionally; `-s` additionally prevents
// system sleep while on AC power (the man page documents it as a no-op
// on battery) - together, nothing this process can prevent is allowed to
// put the Mac to sleep for as long as the wrapped run is alive.

export function caffeinated(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[] } {
  if (platform !== "darwin") return { command, args };
  return { command: "caffeinate", args: ["-i", "-s", command, ...args] };
}
