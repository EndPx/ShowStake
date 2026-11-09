import { ContentPanel } from "@/components/event/lifecycle-panels";
export default async function ContentPage({ params }: { params: Promise<{ eventId: string }> }) { return <ContentPanel eventId={(await params).eventId} />; }
