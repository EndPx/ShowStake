// Adapted from CommitPass `components/events/discover-events.tsx` (baseline
// 542273df306a7e5887f1dfcabf1383e78930f579). Card/list view, upcoming/past tabs,
// per-day grouping, timezone label and empty/loading/error states are preserved;
// search dialog and date calendar are deferred to a later slice. The default
// catalog loader returns "unavailable" (API not wired) — no fabricated events.
"use client";

import { useEffect, useState } from "react";
import { LayoutList, List } from "lucide-react";
import type { EventSummary } from "@/lib/types";
import { dateLabel, isPastEvent } from "@/lib/events";
import { EventListCard } from "./event-list-card";
import { EventPeriodTabs } from "./event-period-tabs";
import {
  EmptyEvents,
  LoadError,
  LoadingEvents,
} from "./event-list-states";
import { eventDisplayTimezone } from "@/lib/timezone";
import { utcOffset } from "@/lib/display-time";
import { loadCatalog, type CatalogLoader, type CatalogResult } from "@/lib/catalog";

function dayKey(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function DiscoverEvents({ load = loadCatalog }: { load?: CatalogLoader }) {
  const [rows, setRows] = useState<EventSummary[]>([]);
  const [status, setStatus] = useState<"loading" | "error" | "ready">(
    "loading",
  );
  const [message, setMessage] = useState("");
  const [stale, setStale] = useState(false);
  const [direct, setDirect] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<"cards" | "list">("cards");
  const [period, setPeriod] = useState("upcoming");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setStatus("loading");
      setMessage("");
      setStale(false);
      let result: CatalogResult;
      try {
        result = await load();
      } catch (value) {
        if (!controller.signal.aborted) {
          setMessage(value instanceof Error ? value.message : "Could not load events.");
          setStatus("error");
        }
        return;
      }
      if (controller.signal.aborted) return;
      if (result.kind === "error") {
        setRows([]);
        setMessage(result.message);
        setStatus("error");
      } else {
        setRows(result.page.items);
        setStale(result.stale);
        setDirect(result.source === "DIRECT_CHAIN");
        setStatus("ready");
      }
    })();
    return () => controller.abort();
  }, [load, attempt]);

  const timezone = eventDisplayTimezone({});
  const visible = rows.filter((event) =>
    period === "past"
      ? isPastEvent(event, now)
      : !isPastEvent(event, now),
  );
  const groups = new Map<string, EventSummary[]>();
  for (const event of visible) {
    const day = dayKey(new Date(event.times.checkinOpen), timezone);
    groups.set(day, [...(groups.get(day) ?? []), event]);
  }
  const today = dayKey(new Date(now), timezone);

  return (
    <main id="workspace-main" className="workspace-content discover-page">
      <div className="discovery-heading">
        <h1>Discover</h1>
        <div className="discovery-tools">
          <div className="discovery-view" aria-label="Event layout">
            <button
              aria-label="Card view"
              aria-pressed={view === "cards"}
              onClick={() => setView("cards")}
            >
              <LayoutList size={18} />
            </button>
            <button
              aria-label="List view"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            >
              <List size={18} />
            </button>
          </div>
        </div>
      </div>
      <div className="discovery-layout">
        <aside className="discovery-sidebar" aria-label="Browse by date">
          <EventPeriodTabs
            value={period}
            onChange={(value) => setPeriod(value)}
          />
          <p className="discovery-timezone">
            Times in {utcOffset(new Date(now), timezone)}
            <span>{timezone.replaceAll("_", " ")}</span>
          </p>
        </aside>
        <div className="discovery-results">
          <div className="discovery-result-count" aria-live="polite">
            {status === "loading"
              ? "Loading events…"
              : `${visible.length} ${visible.length === 1 ? "event" : "events"}`}
          </div>

          {status === "ready" && direct && <p role="status">DIRECT_CHAIN: events read from the verified contract. Index projections may be unavailable.</p>}
          {status === "error" ? (
            <LoadError
              message={message}
              retry={() => setAttempt((value) => value + 1)}
            />
          ) : status === "loading" ? (
            <LoadingEvents />
          ) : visible.length ? (
            <>
              {stale && (
                <p className="catalog-stale" role="status">
                  Some sources are unavailable or incomplete. Open an event to check its current contract state.
                </p>
              )}
              <div className={`discovery-agenda discovery-agenda--${view}`}>
              {Array.from(groups.entries()).map(([day, events]) => (
                <section className="agenda-day" key={day}>
                  <h2>
                    <strong>
                      {day === today
                        ? "Today"
                        : dateLabel(events[0]!.times.checkinOpen, timezone, {
                            month: "long",
                            day: "numeric",
                          })}
                    </strong>
                    <span>
                      {dateLabel(events[0]!.times.checkinOpen, timezone, {
                        weekday: "long",
                      })}
                    </span>
                  </h2>
                  <div className="agenda-day-events">
                    {events.map((event) => (
                      <EventListCard
                        key={event.id}
                        event={event}
                        layout={view}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
            </>
          ) : (
            <EmptyEvents
              title={
                period === "past"
                  ? "No past events yet."
                  : "Good plans start with someone."
              }
              description={
                period === "past"
                  ? "Finished events will appear here once the catalog is connected."
                  : "Published events appear here after their transactions finalize."
              }
              href="/discover"
              action="Refresh"
              icon={<LayoutList size={30} />}
              onAction={() => setAttempt((value) => value + 1)}
            />
          )}
        </div>
      </div>
    </main>
  );
}