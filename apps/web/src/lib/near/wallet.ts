// Native NEAR wallet (NEAR Connect / HOT, `@hot-labs/near-connect@0.12.0`).
//
// Reuses the accepted connector exactly as the T02 onboarding probe does:
//   * `NearConnector({ network: "testnet", features: { testnet: NETWORK === "testnet" } })` —
//     testnet wallet picker (the shared manifest is testnet-capable only for
//     wallets that declare it; HOT's testnet capability is ABSENT/UNPROVEN in
//     the manifest — a known, documented decision, not an inferred incapability).
//   * `wallet.signMessage` — an OFF-CHAIN NEP-413 proof (never a deposit/tx).
//   * `wallet.signAndSendTransaction` — the ONLY way a transaction is proposed,
//     and only after an explicit user click; each approval is a separate wallet
//     prompt. This module never signs/broadcasts on its own, never reimplements
//     crypto, and never retries an unknown submission automatically.

import { MAINNET_POLICY, mainnetRequestAllowed } from "../mainnet-policy";
import { NETWORK, RPC_URL } from "../config";
import { viewAccessKeyView } from "./rpc";
import { APP_DOMAIN, canonicalProofMessage } from "./proof";
import type { SignAndSendParams } from "./actions";

export interface WalletAccount {
  accountId: string;
  publicKey?: string;
}

