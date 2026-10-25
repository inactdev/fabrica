# Docker networks are a finite resource, and a leaked one is permanent

Three durable facts came out of making a task's Docker networks go away
with its round.

## Docker's address pools run out, and the daemon's own message doesn't say why

Every `docker network create` takes a subnet from a fixed set of
predefined pools (moby's `ipamutils`: 172.17-172.19/16, 172.20-172.31
in /14 blocks split to /16, 192.168.0.0/16 split to /20, 10.0.0.0/8
split to /24). A network that is never removed keeps its pool for as
long as the daemon has it, so a machine that has leaked enough of them
can create no network at all - and Fabrica opens two per round (the
worker's `--internal` network and the relay's egress one).

The two daemon messages, read out of moby's own source rather than
guessed at:

- current moby: `all predefined address pools have been fully
  subnetted` - `ipamapi.ErrNoMoreSubnets`, in
  `daemon/libnetwork/ipamapi/contract.go`.
- up to moby v24: `could not find an available, non-overlapping IPv4
  address pool among the defaults to assign to the network` -
  `libnetwork/ipam/allocator.go`'s `allocatePredefinedPool`.

Both are matched (case-insensitively, on a fragment) in
`src/containment/network-pools.ts`, so the failure is reported with the
cause and `docker network prune -f` rather than Docker's sentence
alone. Neither message names a fix, and neither says the pools are a
shared machine-wide resource - which is the one thing the person
reading it needs to know.

## `docker network prune` only removes *unused* networks

Worth knowing before telling anyone to run it: prune's own definition
of unused is "not referenced by any containers". A leftover network
that still has a half-reaped container attached is exactly the case
that leaks, and prune will not touch it. That is why
`removeTaskNetworks` forces attached containers off with
`docker network disconnect -f` and retries the removal, rather than
just calling `network rm` and reporting the failure: at end of round
those containers are the task's own throwaway box and relay, and
nothing else is allowed on that network by construction.

Two more CLI details that the flags' names do not give away:
`docker network rm -f` means "do not error if the network does not
exist", **not** "remove it whatever is attached"; and `docker network
inspect` with no `--format` already renders a JSON array carrying
`Labels` and `Containers`, so no Go template is needed to read either.

## Labels are how a network outlives the process that made it

A task's networks are named after a random per-call id, so after the
process that created them is gone, nothing on the machine can say which
task a `fabrica-worker-*` network belonged to - or whether it is still
in use. Two `docker network create --label` pairs (`fabrica.role`,
`fabrica.task`) fix that for everything downstream: the Foreman's
end-of-round sweep selects on `--filter label=fabrica.task=<id>` (so it
can only ever touch its own task's networks, even with other tasks
running), and `fabrica doctor` reads the same label back to tell a
running task's network from a leftover. The generalisable bit: when a
cleanup has to work across a process boundary, put the key on the
object in the external system, not in a file Fabrica would then have to
keep in step.

## Reading a vendor's docs from a worker box

The relay's tunnel allowlist is the model host plus `github.com` /
`*.github.com`, so `docs.docker.com` is unreachable from inside a
worker - but `api.github.com` is not. Docker's own CLI reference is
`docker/cli`'s `docs/reference/commandline/*.md`, and moby's source is
`moby/moby`, both readable through the GitHub contents API with an
`Accept: application/vnd.github.raw` header (and a `?ref=<tag>` to read
how an older release worded something). Node's `fetch` ignores
`HTTPS_PROXY`, so the request has to go through an explicit
`http.request({ method: "CONNECT" })` tunnel to the relay and a
`tls.connect` over the returned socket. That is how every Docker flag
and error string in this change was verified against primary sources
rather than recalled.
