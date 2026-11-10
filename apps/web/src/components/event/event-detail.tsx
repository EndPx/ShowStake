"use client";

// Event detail route (public, no pass/session). Reads the accepted v6 contract's
// read-only views (get_config / get_event / get_settlement) plus the canonical
// FT metadata, and optionally the `/v1/events/{id}` projection for title/venue.
// Every fact is either shown from the chain or marked "Unavailable" — nothing is
// invented. Freshness (observedAt + block height) is surfaced.

import { useEffect, useState } from "react";
import { ArrowLeft, CalendarDays, CheckCircle2, Ticket } from "lucide-react";
import type { EventDetail, EventSummary, SettlementSummary } from "@/lib/types";
import {
  CANONICAL_FT,
  RPC_URL,
  acceptedEvent,
  isAcceptedEvent,
  isApiConfigured,
  apiBaseUrl,
} from "@/lib/config";
import { clockLabel } from "@/lib/display-time";
import { eventDisplayTimezone } from "@/lib/timezone";
import {
  ftMetadata,
  getConfig,
  getEvent,
  getSettlement,
  mapContractEventState,
} from "@/lib/near/views";
import { fetchEventDetail } from "@/lib/api";
import { Amount } from "@/components/ui/amount";
import { StatusBadge } from "@/components/ui/status-badge";
import { RegisterPanel } from "./register-panel";

type Status = "loading" | "error" | "not_configured" | "ready";

interface DetailState {
  summary: EventSummary & EventDetail;
  assetSymbol?: string;
  assetDecimals?: number;
  settlement?: SettlementSummary;
  observedAt: string | null;
  blockHeight: number | null;
}

