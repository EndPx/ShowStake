"use client";

import { useEffect, useState } from "react";
import { AlignLeft, CalendarDays, Globe2, MapPin, Ticket, Users } from "lucide-react";
import { NETWORK } from "@/lib/config";
import { parseUnits } from "@/lib/money";
import { eventRulesPreview, type EventDraft } from "@/lib/mainnet-event-preview";
import { useWallet } from "@/components/wallet/wallet-context";
import { EventCover } from "./event-cover";
import { MultiCreate } from "./multi-create";
import { FactoryEventCreate } from "./factory-event-create";
import { sharedReleaseForNetwork } from "@/lib/near/multi-event";
import { FACTORY_EVENT_RELEASE } from "@/lib/near/factory-event";

const initial: EventDraft = { event_id: "", title: "", location: "", rules_text: "", deposit: "", capacity: "5", reg_open: "", reg_close: "", checkin_open: "", checkin_close: "" };

export function MainnetCreatePreview() {
  const wallet = useWallet();
  const sharedYield = sharedReleaseForNetwork(NETWORK)?.policy === "showstake-native-usdc-shared-yield/2";
  const [fields, setFields] = useState<EventDraft>(initial);
  const [rules, setRules] = useState<Record<string, unknown> | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => { setFields(previous => previous.event_id ? previous : { ...previous, event_id: `event-${crypto.randomUUID().replaceAll("-", "")}` }); }, []);
  function change(key: keyof EventDraft, value: string) {
    setFields(previous => ({ ...previous, [key]: value }));
    setRules(null);
    setNotice("");
  }
  function prepare() {
    const deposit = parseUnits(fields.deposit, 6);
    const result = deposit === null ? null : eventRulesPreview({ ...fields, deposit });
    if (!result) { setRules(null); setNotice("Enter valid event details, a USDC deposit, capacity, and ordered times."); return; }
    setRules(result.args.rules);
    setNotice("Event rules are ready. Review the storage quote below before publishing.");
  }
  return <div className="commitpass-create create-workspace">
    <div className="create-grid">
      <aside className="create-cover-column">
        <EventCover title={fields.title} />
        <p className="cover-note">Sample cover · presentation only. Cover artwork is not saved with your event.</p>
      </aside>
      <div className="create-fields">
        <div className="create-context"><span><CalendarDays size={15} /> New event</span><span><Globe2 size={14} /> Public</span></div>
        <label className="sr-only" htmlFor="create-event-title">Event name</label>
        <input id="create-event-title" className="event-name-input" placeholder="Event name" value={fields.title} onChange={e => change("title", e.target.value)} />
        <div className="create-schedule">
          <div className="create-date-rows">
            {([ ["reg_open", "Registration opens"], ["reg_close", "Registration closes"], ["checkin_open", "Check-in opens"], ["checkin_close", "Check-in closes"] ] as const).map(([key, label]) => <label className="create-date-row" key={key}><span className="schedule-dot" aria-hidden="true" /><span>{label}</span><input type="datetime-local" value={fields[key]} onChange={e => change(key, e.target.value)} /></label>)}
          </div>
          <p className="schedule-note">Times use your device's local time. Registration close is also the cancellation cutoff. Finalization is due 24 hours after check-in closes.</p>
        </div>
        <label className="create-location editor-row-trigger"><MapPin size={18} /><span><strong>Location</strong><input placeholder="Offline location or virtual link" value={fields.location} onChange={e => change("location", e.target.value)} /></span></label>
        <label className="create-description editor-row-trigger"><AlignLeft size={18} /><span><strong>Event rules</strong><textarea placeholder="Describe the event and attendance rules" value={fields.rules_text} onChange={e => change("rules_text", e.target.value)} rows={3} /></span></label>
        <h2>Event options</h2>
        <div className="create-options">
          <label><Ticket size={18} /><span>Commitment <small>{NETWORK === "testnet" ? "Mock USDC" : "USDC"}</small></span><input type="text" inputMode="decimal" placeholder="0.00" value={fields.deposit} onChange={e => change("deposit", e.target.value)} /></label>
          <label><Users size={18} /><span>Capacity</span><input type="text" inputMode="numeric" value={fields.capacity} onChange={e => change("capacity", e.target.value)} /></label>
        </div>
        <details className="create-advanced"><summary>Advanced event ID</summary><label>Event ID<input value={fields.event_id} onChange={e => change("event_id", e.target.value)} /></label></details>
        {!FACTORY_EVENT_RELEASE && !sharedYield && <div className="create-release-notice"><strong>CREATE-only release</strong><p>You can create an event on the shared NEAR contract. USDC registration and Earn are unavailable in this release.</p></div>}
        <div className="create-actions">{!wallet.account ? <button type="button" className="button" onClick={() => void wallet.connect()}>Connect NEAR wallet</button> : <p>Organizer: {wallet.account.accountId}</p>}<button type="button" className="button button--secondary" onClick={prepare}>Review event rules</button></div>
        {wallet.error && <p className="create-feedback" role="alert">{wallet.error}</p>}
        {notice && <p className="create-feedback" role="status">{notice}</p>}
        {rules && <p className="create-feedback">Commitment: {fields.deposit} USDC · Capacity: {fields.capacity}</p>}
        {FACTORY_EVENT_RELEASE && !sharedYield ? <FactoryEventCreate release={FACTORY_EVENT_RELEASE} rules={rules} /> : <MultiCreate rules={rules} />}
      </div>
    </div>
  </div>;
}
