// The two lines the relay container says out loud, and the only channel
// it has: its own stdout, read back on the host with `docker logs`
// (control-plane, which works even where nothing on a Docker Desktop
// host can reach the container over the network - see launch.ts).
//
// Plain JavaScript, imported by both sides: entrypoint.mjs writes these
// inside the container with a stock `node` and nothing from
// node_modules, and launch.ts reads them on the host. One definition, so
// the two can never drift into a protocol only one of them speaks.

/** Printed once, when the relay is actually listening, followed by its
 * port. launch.ts's `waitForListening` is the reader. */
export const LISTENING_MARKER = "FABRICA-RELAY-LISTENING";

/** Printed once per refused request, followed by the refusal's details
 * as JSON. launch.ts's watcher turns each one into this task's
 * `"network-refused"` event on the host side - the relay itself writes
 * no record and knows no host path (see server.mjs's header for the
 * incident that moved it out). */
export const REFUSAL_MARKER = "FABRICA-RELAY-REFUSAL";