function parseIso(value: string): number | null {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function timeCell(iso: string, timezone: string, label: string) {
  const t = parseIso(iso);
  return (
    <div className="detail-facts-item">
      <span className="detail-fact-icon">{<CalendarDays size={18} />}</span>
      <div>
        <small>{label}</small>
        <strong>{t !== null ? clockLabel(new Date(t), timezone) : "Time unavailable"}</strong>
      </div>
    </div>
  );
}

export function EventDetailClient({ eventId }: { eventId: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [state, setState] = useState<DetailState | null>(null);
  const accepted = isAcceptedEvent(eventId) ? acceptedEvent(eventId) : null;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      if (!accepted) {
        setStatus("not_configured");
        return;
      }
      setStatus("loading");
      const timezone = eventDisplayTimezone({});

      const [config, event, settlement, metadata] = await Promise.all([
        getConfig(accepted.contractId, RPC_URL),
        getEvent(accepted.contractId, eventId, RPC_URL),
        getSettlement(accepted.contractId, eventId, RPC_URL),
        ftMetadata(accepted.canonicalFt ?? CANONICAL_FT, RPC_URL),
      ]);
      if (controller.signal.aborted) return;
      if (!event.ok) {
        setError(event.code === "UNKNOWN_EVENT" ? "This event does not exist on the contract." : event.message);
        setStatus("error");
        return;
      }
      const view = event.value;
      const assetSymbol = metadata.ok ? metadata.value.symbol : undefined;
      const assetDecimals = metadata.ok ? metadata.value.decimals : undefined;
      // Normalize the contract's CamelCase state at this single boundary; an
      // unknown state fails closed (no render) rather than showing "Unavailable"
      // or inventing a phase.
      const eventState = mapContractEventState(view.state);
      if (eventState === null) {
        setError(`The contract returned an unknown event state: ${String(view.state)}.`);
        setStatus("error");
        return;
      }

      let overrides: Partial<EventSummary> = {};
      if (isApiConfigured()) {
        try {
          const api = await fetchEventDetail(apiBaseUrl(), eventId);
          if (api.data) overrides = {
            title: api.data.title,
            description: api.data.description,
            venue: api.data.venue,
            venueTimezone: api.data.venueTimezone,
            assetSymbol: api.data.assetSymbol ?? assetSymbol,
            assetDecimals: api.data.assetDecimals ?? assetDecimals,
          };
        } catch {
          // API offline/unreachable is fine: presentation fields stay unavailable.
        }
      }

      const summary: EventSummary & EventDetail = {
        id: view.event_id,
        network: "testnet",
        contractId: accepted.contractId,
        state: eventState,
        depositAtomic: view.deposit,
        capacity: view.capacity,
        times: {
          regOpen: msIso(view.reg_open),
          regClose: msIso(view.reg_close),
          cancelCutoff: msIso(view.cancel_cutoff),
          checkinOpen: msIso(view.checkin_open),
          checkinClose: msIso(view.checkin_close),
        },
        organizer: config.ok ? config.value.organizer : undefined,
        canonicalFt: config.ok ? config.value.canonical_ft : CANONICAL_FT,
        policyVersion: config.ok ? config.value.policy_version : undefined,
        rulesHash: view.rules_hash,
        finalizeDeadline: msIso(view.finalize_deadline),
        acceptedPrincipal: view.accepted_principal,
        participantCount: view.active_registrations,
        ...overrides,
      };

      let settlementSummary: SettlementSummary | undefined;
      if (settlement.ok) {
        settlementSummary = {
          attendeeCount: settlement.value.attendee_count,
          noShowCount: settlement.value.no_show_count,
          registrations: settlement.value.registrations,
          pool: settlement.value.pool,
          baseShare: settlement.value.base_share,
          remainder: settlement.value.remainder,
          claimsEnabled: settlement.value.claims_enabled,
          complete: settlement.value.complete,
        };
      }

      setState({
        summary,
        assetSymbol: summary.assetSymbol ?? assetSymbol,
        assetDecimals: summary.assetDecimals ?? assetDecimals,
        settlement: settlementSummary,
        observedAt: event.observedAt,
        blockHeight: event.blockHeight,
      });
      setStatus("ready");
    })();
    return () => controller.abort();
  }, [eventId, accepted]);

  if (status === "loading") {
    return (
      <main className="workspace-content detail-workspace">
        <div className="detail-skeleton" aria-busy="true" aria-label="Loading event" />
      </main>
    );
  }
  if (status === "not_configured") {
    return (
      <main className="workspace-content detail-workspace">
        <div className="workspace-error" role="alert">
          <h2>Event not configured.</h2>
          <p>
            “{eventId}” is not an accepted ShowStake event in this environment.
            Future events must be added as explicit reviewed deployments before
            they can be shown (see apps/web/src/lib/config.ts).
          </p>
          <a className="button" href="/discover">Back to discover</a>
        </div>
      </main>
    );
  }
  if (status === "error" || !state) {
    return (
      <main className="workspace-content detail-workspace">
        <div className="workspace-error" role="alert">
          <h2>Couldn’t load this event.</h2>
          <p>{error || "The contract view could not be read."}</p>
          <a className="button" href="/discover">Back to discover</a>
        </div>
      </main>
    );
  }

  const { summary, assetSymbol, assetDecimals, settlement } = state;
  const timezone = eventDisplayTimezone(summary);
  const title = summary.title?.trim() || summary.id;
  const venue = summary.venue?.trim() || "Location unavailable";
  const ended = ["SETTLED", "CANCELLED", "REFUND_ONLY"].includes(summary.state);

  return (
    <main className="workspace-content detail-workspace">
      <a className="back-link" href="/discover">
        <ArrowLeft size={15} /> Discover
      </a>
      <div className="detail-grid">
        <aside className="detail-aside">
          <RegisterPanel
            eventId={summary.id}
            contractId={summary.contractId ?? accepted!.contractId}
            ftContractId={summary.canonicalFt ?? CANONICAL_FT}
            policyVersion={summary.policyVersion ?? accepted!.policyVersion}
            state={summary.state}
            depositAtomic={summary.depositAtomic}
            capacity={summary.capacity}
            times={summary.times}
            assetSymbol={assetSymbol}
            assetDecimals={assetDecimals}
            registeredCount={summary.participantCount}
            acceptedPrincipal={summary.acceptedPrincipal}
            claimsEnabled={settlement?.claimsEnabled}
          />
        </aside>

        <div className="detail-main">
          <div className="event-chips">
            <span>NEAR testnet</span>
            <span>synthetic token ({summary.canonicalFt ?? CANONICAL_FT})</span>
            {summary.policyVersion && <span>{summary.policyVersion}</span>}
          </div>
          <h1>{title}</h1>
          <div className="detail-status">
            <StatusBadge state={summary.state} />
          </div>

          <div className="detail-facts">
            <div>
              <span className="detail-fact-icon"><Ticket size={18} /></span>
              <div>
                <small>Commitment deposit</small>
                <strong>
                  <Amount value={summary.depositAtomic} decimals={assetDecimals} symbol={assetSymbol} />
                </strong>
              </div>
            </div>
            <div>
              <span className="detail-fact-icon"><Ticket size={18} /></span>
              <div>
                <small>Capacity</small>
                <strong>{summary.capacity} · {summary.participantCount ?? "?"} reserved</strong>
              </div>
            </div>
            <div className="detail-facts-item">
              <span className="detail-fact-icon"><Ticket size={18} /></span>
              <div>
                <small>Organizer</small>
                <strong>{summary.organizer ?? "Unavailable"}</strong>
              </div>
            </div>
            {timeCell(summary.times.regOpen, timezone, "Registration opens")}
            {timeCell(summary.times.regClose, timezone, "Registration closes")}
            {timeCell(summary.times.checkinOpen, timezone, "Check-in opens")}
            {timeCell(summary.times.checkinClose, timezone, "Check-in closes")}
          </div>

          <div className="event-description">
            <h2>About this event</h2>
            <p>
              {summary.description?.trim() ||
                "The organizer’s description is not available in this slice (the /v1 API projection is not configured). Location: " + venue + "."}
            </p>
          </div>

          {ended && settlement && (
            <section className="settle-outcomes">
              <h2>Settlement outcomes</h2>
              <ul>
                <li>{settlement.registrations} registration{settlement.registrations === 1 ? "" : "s"}</li>
                <li>{settlement.attendeeCount} attended</li>
                <li>{settlement.noShowCount} no-show</li>
                <li>
                  pool <Amount value={settlement.pool} decimals={assetDecimals} symbol={assetSymbol} /> ·
                  share <Amount value={settlement.baseShare} decimals={assetDecimals} symbol={assetSymbol} /> ·
                  remainder <Amount value={settlement.remainder} decimals={assetDecimals} symbol={assetSymbol} />
                </li>
                <li className={settlement.claimsEnabled ? "ok-line" : undefined}>
                  <CheckCircle2 size={15} />
                  Claims {settlement.claimsEnabled ? "are enabled" : "are not enabled yet"} (claims UI is a later slice; no one-click claims).
                </li>
              </ul>
              {summary.acceptedPrincipal && (
                <p className="settle-note">
                  Accepted principal (on-chain):{" "}
                  <Amount value={summary.acceptedPrincipal} decimals={assetDecimals} symbol={assetSymbol} />.
                  No-shows are redistributed to attendees; attendance finality is contract-authorized only.
                </p>
              )}
            </section>
          )}

          <p className="freshness-note">
            Read from {accepted!.contractId} at block {state.blockHeight ?? "?"} ({state.observedAt ?? "time unavailable"}).
            {ended ? " This event is finished; registration is closed." : ""}
          </p>
        </div>
      </div>
    </main>
  );
}

function msIso(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}
