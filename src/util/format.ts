/** Small formatting helpers. */

/** Human "3 days ago" style string from an ISO timestamp. */
export function relativeTime(iso?: string): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const s = (Date.now() - then) / 1000;
  if (s < 0) return 'just now';
  if (s < 45) return 'just now';
  if (s < 90) return 'a minute ago';
  const m = s / 60;
  if (m < 45) return `${Math.round(m)} minutes ago`;
  const h = m / 60;
  if (h < 24) return plural(Math.round(h), 'hour');
  const d = h / 24;
  if (d < 30) return plural(Math.round(d), 'day');
  const mo = d / 30;
  if (mo < 12) return plural(Math.round(mo), 'month');
  return plural(Math.round(d / 365), 'year');
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}