export interface SignedProof {
  accountId: string;
  publicKey: string;
  signature: string;
  message: string;
  recipient: string;
  nonceHex: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export interface TxResult {
  transactionHash: string | null;
  status: string | null;
}

export type WalletResult<T = WalletAccount> =
  | { ok: true; code: string; value: T }
  | { ok: false; code: string; detail: string };

// The connector is created lazily so the CJS SDK is never evaluated during SSR
// or static page generation (only inside a browser event handler/effect).
type ConnectorShape = {
  on: (event: string, callback: () => void) => void;
  connect: () => Promise<unknown>;
  disconnect: () => Promise<void>;
  wallet: (id?: string | null) => Promise<{
    getAccounts: () => Promise<Array<{ accountId: string; publicKey?: string }>>;
    signMessage?: (p: unknown) => Promise<{ accountId: string; publicKey: string; signature: string }>;
    signAndSendTransaction?: (p: SignAndSendParams) => Promise<MaybeOutcome>;
  }>;
};

interface MaybeOutcome {
  transaction?: { hash?: string };
  status?: unknown;
}

let connector: ConnectorShape | null = null;
const connectorListeners = new Set<() => void>();
export function subscribeWalletChanges(listener:()=>void):()=>void { connectorListeners.add(listener); return () => { connectorListeners.delete(listener); }; }
export async function readConnectedWalletAccount():Promise<string|null> { try { if(!connector)return null; const wallet=await connector.wallet();return (await wallet.getAccounts())[0]?.accountId??null; } catch {return null;} }


function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function getConnector(): Promise<ConnectorShape> {
  if (!connector) {
    const { NearConnector } = (await import("@hot-labs/near-connect")) as {
      NearConnector: new (options: unknown) => ConnectorShape;
    };
    connector = new NearConnector({ network: NETWORK, features: { testnet: NETWORK === "testnet" } });
    for (const event of ["wallet:signIn", "wallet:signOut", "wallet:signInAndSignMessage"]) connector.on(event, () => { for (const listener of connectorListeners) listener(); });
  }
  return connector;
}

/** Open the wallet picker and read the selected account (read-only, off-chain). */
export async function connectWallet(): Promise<WalletResult<WalletAccount>> {
  try {
    const c = await getConnector();
    await c.connect();
    const wallet = await c.wallet();
    const accounts = await wallet.getAccounts();
    const account = accounts?.[0];
    if (!account?.accountId) {
      return { ok: false, code: "NO_ACCOUNT", detail: "The wallet returned no account." };
    }
    return { ok: true, code: "SIGNED_IN", value: { accountId: account.accountId, publicKey: account.publicKey } };
  } catch (error) {
    return { ok: false, code: "CONNECT_DENIED", detail: String((error as Error)?.message ?? error) };
  }
}

export async function disconnectWallet(): Promise<WalletResult<null>> {
  try {
    if (connector) await connector.disconnect();
    return { ok: true, code: "DISCONNECTED", value: null };
  } catch (error) {
    return { ok: false, code: "DISCONNECT_FAILED", detail: String((error as Error)?.message ?? error) };
  } finally {
    connector = null;
  }
}

/** An off-chain NEP-413 signature for account display / later server verify. */
export async function signProof(accountId: string): Promise<WalletResult<SignedProof>> {
  const c = await getConnector();
  let wallet: { signMessage?: (p: unknown) => Promise<{ accountId: string; publicKey: string; signature: string }> };
  try {
    wallet = await c.wallet();
  } catch (error) {
    return { ok: false, code: "NOT_CONNECTED", detail: String((error as Error)?.message ?? "Connect a wallet first.") };
  }
  if (typeof wallet.signMessage !== "function") {
    return { ok: false, code: "SIGNING_UNSUPPORTED", detail: "The selected wallet does not expose NEP-413 signMessage." };
  }
  try {
    const response = await fetch("/api/v1/auth/challenge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId, network: NETWORK, domain: APP_DOMAIN }) });
    const envelope = await response.json();
    const challenge = envelope.data as { challengeId: string; nonce: string; domain: string; network: string; accountId: string; message: string; issuedAtMs: number; expiresAtMs: number } | null;
    if (!response.ok || !challenge || challenge.accountId !== accountId || challenge.network !== NETWORK || challenge.domain !== APP_DOMAIN || !/^[0-9a-f]{64}$/.test(challenge.nonce) || challenge.expiresAtMs <= Date.now()) throw new Error("The server login challenge is unavailable or invalid.");
    const nonce = Uint8Array.from(challenge.nonce.match(/../g)!.map((byte) => parseInt(byte, 16)));
    const { issuedAtMs, expiresAtMs, message } = challenge;
    if (message !== canonicalProofMessage(accountId, nonce, issuedAtMs, expiresAtMs)) throw new Error("The server login challenge does not match the expected message.");
    const signed = await wallet.signMessage({ message, recipient: APP_DOMAIN, nonce, network: NETWORK });
    if (signed.accountId !== accountId) {
      return { ok: false, code: "ACCOUNT_MISMATCH", detail: `Wallet signed as ${signed.accountId}, not ${accountId}.` };
    }
    const currentWallet = await c.wallet();
    const accounts = await currentWallet.getAccounts();
    if (accounts[0]?.accountId !== accountId) return { ok: false, code: "ACCOUNT_MISMATCH", detail: "The wallet account changed. Reconnect before signing in." };
    const verified = await fetch("/api/v1/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: challenge.challengeId, accountId, network: NETWORK, domain: APP_DOMAIN, nonce: challenge.nonce, publicKey: signed.publicKey, signature: signed.signature }) });
    const result = await verified.json();
    if (!verified.ok || result.data?.accountId !== accountId || result.data?.network !== NETWORK) throw new Error(result.error?.message ?? "Server could not verify the wallet proof.");
    return {
      ok: true,
      code: "SIGNED",
      value: {
        accountId: signed.accountId,
        publicKey: signed.publicKey,
        signature: signed.signature,
        message,
        recipient: APP_DOMAIN,
        nonceHex: hex(nonce),
        issuedAtMs,
        expiresAtMs,
      },
    };
  } catch (error) {
    return { ok: false, code: "SIGN_DENIED", detail: String((error as Error)?.message ?? error) };
  }
}

export interface KeyPresence {
  permission: "FullAccess" | "FunctionCall";
  blockHeight: number;
}

/** Read-only access-key membership hint (transparency only, not a session). */
export async function readKeyPresence(accountId: string, publicKey?: string): Promise<WalletResult<KeyPresence>> {
  if (!publicKey) return { ok: false, code: "NO_PUBLIC_KEY", detail: "No public key for this account." };
  const result = await viewAccessKeyView(accountId, publicKey, RPC_URL);
  if (!result.ok) return { ok: false, code: result.code, detail: result.message };
  const permission = result.value.permission === "FullAccess" ? "FullAccess" : "FunctionCall";
  return { ok: true, code: "RESOLVED", value: { permission, blockHeight: result.blockHeight } };
}

/**
 * Propose a transaction through the connected wallet. The caller MUST pass a
 * user-clicked, separately-approved `SignAndSendParams`; the wallet shows its
 * own confirmation. Returns the transaction hash + status, never fabricated.
 */
export function walletNetworkAvailable(network: "mainnet" | "testnet"): boolean { return network === NETWORK && (network === "testnet" || (MAINNET_POLICY.approvedMicrotest !== null || (MAINNET_POLICY.providerAccepted && MAINNET_POLICY.approvedAllocatedEvent !== null) || MAINNET_POLICY.acceptedFactory?.approval !== undefined)); }
export function walletRequestAvailable(params: SignAndSendParams): boolean { return walletNetworkAvailable(params.network) && (params.network === "testnet" || mainnetRequestAllowed(params)); }

export async function signAndSendTransaction(params: SignAndSendParams): Promise<WalletResult<TxResult>> {
  if (!walletRequestAvailable(params)) return { ok: false, code: "NETWORK_UNAVAILABLE", detail: "Transactions are unavailable for this network configuration." };
  const c = await getConnector();
  let wallet: { getAccounts: () => Promise<Array<{ accountId: string }>>; signAndSendTransaction?: (p: SignAndSendParams) => Promise<MaybeOutcome> };
  try {
    wallet = await c.wallet();
  } catch (error) {
    return { ok: false, code: "NOT_CONNECTED", detail: String((error as Error)?.message ?? "Connect a wallet first.") };
  }
  if (typeof wallet.signAndSendTransaction !== "function") {
    return { ok: false, code: "TX_SIGNING_UNSUPPORTED", detail: "The selected wallet does not expose signAndSendTransaction." };
  }
  try {
    const accounts = await wallet.getAccounts();
    if (accounts[0]?.accountId !== params.signerId) {
      return { ok: false, code: "ACCOUNT_MISMATCH", detail: "The wallet account changed. Reconnect before signing." };
    }
    const outcome = await wallet.signAndSendTransaction(params);
    return {
      ok: true,
      code: "TRANSACTION_PROPOSED",
      value: {
        transactionHash: outcome?.transaction?.hash ?? null,
        status: typeof outcome?.status === "string" ? (outcome.status as string) : JSON.stringify(outcome?.status ?? null),
      },
    };
  } catch (error) {
    return { ok: false, code: "TRANSACTION_DENIED", detail: String((error as Error)?.message ?? error) };
  }
}
