/**
 * argus-ui — formatting.
 *
 * Every string the page paints goes through one of these. They live in their
 * own module so the timeline can escape and format without a second copy of
 * `esc`; the bodies are unchanged from when they sat in `app.js`.
 */

export const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

export function fmtNum(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtCost(value) {
  const n = Number(value) || 0;
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 100) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtDur(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '–';
  if (n < 1) return '<1ms';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(2)}s`;
  const minutes = Math.floor(n / 60_000);
  const seconds = Math.round((n % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function fmtClock(ms) {
  if (!ms) return '–';
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(
    date.getSeconds(),
  ).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

export function fmtAgo(ms) {
  if (!ms) return 'never';
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 1000) return 'just now';
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

export const isLive = (session) => Date.now() - session.lastSeenMs < 90_000;

export function shortId(id, keep = 12) {
  return id && id.length > keep + 3 ? `${id.slice(0, keep)}…` : id ?? '';
}

/** A collapsed row shows this much of its text on one line. */
export const PREVIEW_CHARS = 120;

/**
 * The one line a collapsed row shows.
 *
 * The cut is measured on the text itself rather than on its flattened form, so
 * a text carrying more than one line's worth says so even when collapsing its
 * whitespace would have brought it under the limit.
 */
export function previewOf(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const flat = text.slice(0, PREVIEW_CHARS).replace(/\s+/g, ' ').trim();
  return text.length > PREVIEW_CHARS ? `${flat}…` : flat;
}
