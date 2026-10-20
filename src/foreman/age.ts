// One compact age formatter for every surface that shows one. It used to
// live in src/cli/render.ts, which is the CLI's own presentation layer -
// but the live view never imports from src/cli/ (it reaches Fabrica only
// through src/index.ts, see integrations/live-view/README.md), so a label
// both surfaces must render identically cannot be built there. Moved
// here, re-exported from src/index.ts and from render.ts itself, so every
// existing import still resolves and there is still exactly one
// implementation.

/** Compact, human age like "3s", "12m", "4h15m", "2d3h" - dense enough for
 * a one-line-per-task status listing. */
export function formatAge(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  if (totalHours < 24) return remMinutes > 0 ? `${totalHours}h${remMinutes}m` : `${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}
