# Stopping a Docker container you may not have created yet (issue #346)

`docker run` creates a container and then starts it. Anything that
reacts to an abort by issuing one `docker stop`/`docker rm -f` therefore
has a window where it stops nothing at all: the container does not exist
when the command runs, it exists a moment later, and nothing ever asks
again. `src/containment/run.ts` had that shape for both `stopSignal` and
`gracefulStopSignal`, and it showed up as two `docker-tests` failures at
600 seconds on a loaded CI runner (a 500ms abort, a `sleep 600` command)
rather than as anything visible locally.

The fix is to reissue the stop until the run really ends. Two
non-obvious parts of it, both worth keeping:

- **The termination condition is the `docker run` client process
  exiting, not a stop command reporting success.** `docker stop` against
  a container docker has created but not yet *started* exits 0 without
  stopping anything - the container then starts and runs its full
  course - and a force-remove of a container that isn't there has
  answered differently across docker versions (refusing and saying so
  in some, treating it as already done and succeeding in others). So
  neither a stop's exit code nor its message is read at all. The client
  exiting is the strongest signal available: `--rm` has docker remove
  the container as it exits and the attached client leaves with it.
  Its limit, worth knowing rather than discovering: a client that exits
  for a reason of its own - a dropped connection to the daemon,
  something killing it - ends the loop while the container may still be
  alive. Nothing is issued after the call settles anyway, because a
  container name belongs to the caller and may be reused by its next
  run, so a late stop could remove that run's box instead. Teardown
  past the point the call hands back is the caller's.
- **Schedule each attempt from the previous one's callback, not on a
  fixed interval.** `docker stop --time 10` can block for its whole
  grace period; a `setInterval` would stack concurrent stops behind it.

## `docker stop --time` is deprecated but still accepted

Verified against the installed CLI (Docker 28.1.1, offline - flag
parsing happens before the daemon is contacted, so `docker stop --time
10 <name>` reports flag problems even with no daemon running):
`--time` prints `Flag --time has been deprecated, use --timeout
instead` and then works. `--timeout` is the current spelling. Left as
`--time` on purpose: the warning goes to a stderr this module already
swallows, and `--timeout` is the newer of the two spellings, so moving
to it would be the change that could break against an older CLI. Worth
revisiting if docker ever removes `--time`, in which case the graceful
stop fails with `unknown flag` - which is why it is written down here
rather than left to be discovered.

## Testing a container's lifetime with no daemon

`src/containment/helpers/fake-docker-stop.mjs` is a second `docker`
stand-in next to `helpers/fake-docker.mjs`, kept separate because that
one stands for the network and image commands and six suites read it.
The new one models one container: `run` blocks until a stop lands and
then exits 137, or gives up at a ceiling and exits 99 ("ran its
course"), and the first N stops answer as one for a container that
isn't there. That turns the bug into a one-second assertion (`137` vs
`99`) on any machine, which matters here because every other test in
`run.test.ts` skips without a daemon - the fix would otherwise have
landed with nothing executed behind it.

That answer is configurable in shape (`missedStopReply`) and the two
tests take one each, because the real CLI has no single answer for a
container that isn't there: a `docker stop` fails and names it, a
force-remove has in some versions treated it as already done and
succeeded. The code under test reads neither the exit code nor the
message of a stop, so the point is not to pin a version down - it is
that both shapes are driven through it, and the silent-success one is
what a future "stop reissuing once a stop succeeds" would fail.

Its `run` blocks with `Atomics.wait` on a throwaway `SharedArrayBuffer`
rather than a timer, so nothing about it can finish early because the
event loop happened to be free.
