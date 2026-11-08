// Timezone resolution for ShowStake. "All date labels include timezone"
// (04-DESIGN-SYSTEM.md): every time is shown with its venue timezone when one
// is declared, else the viewer's IANA timezone, else UTC — never a bare local
// clock with an ambiguous offset.

/** Viewer IANA timezone (client-only); safe fallback for server context. */
export function browserTimezone(): string {
  if (typeof Intl === "undefined") return "UTC";
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Timezone to display for an event: venue takes precedence, then the viewer. */
export function eventDisplayTimezone(event: {
  venueTimezone?: string;
}): string {
  return event.venueTimezone || browserTimezone() || "UTC";
}