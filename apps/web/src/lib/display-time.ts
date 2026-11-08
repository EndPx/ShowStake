// Adapted from CommitPass `apps/web/src/lib/display-time.ts` (baseline
// 542273df306a7e5887f1dfcabf1383e78930f579). UI copy is chain-independent;
// timezone and locale formatting are unchanged. Provenance: docs/frontend-provenance.json.

/** Short UTF offset (e.g. `UTC+07:00`) for a date in an IANA timezone. */
export function utcOffset(date: Date, timezone: string) {
  const offset = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = offset?.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  return match
    ? `UTC${match[1]}${match[2]!.padStart(2, "0")}:${match[3] ?? "00"}`
    : "UTC+00:00";
}

/** 24-hour `HH:mm` clock time in the given IANA timezone. */
export function displayTime(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/** `HH:mm UTC±hh:mm` — authoritative timezone label used everywhere a time is shown. */
export function clockLabel(date: Date, timezone: string) {
  return `${displayTime(date, timezone)} ${utcOffset(date, timezone)}`;
}

/** Fallback clock label when a date/timezone is unavailable (never invent a time). */
export const unavailableTimeLabel = "Time unavailable";