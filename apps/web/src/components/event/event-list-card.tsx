// Adapted from CommitPass `components/events/event-list-card.tsx` (baseline
// 542273df306a7e5887f1dfcabf1383e78930f579). EVM-shaped types/status and the
// "vault" addressing are replaced with the ShowStake OpenAPI Event model and
// atomic money. Provenance: docs/frontend-provenance.json.
"use client";

import Link from "next/link";
import { MapPin, Users, Video } from "lucide-react";
import type { EventSummary } from "@/lib/types";
import { clockLabel } from "@/lib/display-time";
import { availabilityLabel, eventFormat, eventTitle, statusLabel } from "@/lib/events";
import { Amount } from "@/components/ui/amount";
import { EventCover } from "./event-cover";
import { eventDisplayTimezone } from "@/lib/timezone";

export function EventListCard({
  event,
  personal = false,
  hosting = false,
  layout,
}: {
  event: EventSummary;
  personal?: boolean;
  hosting?: boolean;
  layout?: "cards" | "list";
}) {
  const timezone = eventDisplayTimezone(event);
  const title = eventTitle(event);
  const host = "Organizer";
  const venue = event.venue?.trim() ?? "";
  const online = eventFormat(event) === "online";
  const ended = ["SETTLED", "CANCELLED", "REFUND_ONLY"].includes(event.state);
  const badge = ended
    ? statusLabel(event.state)
    : hosting
      ? "Hosting"
      : "Spot reserved";
  const availability = availabilityLabel(event, Date.now());
  const start = new Date(event.times.checkinOpen);
  const startIso = Number.isFinite(start.getTime())
    ? start.toISOString()
    : event.times.checkinOpen;
  const className = layout ? `agenda-event agenda-event--${layout}` : "plan-card";
  // Only link to a detail route whose CHAIN id is resolved; never a bare API UUID.
  const href = event.chainEventId ? `/events/${encodeURIComponent(event.chainEventId)}${event.network === "mainnet" && event.contractId ? `?contract=${encodeURIComponent(event.contractId)}` : ""}` : null;

  const body = (
    <>
      {layout === "list" && (
        <time className="agenda-list-time" dateTime={startIso}>
          {clockLabel(start, timezone)}
        </time>
      )}
      <div className="plan-card-info">
        <div
          className={`plan-time${layout === "list" ? " agenda-list-meta" : ""}`}
        >
          {layout !== "list" && (
            <time dateTime={startIso}>{clockLabel(start, timezone)}</time>
          )}
        </div>
        <h2>{title}</h2>
        {venue && (
          <p className="plan-location">
            {online ? <Video size={15} /> : <MapPin size={15} />}
            <span>
              {online ? "Online event" : venue || "Location to be announced"}
            </span>
          </p>
        )}
        <div className="plan-card-bottom">
          {personal ? (
            <span
              className={`plan-badge ${hosting && !ended ? "plan-badge--host" : ""} ${ended ? "plan-badge--quiet" : ""}`}
            >
              {badge}
            </span>
          ) : (
            <span className="discover-commitment">
              <Amount
                value={event.depositAtomic}
                decimals={event.assetDecimals}
                symbol={event.assetSymbol}
              />{" "}
              <span>commitment</span>
            </span>
          )}
          <span className="plan-guests">
            <Users size={14} /> {availability}
          </span>
        </div>
      </div>
      {(personal || layout === "cards") && <EventCover small title={title} />}
    </>
  );

  if (href) {
    return (
      <Link className={className} href={href}>
        {body}
      </Link>
    );
  }
  return <div className={className}>{body}</div>;
}