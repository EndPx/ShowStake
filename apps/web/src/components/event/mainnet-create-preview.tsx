"use client";
import { useEffect, useState } from "react";
import { parseUnits, formatUnits } from "@/lib/money";
import { RPC_URL } from "@/lib/config";
import { finalBlockViews } from "@/lib/near/rpc";
import { eventRulesPreview } from "@/lib/mainnet-event-preview";
import { MainnetEventDesk } from "./mainnet-event-desk";
import { MANUAL_TARGET, resolveManualTarget } from "@/lib/near/manual-target";
import type { FactoryIdentity } from "@/lib/near/factory";
import { FactoryProvision } from "./factory-provision";
import { useWallet } from "@/components/wallet/wallet-context";

// Read-only stage-one deployment, never an accepted event or transaction target.
const REVIEW_CONTRACT = "showstake-mainnet-escrow-endpx-2026.near";
type Config = { network: string; canonical_ft: string; policy_version: string; provider_kind: string };
type Control = { paused: boolean; principal_cap: string };
export function MainnetCreatePreview() {
  const wallet = useWallet();
  const [view, setView] = useState<{ config: Config; control: Control; event: unknown; hash: string; observedAt: string } | null>(null);
  const [notice, setNotice] = useState("Loading final mainnet views…");
  const [fields, setFields] = useState({ event_id: "", title: "", location: "", rules_text: "", deposit: "", capacity: "20", reg_open: "", reg_close: "", checkin_open: "", checkin_close: "" });
  const [selection, setSelection] = useState<{ child: string; identity: FactoryIdentity; manual: boolean } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => { setFields(previous=>previous.event_id?previous:{...previous,event_id:`event-${crypto.randomUUID().replaceAll("-","")}`}); }, []);
  useEffect(() => { let current = true; void (async () => {
    const snapshot = await finalBlockViews(REVIEW_CONTRACT, ["get_config", "get_rhea_control", "get_event"], RPC_URL);
    if (!current) return;
    if (!snapshot.ok) { setNotice("Mainnet contract views are unavailable. Refresh to retry."); return; }
    const [config, control, event] = snapshot.value.views as [Config, Control, unknown];
    if (!config || !control || typeof control.paused !== "boolean") { setNotice("Mainnet contract views are invalid."); return; }
    setView({ config, control, event, hash: snapshot.value.account.code_hash, observedAt: `${snapshot.observedAt}, block ${snapshot.blockHeight} (${snapshot.blockHash})` }); setNotice("");
  })(); return () => { current = false; }; }, []);
  function change(key: keyof typeof fields, value: string) { setFields(previous => ({ ...previous, [key]: value })); setPreview(null); }
  function prepare() {
    const deposit = parseUnits(fields.deposit, 6);
    const result = deposit === null ? null : eventRulesPreview({ ...fields, deposit });
    if (!result) { setNotice("Enter valid event details, a USDC deposit, capacity, and ordered times."); return; }
    setNotice(""); setPreview(JSON.stringify(result, null, 2));
  }
  return <><section className="lifecycle-card"><h2>Choose a contract</h2><p>The allocated contract already exists and is controlled by a disclosed FullAccess key. Creating a new contract requires a separate factory quote.</p><details><summary>Allocated contract access</summary><p>Organizer: {MANUAL_TARGET.organizer}</p><p>FullAccess key: {MANUAL_TARGET.publicKey}</p></details><button className="button button--secondary" onClick={() => void resolveManualTarget(null,RPC_URL).then(v => {setFields(previous=>({...previous,capacity:"1"}));setPreview(null);setSelection({child:v.contractId,manual:true,identity:{factory:"",factoryCodeSha256:"",factoryCodeHash:"",organizer:MANUAL_TARGET.organizer,canonicalFt:MANUAL_TARGET.canonicalFt,policy:MANUAL_TARGET.policy,provider:MANUAL_TARGET.provider,providerKind:"RHEA_MAINNET"}});setNotice("Allocated contract verified. No deployment is required; microtest approval remains closed.");}).catch(e => setNotice(String(e)))}>Use allocated event contract</button></section><FactoryProvision onReady={(attempt, identity) => setSelection({ child:attempt.child, identity, manual:false })} /><section className="lifecycle-card"><h2>Prepare a mainnet event</h2><p>Review the event rules before provisioning. Factory deployment, provider acceptance and public deposits are not available yet; this preview cannot send a transaction.</p>
    {!wallet.account && <button className="button" onClick={() => void wallet.connect()}>Connect NEAR wallet</button>}
    {wallet.account && <p>Connected: {wallet.account.accountId}</p>}
    {view && <><p>Read-only review contract: <code>{REVIEW_CONTRACT}</code></p><p>Network: {view.config.network} · Token: {view.config.canonical_ft} · Policy: {view.config.policy_version} · Provider: {view.config.provider_kind}</p><p>Paused: {String(view.control.paused)} · Principal cap: {formatUnits(String(view.control.principal_cap), 6, "USDC")} · Event: {view.event === null ? "none" : "present"}</p><details><summary>Advanced proof details</summary><p>Account code hash: <code>{view.hash}</code> · observed {view.observedAt}. All views are pinned to the same final block and do not authorize deposits.</p></details></>}
    <div className="lifecycle-form-grid">{([ ["title", "Title"], ["location", "Location"], ["rules_text", "Rules"], ["deposit", "Deposit (USDC)"], ["capacity", "Capacity"], ["reg_open", "Registration opens"], ["reg_close", "Registration closes and cancellation cutoff"], ["checkin_open", "Check-in opens"], ["checkin_close", "Check-in closes"] ] as const).map(([key, label]) => <label key={key}>{label}<input value={fields[key]} type={key.includes("open") || key.includes("close") ? "datetime-local" : "text"} onChange={e => change(key, e.target.value)} /></label>)}</div>
    <details><summary>Advanced event ID</summary><label>Event ID<input value={fields.event_id} onChange={e=>change("event_id",e.target.value)} /></label></details><p>The finalization deadline is 24 hours after check-in closes. The registration close time is also the cancellation cutoff.</p><button className="button" onClick={prepare}>Preview event rules</button>{preview && <><p>Deposit: {fields.deposit} USDC / Capacity: {fields.capacity}</p><details><summary>Advanced proof details</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{preview}</pre></details></>}{notice && <p role="status">{notice}</p>}</section>{selection && <MainnetEventDesk selection={selection} rules={preview ? JSON.parse(preview).args.rules : null} />}</>;
}
