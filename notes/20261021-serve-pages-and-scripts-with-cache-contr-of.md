# The live view's `Cache-Control: no-store` was already true, just unpinned

The task was "serve pages and scripts with `Cache-Control: no-store`",
and the Client's clarification said plainly that nothing sets a cache
header today and asked for it to be set unconditionally in the one `send`
helper. That turned out to describe the code exactly as it already was:
`integrations/live-view/server.ts`'s `send` has set
`"Cache-Control": "no-store"` alongside the content type since the live
view's very first commit (`e8119eb`, issue #26), and every route in the
module - static pages, scripts, stylesheet, every JSON endpoint, each
refusal, and the 500 fallback - answers through that one function. So the
requested behaviour was in place and correct on the wire before this
task started.

What was missing was anything making it stay that way. No test anywhere
asserted a cache header: the whole suite passed with the header deleted,
so a tidy-up of that one line, or a new route writing its own headers,
would have removed the behaviour silently. The README said nothing about
it either, so the next reader had no way to know the absence of
fingerprinted asset paths is *why* it has no exceptions.

## The durable fact worth keeping

`send` being the only function in `server.ts` that writes response
headers is a load-bearing property, not an incidental one. It is what
turns a single line into a guarantee about every route, including ones
that don't exist yet. `server.test.ts` now pins it in two halves on
purpose:

- a behavioural sweep over one request of every response *shape* (page,
  script, stylesheet, the `/tasks/<id>` page served off its own route,
  each JSON endpoint, and the 400/403/404/405 refusals), and
- a structural check reading `server.ts`'s own source for exactly one
  `writeHead` and zero `setHeader`/`appendHeader` calls.

The sweep alone would only ever cover today's routes. The structural
check is the half that makes a future route unable to opt out - the same
approach `src/foreman/no-host-check.test.ts` takes to keep a host-side
check from coming back, and `rule9-gate.contract-paths.test.ts` takes for
a fact with no code to unit-test.

Both halves were verified by negative control rather than assumed, which
is what proved the gap was real in the first place: with the header
removed, 2 tests fail; with a new route injected that writes its own
`writeHead`, the structural one fails naming the count; with the header
moved to a `res.setHeader` call outside the `writeHead`, both fail. A
test that passes either way would have been worse than none here, since
the behaviour it was meant to protect already existed.

## The general shape to watch for

When a task asks for something that is already true, the honest
deliverable is usually the enforcement, not a no-op - and saying so
plainly beats both silently changing nothing and inventing a second place
to set the same value. A second, belt-and-braces `res.setHeader` in the
request listener was considered and rejected for exactly that reason: two
sites setting one header is the drift the single-helper design exists to
prevent.

`src/relay/server.mjs` is the only other HTTP server in this repo and is
deliberately untouched - it serves plain-text refusals and proxied
upstream bytes to a worker's container, never a page or a script to a
browser, and forwarding an upstream's own headers verbatim is the point
of a proxy.
