import { OrganizerPanel } from "@/components/event/lifecycle-panels";
export default async function OrganizerEventPage({ params }: { params: Promise<{ eventId: string }> }) { return <OrganizerPanel eventId={(await params).eventId} />; }
