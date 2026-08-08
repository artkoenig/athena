// Formats a duration in milliseconds as a short, human-readable string:
// "850ms", "1.4s", "2m 5s" or "1h 3m", depending on magnitude.
// Every field floors to the unit it prints — 1999 is "1.9s", never "2.0s" —
// so a printed duration is never larger than the duration it stands for.

export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    throw new TypeError(
      `formatDuration expects a finite non-negative number of milliseconds, got ${String(ms)}`,
    );
  }

  if (ms < 1000) {
    return `${Math.floor(ms)}ms`;
  }

  if (ms < 60000) {
    // Truncate to a tenth of a second first; the toFixed(1) that follows only
    // pads an already-truncated value, so it can never round anything up.
    return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  }

  if (ms < 3600000) {
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  }

  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}
