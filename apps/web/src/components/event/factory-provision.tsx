"use client";
import { useRef, useState } from "react";
import { MAINNET_POLICY } from "@/lib/mainnet-policy";
import { useWallet } from "@/components/wallet/wallet-context";
import { formatUnits } from "@/lib/money";
import { RPC_URL } from "@/lib/config";
import { finalBlockViews } from "@/lib/near/rpc";
import { signAndSendTransaction, walletNetworkAvailable, walletRequestAvailable } from "@/lib/near/wallet";
import { inspectFactoryRecovery, type RecoveryView } from "@/lib/near/factory-recovery";
import { signParams } from "@/lib/near/actions";
import { provisionAction, REVIEWED_LEAF_SHA256, saveFactoryAttempt, validateFactory, type FactoryAttempt, type FactoryConfig, type FactoryIdentity, type FactoryQuote } from "@/lib/near/factory";
import { ACCEPTED_MAINNET_RELEASE, type AcceptedMainnetRelease } from "@/lib/near/mainnet-actions";

const MAINNET_SIGNING_ENABLED = MAINNET_POLICY.acceptedFactory?.approval!==undefined;

export function FactoryProvision({ release = ACCEPTED_MAINNET_RELEASE, onReady }: { release?: AcceptedMainnetRelease | null; onReady?: (attempt: FactoryAttempt, identity: FactoryIdentity, resolutionHash: string | null) => void }) {
  const wallet = useWallet(); const account = wallet.account?.accountId; const currentAccount = useRef(account); currentAccount.current = account;
  const [nonce, setNonce] = useState(""); const [code, setCode] = useState<Uint8Array | null>(null);
  const [quote, setQuote] = useState<{ value: FactoryQuote; child: string; block: string } | null>(null);
  const [message, setMessage] = useState(""); const [pending, setPending] = useState(false); const [recovery, setRecovery] = useState<RecoveryView | null>(null);
  function identity(): FactoryIdentity | null { return release && account ? { factory: release.factory, factoryCodeSha256: release.factoryCodeSha256, factoryCodeHash: release.factoryCodeHash, organizer: account, canonicalFt: release.canonicalFt, policy: release.policy, provider: release.provider, providerKind: release.providerKind } : null; }
  async function prepare() {
    const id = identity(), n = Number(nonce); setQuote(null);
    if (!id || !/^(0|[1-9][0-9]*)$/.test(nonce) || !Number.isSafeInteger(n)) { setMessage("A connected organizer, accepted factory and valid nonce are required."); return; }
    const snapshot = await finalBlockViews(id.factory, ["get_config", { method: "quote_provision", args: { organizer: id.organizer } }, { method: "get_child_id", args: { organizer: id.organizer, request_nonce: n } }], RPC_URL);
    if (currentAccount.current !== id.organizer) return;
    if (!snapshot.ok) { setMessage("Factory views unavailable. No transaction prepared."); return; }
    const [config, q, child] = snapshot.value.views as [FactoryConfig, FactoryQuote, unknown];
    if (!config || !q || !validateFactory(config, q, id) || typeof child !== "string" || !child.endsWith(`.${id.factory}`)) { setMessage("Factory identity, quote or child failed verification."); return; }
    setQuote({ value: q, child, block: snapshot.blockHash }); setMessage("Quote observed at one final block; it may change before submission. Refresh before approving.");
  }
  async function submit() {
    const id = identity(), n = Number(nonce); if (!walletNetworkAvailable("mainnet") || !MAINNET_SIGNING_ENABLED || !id || !quote || !code || !account || pending || wallet.status !== "connected" || !wallet.proof) return;
    const epoch = wallet.getSessionEpoch(); setPending(true);
    try {
      const action = await provisionAction(code, n, quote.value);
      if (currentAccount.current !== account || wallet.getSessionEpoch() !== epoch) throw Error("Wallet account changed. Start again.");
      const attempt = { network: "mainnet" as const, factory: id.factory, organizer: id.organizer, nonce: n, child: quote.child, codeHash: REVIEWED_LEAF_SHA256, total: quote.value.total, hash: null };
      if(!walletRequestAvailable(signParams("mainnet",account,id.factory,[action])))throw Error("Action is outside the approved wallet scope");
      const key = saveFactoryAttempt(localStorage, attempt);
      const result = await signAndSendTransaction(signParams("mainnet", account, id.factory, [action]));
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
  async function recoverAction(method: "resolve_request" | "claim_failed_funding") {
    const id = identity(), n = Number(nonce);
    if (!walletNetworkAvailable("mainnet") || !MAINNET_SIGNING_ENABLED || !id || !wallet.proof || wallet.status !== "connected" || pending || !recovery) return;
    const epoch = wallet.getSessionEpoch(); setPending(true);
    try {
      const attempt = readAttempt(id, n); const fresh = await inspectFactoryRecovery(attempt, id, RPC_URL);
      if (currentAccount.current !== id.organizer || wallet.getSessionEpoch() !== epoch) throw Error("Wallet account changed");
      if (method === "resolve_request" ? (fresh.status !== "Pending" || !fresh.resolveEligible) : fresh.status !== "RefundClaimable") throw Error("Request state changed; refresh recovery");
      const key = `showstake:factory-recovery:v1:mainnet:${id.factory}:${id.organizer}:${n}:${method}`;
      if (localStorage.getItem(key)) throw Error("Recovery attempt already recorded; reconcile it before retrying");
      const args = method === "resolve_request" ? { organizer: id.organizer, request_nonce: n } : { request_nonce: n };
      const walletParams=signParams("mainnet", id.organizer, id.factory, [{ type: "FunctionCall", params: { methodName: method, args, gas: "300000000000000", deposit: "0" } }]);
      if(!walletRequestAvailable(walletParams))throw Error("Action is outside the approved wallet scope");
      const value = JSON.stringify({ factory: id.factory, organizer: id.organizer, nonce: n, method, hash: null });
      localStorage.setItem(key, value); if (localStorage.getItem(key) !== value) throw Error("Could not persist recovery attempt");
      const result = await signAndSendTransaction(walletParams);
      if (result.ok) localStorage.setItem(key, JSON.stringify({ factory: id.factory, organizer: id.organizer, nonce: n, method, hash: result.value.transactionHash }));
      if (wallet.getSessionEpoch() !== epoch) return;
      if (!result.ok) { setMessage(`Recovery outcome unresolved: ${result.detail}. Do not resend.`); return; }
      localStorage.setItem(key, JSON.stringify({ factory: id.factory, organizer: id.organizer, nonce: n, method, hash: result.value.transactionHash }));
      setRecovery(null); setMessage("Recovery submitted. Reconcile its final receipt and request state before retrying.");
    } catch (error) { setMessage(String(error)); } finally { setPending(false); }
  }
  return <section className="lifecycle-card"><h2>Provision an event contract</h2><p>The organizer funds contract storage and gas. Participant deposits are not used for provisioning.</p>{!release && <p>Factory release is awaiting deployment and review. Provisioning is locked.</p>}<label>Request nonce<input value={nonce} onChange={e => { setNonce(e.target.value); setQuote(null); setRecovery(null); }} inputMode="numeric" /></label><label>Reviewed contract Wasm<input type="file" accept=".wasm" onChange={e => { const f = e.target.files?.[0]; setCode(null); if (f) void f.arrayBuffer().then(b => setCode(new Uint8Array(b))); }} /></label><button className="button" disabled={!release || !account || pending} onClick={() => void prepare()}>Check funding quote</button>{quote && <><p>Child: {quote.child}</p><p>Contract funding: {formatUnits(quote.value.child_funding,24,"NEAR")} · Registry: {formatUnits(quote.value.registry_fee,24,"NEAR")} · Total: {formatUnits(quote.value.total,24,"NEAR")}</p><p>Gas: {quote.value.attached_gas_tgas} Tgas; final block {quote.block}. Wallet fees are additional.</p><button className="button" disabled={!MAINNET_SIGNING_ENABLED || !release || !code || pending || wallet.status !== "connected" || !wallet.proof} onClick={() => void submit()}>Prepare wallet approval</button></>}<button className="button button--secondary" disabled={!release || !account || pending} onClick={() => void recover()}>Inspect saved request</button>{recovery?.status === "Pending" && recovery.resolveEligible && <button className="button button--secondary" disabled={!MAINNET_SIGNING_ENABLED || pending || !wallet.proof} onClick={() => void recoverAction("resolve_request")}>Resolve pending request</button>}{recovery?.status === "RefundClaimable" && <button className="button button--secondary" disabled={!MAINNET_SIGNING_ENABLED || pending || !wallet.proof} onClick={() => void recoverAction("claim_failed_funding")}>Claim failed funding</button>}{message && <p role="status">{message}</p>}</section>;
}
