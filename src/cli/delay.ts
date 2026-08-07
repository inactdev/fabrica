// The wait between polls of a long-running, abortable loop (`fabrica
// watch`). Whichever of the two outcomes happens - the timer elapses or
// the signal aborts - the other one's handle is released: `watch` calls
// this twice a second against the same signal for as long as the Client
// keeps it open, so an abort listener left behind on the timer path would
// pile up one per poll for the task's whole lifetime.

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
