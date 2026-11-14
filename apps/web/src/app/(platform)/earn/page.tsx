import Link from "next/link";
import {RheaMicrotest} from "@/components/event/rhea-microtest";
import {NETWORK} from "@/lib/config";
import {sharedReleaseForNetwork} from "@/lib/near/multi-event";
import {earnEventMode} from "@/lib/earn-event-mode";
export default function EarnPage(){
 const mode=earnEventMode(NETWORK,sharedReleaseForNetwork(NETWORK));
 return <><main id="workspace-main" className="workspace-content lifecycle-workspace"><h1>Event yield</h1><section className="lifecycle-card">
 {mode==='mainnet-pending'?<><h2>Mainnet upgrade pending</h2><p>The current mainnet release supports event creation. Event-level yield requires the shared contract upgrade and provider verification.</p></>:mode==='mainnet-shared'?<><h2>Manage yield within each event</h2><p>Organizers review and approve supply and redemption from their event tools. Contract state and final receipts determine the result.</p><p>Rhea provider verification remains pending; a configured release does not establish live performance or a return.</p></>:mode==='testnet-shared'?<><h2>Test event yield</h2><p>Organizers can use their event tools to supply and redeem with the testnet mock provider. Mainnet Rhea verification remains pending.</p></>:<><h2>Event yield unavailable</h2><p>A reviewed shared contract is not configured for this network.</p></>}
 <p><Link className="button button--secondary" href="/events">My events</Link> <Link className="button button--secondary" href="/funding">Funding</Link></p></section></main>
 {NETWORK==='mainnet'&&<details className="workspace-content"><summary>Legacy treasury check</summary><p>This separate check does not control event yield.</p><RheaMicrotest/></details>}</>;
}
