// Adapted from CommitPass `components/events/event-list.tsx` (baseline
// 542273df306a7e5887f1dfcabf1383e78930f579). Personal plans list, but WITHOUT
// the Privy/account-context auth runtime: there is no session yet, so the page
// honestly shows an unavailable sign-in state rather than inventing a user.
"use client";

import { UserRound } from "lucide-react";
import { EmptyEvents } from "./event-list-states";
import { EventPeriodTabs } from "./event-period-tabs";
import { useState } from "react";

export function EventList() {
  const [tab, setTab] = useState("upcoming");
  return (
    <main id="workspace-main" className="workspace-content events-page">
      <div className="plans-heading">
        <h1>Events</h1>
        <EventPeriodTabs value={tab} onChange={setTab} />
      </div>
      <div className="plans-controls">
        <span>Hosted and reserved events</span>
      </div>
      <EmptyEvents
        title={tab === "past" ? "The memories go here." : "Sign in to see your events."}
        description={
          tab === "past"
            ? "Your finished events will appear here."
            : "Connect your wallet and sign in to view your events."
        }
        href="/discover"
        action="Discover events"
        icon={<UserRound size={30} strokeWidth={1.4} />}
      />
    </main>
  );
}