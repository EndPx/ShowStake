// CommitPass source adaptation; geometry/components retained, NEAR catalog and exact atomic values substituted.
"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Compass,
  LayoutList,
  List,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { EventSummary } from "@/lib/types";
import {dateLabel as showstakeDateLabel,eventTitle,statusLabel as stateLabel,timeLabel,eventFormat,isPastEvent,registrationOpen} from '@/lib/events';
import {formatUnits} from '@/lib/money';
import {loadCatalog,type CatalogLoader} from '@/lib/catalog';
import {eventDisplayTimezone} from '@/lib/timezone';
const dateLabel=(iso:string,options:Intl.DateTimeFormatOptions)=>showstakeDateLabel(iso,String(options.timeZone??'UTC'),options);
const statusLabel=(event:EventSummary)=>stateLabel(event.state);
const amount=(value:string)=>formatUnits(value,6);
const hasOpenSpots=(event:EventSummary,now:number)=>event.state==='PUBLISHED'&&registrationOpen(event,now)&&Number.isInteger(event.participantCount)&&event.participantCount!>=0&&Number.isInteger(event.capacity)&&event.participantCount!<event.capacity;
import { utcOffset } from "@/lib/display-time";
import { EventListCard } from "./event-list-card";
import { EventCover } from "./event-cover";
import { EventPeriodTabs } from "./event-period-tabs";
import { EmptyEvents, LoadError } from "./event-list-states";

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
const eventDay = (event: EventSummary, timezone: string) =>
  dayKey(new Date(event.times.checkinOpen), timezone);
const isPast=isPastEvent;
function searchText(event: EventSummary) {
  return `${eventTitle(event)} ${event.venue ?? ""} ${event.organizerAccount ?? ""}`.toLocaleLowerCase();
}

