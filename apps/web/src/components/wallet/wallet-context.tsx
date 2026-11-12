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
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  connectWallet,
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
  const [status, setStatus] = useState<WalletStatus>("idle");
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [proof, setProof] = useState<SignedProof | null>(null);
  const [keyPermission, setKeyPermission] = useState<"FullAccess" | "FunctionCall" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const connect = useCallback(async () => {
    const gen = generation.current + 1;
    generation.current = gen;
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
    () => ({ network: NETWORK, status, account, proof, keyPermission, error, connect, disconnect, sign }),
    [status, account, proof, keyPermission, error, connect, disconnect, sign],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet must be used inside <WalletProvider>");
  return value;
}
