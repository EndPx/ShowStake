"use client";
import { useEffect, useState } from "react";
import { parseUnits } from "@/lib/money";
import { RPC_URL } from "@/lib/config";
import { eventRulesPreview } from "@/lib/mainnet-event-preview";
import { MainnetEventDesk } from "./mainnet-event-desk";
import { MANUAL_TARGET, resolveManualTarget } from "@/lib/near/manual-target";
import type { FactoryIdentity } from "@/lib/near/factory";
import { FactoryProvision } from "./factory-provision";
import { useWallet } from "@/components/wallet/wallet-context";

export function MainnetCreatePreview() {
  const wallet = useWallet();
  const [notice, setNotice] = useState("");
  const [fields, setFields] = useState({ event_id: "", title: "", location: "", rules_text: "", deposit: "", capacity: "20", reg_open: "", reg_close: "", checkin_open: "", checkin_close: "" });
  const [selection, setSelection] = useState<{ child: string; identity: FactoryIdentity; manual: boolean } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => { setFields(previous=>previous.event_id?previous:{...previous,event_id:`event-${crypto.randomUUID().replaceAll("-","")}`}); }, []);
  function change(key: keyof typeof fields, value: string) { setFields(previous => ({ ...previous, [key]: value })); setPreview(null); }
  function prepare() {
    const deposit = parseUnits(fields.deposit, 6);
    const result = deposit === null ? null : eventRulesPreview({ ...fields, deposit });
    if (!result) { setNotice("Enter valid event details, a USDC deposit, capacity, and ordered times."); return; }
    setNotice(""); setPreview(JSON.stringify(result, null, 2));
  }
  return <><section className="lifecycle-card"><h2>Create an event</h2><p>Any organizer can create an event with their connected NEAR wallet. A new contract is funded by its organizer.</p>{!wallet.account&&<button className="button" onClick={()=>void wallet.connect()}>Connect NEAR wallet</button>}{wallet.account&&<p>Organizer: {wallet.account.accountId}</p>}<button className="button button--secondary" onClick={()=>{setSelection(null);setFields(previous=>({...previous,capacity:"20"}));setPreview(null);}}>Create new event contract</button></section><FactoryProvision onReady={(attempt, identity) => setSelection({ child:attempt.child, identity, manual:false })} /><details className="lifecycle-card"><summary>Legacy allocated contract review</summary><p>This existing contract belongs to its original organizer and has a FullAccess key. It is a separate review path, not the general event-creation flow.</p><details><summary>Allocated contract access</summary><p>Organizer: {MANUAL_TARGET.organizer}</p><p>FullAccess key: {MANUAL_TARGET.publicKey}</p></details><button className="button button--secondary" onClick={() => void resolveManualTarget(null,RPC_URL).then(v => {setFields(previous=>({...previous,capacity:"1"}));setPreview(null);setSelection({child:v.contractId,manual:true,identity:{factory:"",factoryCodeSha256:"",factoryCodeHash:"",organizer:MANUAL_TARGET.organizer,canonicalFt:MANUAL_TARGET.canonicalFt,policy:MANUAL_TARGET.policy,provider:MANUAL_TARGET.provider,providerKind:"RHEA_MAINNET"}});setNotice("Legacy contract verified. This path remains closed until separately approved.");}).catch(e => setNotice(String(e)))}>Review allocated contract</button></details><section className="lifecycle-card"><h2>Prepare a mainnet event</h2><p>Review the event rules and storage quote. New contract creation is available after the factory and applicable safeguards are accepted.</p>
    {!wallet.account && <button className="button" onClick={() => void wallet.connect()}>Connect NEAR wallet</button>}
    {wallet.account && <p>Connected: {wallet.account.accountId}</p>}
    <div className="lifecycle-form-grid">{([ ["title", "Title"], ["location", "Location"], ["rules_text", "Rules"], ["deposit", "Deposit (USDC)"], ["capacity", "Capacity"], ["reg_open", "Registration opens"], ["reg_close", "Registration closes and cancellation cutoff"], ["checkin_open", "Check-in opens"], ["checkin_close", "Check-in closes"] ] as const).map(([key, label]) => <label key={key}>{label}<input value={fields[key]} type={key.includes("open") || key.includes("close") ? "datetime-local" : "text"} onChange={e => change(key, e.target.value)} /></label>)}</div>
    <details><summary>Advanced event ID</summary><label>Event ID<input value={fields.event_id} onChange={e=>change("event_id",e.target.value)} /></label></details><p>The finalization deadline is 24 hours after check-in closes. The registration close time is also the cancellation cutoff.</p><button className="button" onClick={prepare}>Preview event rules</button>{preview && <><p>Deposit: {fields.deposit} USDC / Capacity: {fields.capacity}</p><details><summary>Advanced proof details</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{preview}</pre></details></>}{notice && <p role="status">{notice}</p>}</section>{selection && <MainnetEventDesk selection={selection} rules={preview ? JSON.parse(preview).args.rules : null} />}</>;
}
