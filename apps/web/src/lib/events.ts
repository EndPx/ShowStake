// Chain-independent event view helpers, adapted from CommitPass
// `apps/web/src/lib/events.ts` and `event-list-card.tsx` (baseline
// 542273df306a7e5887f1dfcabf1383e78930f579). EVM `viem`/Solidity statuses are
// removed; state labels use the ShowStake event lifecycle (packages/domain).

import type { EventState, EventSummary } from "./types";

export const eventTitle = (event: EventSummary) =>
  event.title?.trim() || "Untitled event";

/** Location is "online" only when it is an explicit URL that is not a map. */
export function eventFormat(event: EventSummary): "online" | "in-person" | "unknown" {
  const location = event.venue?.trim() ?? "";
  if (!location) return "unknown";
  const link =
    /^(https?:\/\/|www\.)/i.test(location) ||
    /^[\w.-]+\.[a-z]{2,}\//i.test(location);
  const maps =
    /(?:maps\.app\.goo\.gl|google\.[^/]+\/maps|maps\.google\.)/i.test(location);
  return link && !maps ? "online" : "in-person";
}

/** Registration is open strictly in the `reg_open <= now < reg_close` window. */
export function registrationOpen(event: EventSummary, now: number): boolean {
  const { regOpen, regClose } = event.times;
  const open = Date.parse(regOpen);
  const close = Date.parse(regClose);
  return Number.isFinite(open) && Number.isFinite(close) && now >= open && now < close;
}

/** Human status label for the ShowStake event lifecycle. */
export function statusLabel(state: EventState): string {
  switch (state) {
    case "PUBLISHED":
      return "Published";
    case "ATTENDANCE_FINALIZED":
      return "Attendance finalized";
    case "SETTLING":
      return "Settling";
    case "SETTLED":
      return "Event ended";
    case "CANCELLED":
      return "Cancelled";
    case "REFUND_ONLY":
      return "Refunds available";
    default:
      return "Unavailable";
  }
}

/** Long-form date label with the venue timezone (never a bare UTC guess). */
export function dateLabel(
  iso: string,
  timezone: string,
  options: Intl.DateTimeFormatOptions = {
    weekday: "long",
    month: "long",
    day: "numeric",
  },
): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString("en-US", { ...options, timeZone: timezone })
    : "Date unavailable";
}

/** 24-hour time label with the venue timezone. */
export const timeLabel = (iso: string, timezone: string) =>
  new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  });

/** true when a finished event has no attendee edge worth showing. */
export function isEnded(state: EventState): boolean {
  return state === "SETTLED" || state === "CANCELLED" || state === "REFUND_ONLY";
}

/** true when a live event is in the "past" bucket (terminal or fully elapsed). */
export function isPastEvent(event: EventSummary, now: number): boolean {
  if (isEnded(event.state)) return true;
  const close = Date.parse(event.times.checkinClose);
  return Number.isFinite(close) && close <= now;
}

/**
 * Phase-aware, fail-closed seat availability for a card/row. Seat numbers are
 * only ever claimed for a PUBLISHED event inside its explicit registration
 * window; before open, after close, any other state, or a missing/unknown
 * participant count or capacity yields a neutral/unavailable label — never an
 * implicit "0 spots left".
 */
export function availabilityLabel(event: EventSummary, now: number): string {
  if (isEnded(event.state)) return statusLabel(event.state);
  if (event.state !== "PUBLISHED" || !registrationOpen(event, now)) {
    return statusLabel(event.state);
  }
  const count = event.participantCount;
  if (count === undefined || !Number.isInteger(count) || count < 0) {
    return "Unavailable";
  }
  if (!Number.isInteger(event.capacity) || event.capacity < 0) {
    return "Unavailable";
  }
  const remaining = event.capacity - count;
  if (remaining <= 0) return "Full";
  return `${remaining} ${remaining === 1 ? "spot" : "spots"} left`;
}