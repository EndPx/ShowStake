"use client";

// Native NEAR wallet button + account display in the platform shell. Honest:
// connect (wallet picker), sign (off-chain NEP-413 proof), account display and
// a "testnet" badge. The signed proof is labelled as NOT a verified session and
// NOT a deposit; server verification (/auth/verify) is out of scope for this
// slice.

import { LogOut, PenLine, Wallet } from "lucide-react";
import { useWallet } from "./wallet-context";

function short(value: string, head = 10, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function WalletMenu() {
  const wallet = useWallet();
  const connected = wallet.status === "connected" || wallet.status === "connecting";

  return (
    <div className="wallet-menu">
      {connected && wallet.account ? (
        <details className="account-menu">
          <summary aria-label="Near account menu">
            <span>{wallet.account.accountId.slice(0, 1).toUpperCase()}</span>
          </summary>
          <div className="account-popover">
            <strong>NEAR account</strong>
            <div className="account-wallet">
              <div className="account-wallet-details">
                <span className="account-wallet-label">
                  {wallet.keyPermission === "FullAccess" ? "Connected (testnet)" : "Connected (testnet)"}
                </span>
                <code>{wallet.account.accountId}</code>
                {wallet.account.publicKey && (
                  <code className="wallet-key-hint" title={wallet.account.publicKey}>
                    key {short(wallet.account.publicKey, 12, 8)}
                  </code>
                )}
              </div>
            </div>
            <p>
              This is the account that would own your pass and receive any refund.
              It is shown directly from your NEAR wallet.
            </p>
            {wallet.proof && (
              <div className="wallet-proof">
                <strong>Signed proof of control</strong>
                <span className="wallet-proof-note">
                  Signed off-chain (NEP-413). Not a verified session and not a deposit.
                </span>
                <code className="wallet-proof-field">nonce {short(wallet.proof.nonceHex, 14, 8)}</code>
                <code className="wallet-proof-field">sig {short(wallet.proof.signature, 16, 10)}</code>
                <code className="wallet-proof-field">expires {new Date(wallet.proof.expiresAtMs).toISOString()}</code>
              </div>
            )}
            <button type="button" onClick={() => void wallet.sign()} disabled={wallet.status === "signing"}>
              <PenLine size={15} />
              {wallet.status === "signing" ? "Signing…" : wallet.proof ? "Sign again" : "Sign proof"}
            </button>
            <button type="button" onClick={() => void wallet.disconnect()}>
              <LogOut size={15} />
              Disconnect
            </button>
          </div>
        </details>
      ) : (
        <div className="wallet-connect-area">
          <button
            type="button"
            className="button button--small"
            onClick={() => void wallet.connect()}
            disabled={wallet.status === "connecting"}
            aria-label="Connect wallet"
          >
            <Wallet size={16} aria-hidden="true" />
            <span className="wallet-connect-label">
              {wallet.status === "connecting" ? "Connecting…" : "Connect wallet"}
            </span>
          </button>
          {wallet.error && <span className="wallet-error" role="alert">{wallet.error}</span>}
        </div>
      )}
    </div>
  );
}