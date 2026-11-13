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
  return NETWORK === "mainnet" ? <MainnetParticipant eventId={eventId} contractId={contract ?? ""} initialRegistrationId={registration ?? ""} initialApiPassId={pass ?? ""} /> : <EventDetailClient eventId={eventId} />;
}