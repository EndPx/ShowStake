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
  disconnectWallet,
  readKeyPresence,
  signProof,
  type SignedProof,
  type WalletAccount,
} from "@/lib/near/wallet";
import { NETWORK } from "@/lib/config";

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
  proof: SignedProof | null;
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
  const [proof, setProof] = useState<SignedProof | null>(null);
  const [keyPermission, setKeyPermission] = useState<"FullAccess" | "FunctionCall" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0); const statusRef = useRef(status); statusRef.current=status; const accountRef=useRef(account); accountRef.current=account;
  useEffect(() => {
    const invalidate=() => { if(statusRef.current === "connecting") return; generation.current++; const epoch=generation.current; setSessionEpoch(epoch); setProof(null); setKeyPermission(null); void readConnectedWalletAccount().then(id => { if(generation.current!==epoch)return; if(!id||id!==accountRef.current?.accountId) {setAccount(null);setStatus("idle");} }); };
    const unsubscribe=subscribeWalletChanges(invalidate);
    const focus=()=>{if(document.visibilityState === "visible") invalidate();};
    window.addEventListener("focus",focus);document.addEventListener("visibilitychange",focus);
    return()=>{unsubscribe();window.removeEventListener("focus",focus);document.removeEventListener("visibilitychange",focus);};
  }, []);

  const getSessionEpoch = useCallback(() => generation.current, []);

  const connect = useCallback(async () => {
    const gen = generation.current + 1;
    generation.current = gen;
    setSessionEpoch(gen);
    setStatus("connecting");
    setError(null);
    setProof(null);
    setKeyPermission(null);
    const result = await connectWallet();
    if (generation.current !== gen) return; // stale: a newer boundary superseded this
    if (!result.ok) {
      setStatus("error");
      setError(result.detail);
      return;
    }
    setAccount(result.value);
    setStatus("connected");
    if (result.value.publicKey) {
      const presence = await readKeyPresence(result.value.accountId, result.value.publicKey);
      if (generation.current !== gen) return;
      if (presence.ok) setKeyPermission(presence.value.permission);
    }
  }, []);

  const disconnect = useCallback(async () => {
    generation.current += 1;
    setSessionEpoch(generation.current);
    setStatus("idle");
    setAccount(null);
    setProof(null);
    setKeyPermission(null);
    setError(null);
    await fetch("/api/v1/auth/logout", { method: "POST" }).catch(() => undefined);
    await disconnectWallet();
  }, []);

  const sign = useCallback(async () => {
    const current = account;
    if (!current) {
      setStatus("error");
      setError("Connect a wallet first.");
      return;
    }
    const gen = generation.current;
    setStatus("signing");
    setError(null);
    setProof(null);
    const result = await signProof(current.accountId);
    if (generation.current !== gen) {
      if (result.ok) await fetch("/api/v1/auth/logout", { method: "POST" }).catch(() => undefined);
      return;
    }
    if (!result.ok) {
      setStatus("error");
      setError(result.detail);
      return;
    }
    setProof(result.value);
    setStatus("connected");
  }, [account]);

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
