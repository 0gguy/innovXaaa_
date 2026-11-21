// Dates are ISO "YYYY-MM-DD" strings. All arithmetic is UTC so the browser time zone never shifts a week.

const DAY = 86_400_000;

export function toMs(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export function fromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return fromMs(toMs(iso) + days * DAY);
}

/** Every weekly issue date from `first` to `last` inclusive (both are Mondays in /meta). */
export function weeksBetween(first: string, last: string): string[] {
  const out: string[] = [];
  for (let t = toMs(first); t <= toMs(last); t += 7 * DAY) out.push(fromMs(t));
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "28 Jul 2025" */
export function formatDate(iso: string): string {
  const d = new Date(toMs(iso));
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "28 Jul" */
export function formatDayMonth(iso: string): string {
  const d = new Date(toMs(iso));
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function yearOf(iso: string): number {
  return Number(iso.slice(0, 4));
}
