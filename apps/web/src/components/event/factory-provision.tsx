"use client";
import { useEffect, useRef, useState } from "react";
import { MAINNET_POLICY } from "@/lib/mainnet-policy";
import { useWallet } from "@/components/wallet/wallet-context";
import { formatUnits } from "@/lib/money";
import { RPC_URL } from "@/lib/config";
import { prepareFactoryContext } from "@/lib/near/factory-context";
import { signAndSendTransaction, walletNetworkAvailable, walletRequestAvailable } from "@/lib/near/wallet";
import { prepareFactoryRecoveryContext } from "@/lib/near/factory-recovery-context";
import { inspectFactoryRecovery, type RecoveryView } from "@/lib/near/factory-recovery";
import { signParams } from "@/lib/near/actions";
import { REVIEWED_LEAF_SHA256, saveFactoryAttempt, type FactoryAttempt, type FactoryIdentity, type FactoryQuote } from "@/lib/near/factory";
import { ACCEPTED_MAINNET_RELEASE, type AcceptedMainnetRelease } from "@/lib/near/mainnet-actions";

const MAINNET_SIGNING_ENABLED = MAINNET_POLICY.acceptedFactory?.approval!==undefined;

export function FactoryProvision({ release = ACCEPTED_MAINNET_RELEASE, onReady }: { release?: AcceptedMainnetRelease | null; onReady?: (attempt: FactoryAttempt, identity: FactoryIdentity, resolutionHash: string | null) => void }) {
  const wallet = useWallet(); const account = wallet.account?.accountId; const currentAccount = useRef(account); currentAccount.current = account;
  const [nonce, setNonce] = useState(""); const [code, setCode] = useState<Uint8Array | null>(null);
  const [quote, setQuote] = useState<{ value: FactoryQuote; child: string; block: string } | null>(null);
  const [message, setMessage] = useState(""); const [pending, setPending] = useState(false); const [recovery, setRecovery] = useState<RecoveryView | null>(null);
  useEffect(()=>{let active=true;setCode(null);setQuote(null);setRecovery(null);setNonce("");if(!release||!account)return;
    try {const nonceKey=`showstake:factory-nonce:v1:${release.factory}:${account}`;let saved=localStorage.getItem(nonceKey);if(!saved){const prefix=`showstake:factory:v1:mainnet:${release.factory}:${account}:`;for(let i=0;i<localStorage.length;i++){if(localStorage.key(i)?.startsWith(prefix))throw Error("Previous factory action needs recovery before another request.");}const bytes=crypto.getRandomValues(new Uint8Array(6));let n=0;for(const byte of bytes)n=n*256+byte;saved=String(n);localStorage.setItem(nonceKey,saved);if(localStorage.getItem(nonceKey)!==saved)throw Error("Cannot persist factory request ID");}if(!/^(0|[1-9][0-9]*)$/.test(saved)||!Number.isSafeInteger(Number(saved)))throw Error("Saved factory request ID is invalid");setNonce(saved);
    }catch(error){setMessage(String(error));return;}
    void fetch("/contracts/showstake-event-escrow-03076c4a.wasm",{cache:"force-cache"}).then(async response=>{if(!response.ok)throw Error("Reviewed contract artifact is unavailable");const bytes=new Uint8Array(await response.arrayBuffer());if(active)setCode(bytes);}).catch(error=>{if(active)setMessage(String(error));});
    return()=>{active=false;};
  },[release,account]);
  function identity(): FactoryIdentity | null { return release && account ? { factory: release.factory, factoryCodeSha256: release.factoryCodeSha256, factoryCodeHash: release.factoryCodeHash, organizer: account, canonicalFt: release.canonicalFt, policy: release.policy, provider: release.provider, providerKind: release.providerKind } : null; }
  async function prepare() {
    const id = identity(), n = Number(nonce); setQuote(null);
    if (!id || !/^(0|[1-9][0-9]*)$/.test(nonce) || !Number.isSafeInteger(n)) { setMessage("A connected organizer, accepted factory and valid nonce are required."); return; }
    if(!code){setMessage("Select the reviewed contract Wasm to verify the factory quote.");return;}
    const epoch=wallet.getSessionEpoch();
    try { const context=await prepareFactoryContext(id,n,code,RPC_URL); if(currentAccount.current!==id.organizer||wallet.getSessionEpoch()!==epoch)return;setQuote({value:context.quote,child:context.child,block:context.blockHash});setMessage("Factory code, organizer and quote verified at one final block. Refresh before approving."); } catch(error) { if(currentAccount.current===id.organizer && wallet.getSessionEpoch()===epoch)setMessage(String(error)); }
  }
  async function submit() {
    const id = identity(), n = Number(nonce); if (!walletNetworkAvailable("mainnet") || !MAINNET_SIGNING_ENABLED || !id || !quote || !code || !account || pending || wallet.status !== "connected" || !wallet.proof) return;
    const epoch = wallet.getSessionEpoch(); setPending(true);
    try {
      const context = await prepareFactoryContext(id,n,code,RPC_URL); const action=context.action;
      if(context.child!==quote.child||context.quote.total!==quote.value.total||context.quote.child_funding!==quote.value.child_funding||context.quote.registry_fee!==quote.value.registry_fee||context.quote.attached_gas_tgas!==quote.value.attached_gas_tgas)throw Error("Factory quote changed. Review the new quote before continuing.");
      if (currentAccount.current !== account || wallet.getSessionEpoch() !== epoch) throw Error("Wallet account changed. Start again.");
      const attempt = { network: "mainnet" as const, factory: id.factory, organizer: id.organizer, nonce: n, child: quote.child, codeHash: REVIEWED_LEAF_SHA256, total: quote.value.total, hash: null };
      if(!walletRequestAvailable(signParams("mainnet",account,id.factory,[action]),context))throw Error("Action is outside the approved wallet scope");
      const key = saveFactoryAttempt(localStorage, attempt);
      const result = await signAndSendTransaction(signParams("mainnet", account, id.factory, [action]),context);
      if (result.ok) localStorage.setItem(key, JSON.stringify({ ...attempt, hash: result.value.transactionHash }));
      if (wallet.getSessionEpoch() !== epoch) return;
      if (!result.ok) { setMessage(`Outcome unresolved: ${result.detail}. Reconcile this nonce before any retry.`); return; }
      localStorage.setItem(key, JSON.stringify({ ...attempt, hash: result.value.transactionHash }));
      setMessage("Submission recorded. Registry, final receipt and child configuration must be reconciled before publishing.");
    } catch (error) { setMessage(String(error)); } finally { setPending(false); }
  }
  function readAttempt(id: FactoryIdentity, n: number): FactoryAttempt {
    const key = `showstake:factory:v1:mainnet:${id.factory}:${id.organizer}:${n}`;
    const raw = localStorage.getItem(key); if (!raw) throw Error("No saved attempt for this wallet and nonce.");
    return JSON.parse(raw) as FactoryAttempt;
  }
  async function recover() {
    const id = identity(), n = Number(nonce); setRecovery(null);
    if (!id || !/^(0|[1-9][0-9]*)$/.test(nonce) || !Number.isSafeInteger(n)) return;
    try {
      const attempt = readAttempt(id, n);
      const resolutionRaw = localStorage.getItem(`showstake:factory-recovery:v1:mainnet:${id.factory}:${id.organizer}:${n}:resolve_request`);
      const resolution = resolutionRaw ? JSON.parse(resolutionRaw) as { factory?: string; organizer?: string; nonce?: number; method?: string; hash?: string | null } : null;
      if (resolution && (resolution.factory !== id.factory || resolution.organizer !== id.organizer || resolution.nonce !== n || resolution.method !== "resolve_request")) throw Error("Saved recovery identity mismatch");
      let result = await inspectFactoryRecovery(attempt, id, RPC_URL);
      if (result.status !== "Ready" && resolution?.hash) result = await inspectFactoryRecovery(attempt, id, RPC_URL, fetch, resolution.hash);
      if (currentAccount.current !== id.organizer) return;
      setRecovery(result); if (result.status === "Ready") onReady?.(attempt, id, resolution?.hash ?? null); setMessage(`Request ${result.status}, observed at final block ${result.blockHeight}. No automatic retry.`);
    } catch (error) { if (currentAccount.current === id.organizer) setMessage(`Recovery unavailable: ${String(error)}. Do not retry while the outcome is unknown.`); }
  }
  function startAnother(){if(!release||!account||recovery?.status!=="Ready"||pending)return;try{const bytes=crypto.getRandomValues(new Uint8Array(6));let value=0;for(const byte of bytes)value=value*256+byte;const next=String(value),nonceKey=`showstake:factory-nonce:v1:${release.factory}:${account}`,attemptKey=`showstake:factory:v1:mainnet:${release.factory}:${account}:${next}`;if(localStorage.getItem(attemptKey))throw Error("Request ID collision. Try again.");localStorage.setItem(nonceKey,next);if(localStorage.getItem(nonceKey)!==next)throw Error("Cannot persist factory request ID");setNonce(next);setQuote(null);setRecovery(null);setMessage("New event request prepared. The previous contract remains available.");}catch(error){setMessage(String(error));}}
  async function recoverAction(method: "resolve_request" | "claim_failed_funding") {
    const id = identity(), n = Number(nonce);
    if (!walletNetworkAvailable("mainnet") || !MAINNET_SIGNING_ENABLED || !id || !wallet.proof || wallet.status !== "connected" || pending || !recovery) return;
    const epoch = wallet.getSessionEpoch(); setPending(true);
    try {
      const attempt = readAttempt(id, n); const context = await prepareFactoryRecoveryContext(attempt,id,method,RPC_URL);
      if (currentAccount.current !== id.organizer || wallet.getSessionEpoch() !== epoch) throw Error("Wallet account changed");
      const key = `showstake:factory-recovery:v1:mainnet:${id.factory}:${id.organizer}:${n}:${method}`;
      if (localStorage.getItem(key)) throw Error("Recovery attempt already recorded; reconcile it before retrying");
      const args = method === "resolve_request" ? { organizer: id.organizer, request_nonce: n } : { request_nonce: n };
      const walletParams=signParams("mainnet", id.organizer, id.factory, [{ type: "FunctionCall", params: { methodName: method, args, gas: "300000000000000", deposit: "0" } }]);
      if(!walletRequestAvailable(walletParams,undefined,undefined,context))throw Error("Action is outside the approved wallet scope");
      const value = JSON.stringify({ factory: id.factory, organizer: id.organizer, nonce: n, method, hash: null });
      localStorage.setItem(key, value); if (localStorage.getItem(key) !== value) throw Error("Could not persist recovery attempt");
      const result = await signAndSendTransaction(walletParams,undefined,undefined,context);
      if (result.ok) localStorage.setItem(key, JSON.stringify({ factory: id.factory, organizer: id.organizer, nonce: n, method, hash: result.value.transactionHash }));
      if (wallet.getSessionEpoch() !== epoch) return;
      if (!result.ok) { setMessage(`Recovery outcome unresolved: ${result.detail}. Do not resend.`); return; }
      localStorage.setItem(key, JSON.stringify({ factory: id.factory, organizer: id.organizer, nonce: n, method, hash: result.value.transactionHash }));
      setRecovery(null); setMessage("Recovery submitted. Reconcile its final receipt and request state before retrying.");
    } catch (error) { setMessage(String(error)); } finally { setPending(false); }
  }
  return <section className="lifecycle-card"><h2>Provision an event contract</h2><p>The organizer funds contract storage and gas. Participant deposits are not used for provisioning.</p>{!release && <p>Factory release is awaiting deployment and review. Provisioning is locked.</p>}<details><summary>Advanced request details</summary><p>Request ID: {nonce||"Unavailable"}</p><label>Reviewed contract Wasm override<input type="file" accept=".wasm" onChange={e => { const f = e.target.files?.[0]; setCode(null); setQuote(null); if (f) void f.arrayBuffer().then(b => setCode(new Uint8Array(b))); }} /></label></details><button className="button" disabled={!release || !account || !code || pending} onClick={() => void prepare()}>Check funding quote</button>{quote && <><p>Child: {quote.child}</p><p>Contract funding: {formatUnits(quote.value.child_funding,24,"NEAR")} · Registry: {formatUnits(quote.value.registry_fee,24,"NEAR")} · Total: {formatUnits(quote.value.total,24,"NEAR")}</p><p>Gas: {quote.value.attached_gas_tgas} Tgas; final block {quote.block}. Wallet fees are additional.</p><button className="button" disabled={!MAINNET_SIGNING_ENABLED || !release || !code || pending || wallet.status !== "connected" || !wallet.proof} onClick={() => void submit()}>Prepare wallet approval</button></>}<button className="button button--secondary" disabled={!release || !account || pending} onClick={() => void recover()}>Inspect saved request</button>{recovery?.status === "Ready" && <button className="button button--secondary" disabled={pending} onClick={startAnother}>Create another event contract</button>}{recovery?.status === "Pending" && recovery.resolveEligible && <button className="button button--secondary" disabled={!MAINNET_SIGNING_ENABLED || pending || !wallet.proof} onClick={() => void recoverAction("resolve_request")}>Resolve pending request</button>}{recovery?.status === "RefundClaimable" && <button className="button button--secondary" disabled={!MAINNET_SIGNING_ENABLED || pending || !wallet.proof} onClick={() => void recoverAction("claim_failed_funding")}>Claim failed funding</button>}{message && <p role="status">{message}</p>}</section>;
}
