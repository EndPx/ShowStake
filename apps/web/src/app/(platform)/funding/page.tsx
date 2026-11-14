import {redirect} from 'next/navigation';
import {NETWORK} from '@/lib/config';
import {sharedReleaseForNetwork} from '@/lib/near/multi-event';
export default async function FundingPage({searchParams}:{searchParams:Promise<{event?:string;contract?:string}>}){const q=await searchParams,r=sharedReleaseForNetwork(NETWORK);if(q.event&&/^[A-Za-z0-9._-]{1,128}$/.test(q.event)&&r&&q.contract===r.contract)redirect(`/events/${encodeURIComponent(q.event)}?contract=${encodeURIComponent(r.contract)}&payment=1`);redirect('/events?payment=1');}