export function DiscoverEvents({load=loadCatalog}:{load?:CatalogLoader}) {
  const [timezone,setTimezone]=useState('UTC');useEffect(()=>setTimezone(eventDisplayTimezone({})),[]);
  const [stale,setStale]=useState(false);
  const [rows, setRows] = useState<EventSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [after, setAfter] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<"cards" | "list">("cards");
  const [period, setPeriod] = useState("upcoming");
  const [selectedDay, setSelectedDay] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(true);
  const [format, setFormat] = useState("all");
  const [openOnly, setOpenOnly] = useState(false);
  const [now, setNow] = useState(Date.now);
  const filterMenu = useRef<HTMLDetailsElement>(null);
  const today = dayKey(new Date(now), timezone);
  const filterCount = Number(format !== "all") + Number(openOnly);
  const reset = () => {
    setSelectedDay("");
    setFormat("all");
    setOpenOnly(false);
  };
  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const adapt = () => setCalendarOpen(!media.matches);
    adapt();
    media.addEventListener("change", adapt);
    return () => media.removeEventListener("change", adapt);
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(()=>{const controller=new AbortController();setLoading(true);setError('');void(async()=>{try{const result=await load();if(controller.signal.aborted)return;if(result.kind==='error'){setRows([]);setError(result.message);}else{setRows(result.page.items);setStale(result.stale);setCursor(null);}}catch(value){if(!controller.signal.aborted){setRows([]);setError(value instanceof Error?value.message:'Could not load events.');}}finally{if(!controller.signal.aborted)setLoading(false);}})();return()=>controller.abort();},[load,attempt,after]);
  useEffect(() => {
    function dismiss(event: PointerEvent) {
      if (!filterMenu.current?.contains(event.target as Node))
        filterMenu.current?.removeAttribute("open");
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape" && filterMenu.current?.open) {
        filterMenu.current.removeAttribute("open");
        filterMenu.current.querySelector("summary")?.focus();
      }
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  const visible = rows
    .filter(
      (event) =>
        (period === "past" ? isPast(event, now) : !isPast(event, now)) &&
        (!selectedDay || eventDay(event, timezone) === selectedDay) &&
        (format === "all" || eventFormat(event) === format) &&
        (!openOnly || hasOpenSpots(event, now)),
    )
    .sort(
      (a, b) =>
        (Date.parse(a.times.checkinOpen) - Date.parse(b.times.checkinOpen)) * (period === "past" ? -1 : 1),
    );
  const groups = new Map<string, EventSummary[]>();
  for (const event of visible) {
    const day = eventDay(event, timezone);
    groups.set(day, [...(groups.get(day) ?? []), event]);
  }
  return (
    <main
      id="workspace-main"
      className="workspace-content discover-page discover-agenda-page"
    >
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
          <button
            className="discovery-icon-button"
            aria-label="Search events"
            onClick={() => setSearchOpen(true)}
          >
            <Search size={19} />
          </button>
          <details className="discover-filter-menu" ref={filterMenu}>
            <summary
              aria-label="Filter events"
              className={filterCount ? "selected" : ""}
            >
              <SlidersHorizontal size={17} />
              {filterCount > 0 && <span>{filterCount}</span>}
            </summary>
            <div className="discover-filters">
              <strong>Filter events</strong>
              <label>
                <Compass size={16} />
                <select
                  aria-label="Event format"
                  value={format}
                  onChange={(event) => setFormat(event.target.value)}
                >
                  <option value="all">Any format</option>
                  <option value="in-person">In person</option>
                  <option value="online">Online</option>
                </select>
              </label>
              <button
                aria-pressed={openOnly}
                onClick={() => setOpenOnly(!openOnly)}
                className={openOnly ? "selected" : ""}
              >
                Spots available
              </button>
              {filterCount > 0 && (
                <button onClick={reset}>Reset filters</button>
              )}
            </div>
          </details>
        </div>
      </div>
      <div className="discovery-layout">
        <aside className="discovery-sidebar" aria-label="Browse by date">
          <details
            className="discovery-calendar-details"
            open={calendarOpen}
            onToggle={(event) => setCalendarOpen(event.currentTarget.open)}
          >
            <summary>
              <CalendarDays size={17} />
              {selectedDay
                ? new Date(`${selectedDay}T12:00:00Z`).toLocaleDateString(
                    "en-US",
                    { month: "short", day: "numeric", timeZone: "UTC" },
                  )
                : "Choose a date"}
              <span>Calendar</span>
            </summary>
            <DiscoveryCalendar
              today={today}
              selected={selectedDay}
              events={rows.filter((event) =>
                period === "past" ? isPast(event, now) : !isPast(event, now),
              )}
              timezone={timezone}
              onSelect={(day) => {
                setSelectedDay(day);
              }}
            />
          </details>
          <EventPeriodTabs
            value={period}
            onChange={(value) => {
              setPeriod(value);
              setSelectedDay("");
              setOpenOnly(false);
            }}
          />
          <p className="discovery-timezone">
            Times in {utcOffset(new Date(now), timezone)}
            <span>{timezone.replaceAll("_", " ")}</span>
          </p>
        </aside>
        <div className="discovery-results">
          <div className="discovery-result-count" aria-live="polite">
            {loading && !rows.length
              ? "Loading events…"
              : `${visible.length}${cursor ? "+" : ""} ${visible.length === 1 ? "event" : "events"}`}
            {(selectedDay || filterCount > 0) && (
              <button onClick={reset}>
                Clear filters
                <X size={13} />
              </button>
            )}
          </div>
          {stale&&<p className="catalog-stale" role="status">Some event sources are incomplete. Open an event to check its current onchain state.</p>}
          {error ? (
            <LoadError
              message={error}
              retry={() => setAttempt((value) => value + 1)}
            />
          ) : loading && !rows.length ? (
            <div
              className="discovery-loading"
              aria-busy="true"
              aria-label="Loading events"
            >
              {[0, 1, 2].map((item) => (
                <div key={item} />
              ))}
            </div>
          ) : visible.length ? (
            <div className={`discovery-agenda discovery-agenda--${view}`}>
              {Array.from(groups.entries()).map(([day, events]) => (
                <section className="agenda-day" key={day}>
                  <h2>
                    <strong>
                      {day === today
                        ? "Today"
                        : dateLabel(events[0]!.times.checkinOpen, {
                            month: "long",
                            day: "numeric",
                            timeZone: timezone,
                          })}
                    </strong>
                    <span>
                      {dateLabel(events[0]!.times.checkinOpen, {
                        weekday: "long",
                        timeZone: timezone,
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
          ) : (
            <EmptyEvents
              title={
                selectedDay || filterCount
                  ? "No events match just yet."
                  : "Good plans start with someone."
              }
              description={
                selectedDay || filterCount
                  ? "Try another date or clear your filters."
                  : period === "past"
                    ? "Past events will appear here once they’ve finished."
                    : "New events will appear here. Check back to find your next plan."
              }
              href={
                selectedDay || filterCount
                  ? "/discover"
                  : "/events/new"
              }
              action={
                selectedDay || filterCount
                  ? "Browse all dates"
                  : "Create an event"
              }
              icon={<CalendarDays size={30} />}
              onAction={selectedDay || filterCount ? reset : undefined}
            />
          )}
          {cursor && (
            <div className="plans-pagination">
              <button
                className="button"
                disabled={loading}
                onClick={() => setAfter(cursor)}
              >
                {loading ? "Loading…" : "Load more events"}
              </button>
              <small>
                Calendar and filters include the events loaded so far.
              </small>
            </div>
          )}
        </div>
      </div>
      {searchOpen && (
        <DiscoverySearch
          events={rows}
          timezone={timezone}
          loading={loading}
          error={error}
          more={!!cursor}
          onLoadMore={() => cursor && setAfter(cursor)}
          onRetry={() => setAttempt((value) => value + 1)}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </main>
  );
}

function DiscoveryCalendar({
  today,
  selected,
  events,
  timezone,
  onSelect,
}: {
  today: string;
  selected: string;
  events: EventSummary[];
  timezone: string;
  onSelect: (day: string) => void;
}) {
  const [month, setMonth] = useState(
    () => new Date(`${today.slice(0, 7)}-01T12:00:00Z`),
  );
  useEffect(() => {
    setMonth(new Date(`${today.slice(0, 7)}-01T12:00:00Z`));
  }, [timezone]);
  const monthLabel = month.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const offset = (month.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(
    Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const cellCount = Math.ceil((offset + daysInMonth) / 7) * 7;
  const dots = new Set(events.map((event) => eventDay(event, timezone)));
  return (
    <div className="discovery-calendar">
      <div className="calendar-month">
        <h2>{monthLabel}</h2>
        <div>
          <button
            aria-label="Previous month"
            onClick={() =>
              setMonth(
                new Date(
                  Date.UTC(
                    month.getUTCFullYear(),
                    month.getUTCMonth() - 1,
                    1,
                    12,
                  ),
                ),
              )
            }
          >
            <ChevronLeft size={17} />
          </button>
          <button
            aria-label="Current month"
            onClick={() =>
              setMonth(new Date(`${today.slice(0, 7)}-01T12:00:00Z`))
            }
          >
            <span className="calendar-today-dot" />
          </button>
          <button
            aria-label="Next month"
            onClick={() =>
              setMonth(
                new Date(
                  Date.UTC(
                    month.getUTCFullYear(),
                    month.getUTCMonth() + 1,
                    1,
                    12,
                  ),
                ),
              )
            }
          >
            <ChevronRight size={17} />
          </button>
        </div>
      </div>
      <div className="calendar-weekdays" aria-hidden="true">
        {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => (
          <span key={index}>{day}</span>
        ))}
      </div>
      <div className="calendar-days">
        {Array.from({ length: cellCount }, (_, index) => {
          const date = new Date(
            Date.UTC(
              month.getUTCFullYear(),
              month.getUTCMonth(),
              index - offset + 1,
              12,
            ),
          );
          const key = date.toISOString().slice(0, 10);
          const active = key === selected;
          return (
            <button
              key={key}
              className={`${date.getUTCMonth() !== month.getUTCMonth() ? "outside-month " : ""}${key === today ? "is-today " : ""}${active ? "selected" : ""}`}
              aria-pressed={active}
              aria-current={key === today ? "date" : undefined}
              aria-label={`${date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}${dots.has(key) ? ", has events" : ""}`}
              onClick={() => onSelect(active ? "" : key)}
            >
              <span>{date.getUTCDate()}</span>
              {dots.has(key) && <i aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <div className="calendar-selected">
        <span>
          {selected
            ? new Date(`${selected}T12:00:00Z`).toLocaleDateString("en-US", {
                month: "long",
                day: "numeric",
                timeZone: "UTC",
              })
            : "All dates"}
        </span>
        {selected && (
          <button aria-label="Clear selected date" onClick={() => onSelect("")}>
            <X size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

function DiscoverySearch({
  events,
  timezone,
  loading,
  error,
  more,
  onLoadMore,
  onRetry,
  onClose,
}: {
  events: EventSummary[];
  timezone: string;
  loading: boolean;
  error: string;
  more: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const results = events
    .filter((event) => !!event.chainEventId && searchText(event).includes(needle))
    .sort((a, b) => Date.parse(a.times.checkinOpen) - Date.parse(b.times.checkinOpen));
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const focused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const overflow = document.body.style.overflow;
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
      focused?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="discovery-search-dialog"
      aria-label="Search events"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <button
        className="discovery-search-close"
        aria-label="Close search"
        onClick={onClose}
      >
        <X size={20} />
      </button>
      <div className="discovery-search-content">
        <label className="discovery-search-field">
          <Search size={24} />
          <input
            type="search"
            autoFocus
            aria-label="Search events, places or organizers"
            placeholder="Search events…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button aria-label="Clear search" onClick={() => setQuery("")}>
              <X size={18} />
            </button>
          )}
        </label>
        <div className="discovery-search-results">
          {error ? (
            <LoadError message={error} retry={onRetry} />
          ) : needle && results.length ? (
            <>
              <p className="discovery-search-count" aria-live="polite">
                {results.length} {results.length === 1 ? "result" : "results"}
                {more ? " in loaded events" : ""}
              </p>
              {results.map((event) => (
                <Link
                  key={event.id}
                  className="search-event"
                  href={`/events/${encodeURIComponent(event.chainEventId!)}${event.contractId?`?contract=${encodeURIComponent(event.contractId)}`:""}`}
                  onClick={onClose}
                >
                  <EventCover
                    small
                    title={eventTitle(event)}
                    cover={event.cover}
                  />
                  <div>
                    <div className="search-event-date">
                      {dateLabel(event.times.checkinOpen, {
                        month: "short",
                        day: "numeric",
                        timeZone: timezone,
                      })}{" "}
                      · {timeLabel(event.times.checkinOpen, timezone)}{" "}
                      <small>
                        {utcOffset(
                          new Date(event.times.checkinOpen),
                          timezone,
                        )}
                      </small>
                      {hasOpenSpots(event,Date.now()) && (
                        <span className="plan-live">Registration open</span>
                      )}
                    </div>
                    <h2>{eventTitle(event)}</h2>
                    <p>By {event.organizerAccount || "Organizer"}</p>
                    <p>
                      {event.venue || "Location to be announced"}
                    </p>
                    <span className="search-event-status">
                      {statusLabel(event)} · {amount(event.depositAtomic)} {event.assetSymbol??"USDC"} ·{" "}
                      {event.participantCount}{" "}
                      {event.participantCount === 1 ? "guest" : "guests"}
                    </span>
                  </div>
                </Link>
              ))}
            </>
          ) : (
            <div className="discovery-search-empty" role="status">
              <span className="search-empty-art" aria-hidden="true">
                <Search size={72} strokeWidth={1.2} />
              </span>
              <h2>
                {!needle
                  ? "Find your next plan."
                  : loading
                    ? "Looking for events…"
                    : "No results found."}
              </h2>
              <p>
                {!needle
                  ? "Search by event name, place or organizer."
                  : "Try searching for something else."}
              </p>
            </div>
          )}
          {more && (
            <div className="plans-pagination">
              <button
                className="button"
                disabled={loading}
                onClick={onLoadMore}
              >
                {loading ? "Loading…" : "Load more events"}
              </button>
              <small>Search includes the events loaded so far.</small>
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}
