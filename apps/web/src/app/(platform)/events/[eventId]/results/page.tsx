import { ResultsPanel } from "@/components/event/lifecycle-panels";
export default async function ResultsPage({ params }: { params: Promise<{ eventId: string }> }) { return <ResultsPanel eventId={(await params).eventId} />; }
