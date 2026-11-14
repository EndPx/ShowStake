"use client";

// Shared native-NEAR wallet session state for the platform shell and the event
// detail/register panel. Connect / sign / key-read are delegated to
// lib/near/wallet.ts (NEAR Connect, off-chain NEP-413 signature + user-approved
// transactions). A MONOTONIC generation invalidates every in-flight async
// result on disconnect or account change, so a late connect/sign/key-read
// completion can never overwrite a newer session (the accepted harness has this
// exact pattern; we reuse it, not weaken it).

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  connectWallet,
  subscribeWalletChanges,
  readConnectedWalletAccount,
  restoreWalletAccount,
  disconnectWallet,
  readKeyPresence,
  signProof,
  type SignedProof,
  type WalletAccount,
} from "@/lib/near/wallet";
import { checkWalletFocus } from "@/lib/near/wallet-focus";
import { invalidateWalletBoundary } from "@/lib/near/wallet-boundary";
import { NETWORK } from "@/lib/config";
import {oneWalletRequest,restoredWalletSession,type RestoredWalletSession} from "@/lib/wallet-login";

export type WalletStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "signing"
  | "error";

interface WalletContextValue {
  network: typeof NETWORK;
  sessionEpoch: number;
  getSessionEpoch: () => number;
  status: WalletStatus;
  account: WalletAccount | null;
  proof: SignedProof | RestoredWalletSession | null;
  keyPermission: "FullAccess" | "FunctionCall" | null;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  sign: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [status, setStatus] = useState<WalletStatus>("idle");
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [proof, setProof] = useState<SignedProof | RestoredWalletSession | null>(null);
  const [keyPermission, setKeyPermission] = useState<"FullAccess" | "FunctionCall" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0); const statusRef = useRef(status); statusRef.current=status; const accountRef=useRef(account); accountRef.current=account;
  const connectFlight=useRef<Promise<void>|null>(null),loginFlight=useRef<Promise<void>|null>(null),loginIdentity=useRef('');
  useEffect(() => {
    const invalidate=() => { if(statusRef.current === "connecting") return; generation.current++; const epoch=generation.current; setSessionEpoch(epoch); setProof(null); setKeyPermission(null); void readConnectedWalletAccount().then(id => { if(generation.current!==epoch)return; if(!id||id!==accountRef.current?.accountId) {setAccount(null);setStatus("idle");} }); };
    const unsubscribe=subscribeWalletChanges(invalidate);
    let focusGeneration=0;
    const focus=()=>{if(document.visibilityState !== "visible" || statusRef.current === "connecting")return;const seq=++focusGeneration,epoch=generation.current,expected=accountRef.current?.accountId??null;void checkWalletFocus(readConnectedWalletAccount,expected,()=>seq===focusGeneration&&generation.current===epoch&&(accountRef.current?.accountId??null)===expected,()=>{invalidateWalletBoundary();invalidate();});};
    window.addEventListener("focus",focus);document.addEventListener("visibilitychange",focus);
    return()=>{focusGeneration++;unsubscribe();window.removeEventListener("focus",focus);document.removeEventListener("visibilitychange",focus);};
  }, []);

  const getSessionEpoch = useCallback(() => generation.current, []);

  const authenticate=useCallback(async(current:WalletAccount,gen:number,force=false):Promise<void>=>{
    const identity=`${gen}:${current.accountId}`;
    if(loginFlight.current){if(loginIdentity.current===identity)return loginFlight.current;await loginFlight.current.catch(()=>{});}
    if(generation.current!==gen||accountRef.current?.accountId!==current.accountId)return;
    loginIdentity.current=identity;
    return oneWalletRequest(loginFlight,async()=>{
      statusRef.current='signing';setStatus('signing');setError(null);
      const active=()=>generation.current===gen&&accountRef.current?.accountId===current.accountId;
      try{
        if(!force){const response=await fetch('/api/v1/me',{cache:'no-store'});if(!active())return;if(response.ok){const restored=restoredWalletSession(await response.json(),current.accountId,NETWORK);if(restored&&active()){setProof(restored);statusRef.current='connected';setStatus('connected');return;}}}
        if(!active())return;
        const result=await signProof(current.accountId);
        if(!active()){if(result.ok)await fetch('/api/v1/auth/logout',{method:'POST'}).catch(()=>undefined);return;}
        if(!result.ok){setProof(null);statusRef.current='error';setStatus('error');setError(result.detail);return;}
        let session:RestoredWalletSession|null=null;try{const r=await fetch('/api/v1/me',{cache:'no-store'});if(r.ok)session=restoredWalletSession(await r.json(),current.accountId,NETWORK);}catch{}
        if(!active())return;setProof(session??result.value);statusRef.current='connected';setStatus('connected');
      }catch(value){if(active()){setProof(null);statusRef.current='error';setStatus('error');setError(value instanceof Error?value.message:'Sign-in could not be completed. Try again.');}}
    });
  },[]);

  useEffect(()=>{if(!proof||!account)return;let active=true;const gen=generation.current;const check=async()=>{if(document.visibilityState!=='visible')return;try{const r=await fetch('/api/v1/me',{cache:'no-store'}),body=await r.json();if(!active||generation.current!==gen||accountRef.current?.accountId!==account.accountId)return;if(r.status===401){setProof(null);statusRef.current='connected';setStatus('connected');return;}const session=r.ok?restoredWalletSession(body,account.accountId,NETWORK):null;if(session)setProof(session);}catch{}};const timer=setInterval(()=>void check(),60000);return()=>{active=false;clearInterval(timer);};},[proof?.accountId,account?.accountId]);

  useEffect(()=>{let active=true;const gen=generation.current;void(async()=>{const restored=await restoreWalletAccount();if(!active||generation.current!==gen||!restored)return;accountRef.current=restored;setAccount(restored);statusRef.current='connected';setStatus('connected');try{const r=await fetch('/api/v1/me',{cache:'no-store'}),body=await r.json();if(!active||generation.current!==gen||accountRef.current?.accountId!==restored.accountId)return;const session=r.ok?restoredWalletSession(body,restored.accountId,NETWORK):null;if(session)setProof(session);}catch{/* A user can finish sign-in explicitly; restoration never opens a prompt. */}})();return()=>{active=false;};},[]);

  const connect = useCallback(() => oneWalletRequest(connectFlight,async () => {
    if(statusRef.current==='signing'&&loginFlight.current)return loginFlight.current;
    const gen = generation.current + 1;
    generation.current = gen;
    setSessionEpoch(gen);
    statusRef.current='connecting';setStatus("connecting");
    setError(null);
    setProof(null);
    setKeyPermission(null);
    const result = await connectWallet();
    if (generation.current !== gen) return; // stale: a newer boundary superseded this
    if (!result.ok) {
      statusRef.current='error';
      setStatus("error");
      setError(result.detail);
      return;
    }
    accountRef.current=result.value;setAccount(result.value);
    statusRef.current='connected';setStatus("connected");
    if (result.value.publicKey) {
      void readKeyPresence(result.value.accountId,result.value.publicKey).then(presence=>{if(generation.current===gen&&presence.ok)setKeyPermission(presence.value.permission);}).catch(()=>{});
    }
    await authenticate(result.value,gen);
  }), [authenticate]);

  const disconnect = useCallback(async () => {
    generation.current += 1;
    setSessionEpoch(generation.current);
    statusRef.current='idle';accountRef.current=null;setStatus("idle");
    setAccount(null);
    setProof(null);
    setKeyPermission(null);
    setError(null);
    await fetch("/api/v1/auth/logout", { method: "POST" }).catch(() => undefined);
    await disconnectWallet();
  }, []);

  const sign = useCallback(async () => {
    const current = accountRef.current;
    if (!current) {
      setStatus("error");
      setError("Connect a wallet first.");
      return;
    }
    await authenticate(current,generation.current,true);
  }, [authenticate]);

  const value = useMemo<WalletContextValue>(
    () => ({ network: NETWORK, sessionEpoch, getSessionEpoch, status, account, proof, keyPermission, error, connect, disconnect, sign }),
    [sessionEpoch, getSessionEpoch, status, account, proof, keyPermission, error, connect, disconnect, sign],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet must be used inside <WalletProvider>");
  return value;
}
