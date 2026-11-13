import { MULTI_EVENT_RELEASE } from "@/lib/near/multi-event";
import { SharedEventRoute } from "@/components/event/shared-event-route";
import { NETWORK } from "@/lib/config";
import { MainnetParticipant } from "@/components/event/mainnet-participant";
import { EventDetailClient } from "@/components/event/event-detail";

export default async function EventDetailPage({
  params, searchParams,
}: {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<{ contract?: string; registration?:string; pass?:string }>;
}) {
  const { eventId } = await params;
  const { contract, registration, pass } = await searchParams;
  return MULTI_EVENT_RELEASE && contract === MULTI_EVENT_RELEASE.contract ? <SharedEventRoute eventId={eventId} mode="participant" initialRegistrationId={registration ?? ""} initialApiPassId={pass ?? ""} /> : NETWORK === "mainnet" ? <MainnetParticipant eventId={eventId} contractId={contract ?? ""} initialRegistrationId={registration ?? ""} initialApiPassId={pass ?? ""} /> : <EventDetailClient eventId={eventId} />;
}