/** Dates with Intl only (no date library), in the browser's locale and time zone. */
const absolute = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1_000],
];

export function formatDate(iso: string): string {
  return absolute.format(new Date(iso));
}

/** "in 3 hours", "5 minutes ago": the largest unit that fits. */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms || unit === "second") return relative.format(Math.round(diff / ms), unit);
  }
  return relative.format(0, "second");
}
