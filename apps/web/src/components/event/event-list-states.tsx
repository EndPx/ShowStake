// Adapted from CommitPass `components/events/event-list-states.tsx` (baseline
// 542273df306a7e5887f1dfcabf1383e78930f579). Accessible status/empty/error
// mechanics preserved; adds an honest "catalog unavailable" state for the not-
// yet-wired ShowStake API. Provenance: docs/frontend-provenance.json.
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, CalendarDays, Ticket } from "lucide-react";

export function EmptyEvents({
  title,
  description,
  href,
  action,
  icon,
  onAction,
}: {
  title: string;
  description: string;
  href: string;
  action: string;
  icon?: ReactNode;
  onAction?: () => void;
}) {
  return (
    <div className="workspace-empty plans-empty">
      <div className="plans-empty-icon" aria-hidden="true">
        {icon ?? <Ticket size={30} strokeWidth={1.4} />}
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {onAction ? (
        <button className="button" onClick={onAction}>
          {action}
          <ArrowRight size={16} />
        </button>
      ) : (
        <Link className="button" href={href}>
          {action}
          <ArrowRight size={16} />
        </Link>
      )}
    </div>
  );
}

export function LoadError({
  message,
  retry,
}: {
  message: string;
  retry: () => void;
}) {
  return (
    <div className="workspace-error" role="alert">
      <h2>We couldn’t load that.</h2>
      <p>{message}</p>
      <button className="button" onClick={retry}>
        Try again
      </button>
    </div>
  );
}

/** Loading skeleton — preserves layout (aria-busy + label), no fake data. */
export function LoadingEvents({ count = 3 }: { count?: number }) {
  return (
    <div
      className="plans-skeletons"
      aria-busy="true"
      aria-label="Loading events"
    >
      {Array.from({ length: count }, (_, value) => (
        <div key={value}>
          <div />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}

/** Honest "no data yet" state: the catalog is unavailable until the API is wired. */
export function CatalogUnavailable({
  title = "Events will appear here.",
  description = "The discovery catalog is not connected to the ShowStake API yet, so there are no live events to show. Nothing is fabricated while the catalog is unavailable.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="workspace-empty plans-empty">
      <div className="plans-empty-icon" aria-hidden="true">
        <CalendarDays size={30} strokeWidth={1.4} />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}