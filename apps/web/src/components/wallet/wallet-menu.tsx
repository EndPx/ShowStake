"use client";

// Native NEAR wallet connection and server-verified sign-in.

import { CalendarDays, LogOut, PenLine, Wallet } from "lucide-react";
import { useWallet } from "./wallet-context";

function short(value: string, head = 10, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function WalletMenu() {
  const wallet = useWallet();
  const connected = !!wallet.account;

  return (
    <div className="wallet-menu">
      {connected && wallet.account ? (
        <details className="account-menu">
          <summary aria-label="Near account menu">
            <span>{wallet.account.accountId.slice(0, 1).toUpperCase()}</span>
          </summary>
          <div className="account-popover">
            <strong>Your NEAR wallet</strong>
            <div className="account-wallet">
              <div className="account-wallet-details">
                <span className="account-wallet-label">
                  Connected ({wallet.network})
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
              Events you create belong to this account. Transactions are approved
              in your wallet.
            </p>
            {wallet.proof && (
              <div className="wallet-proof">
                <strong>Signed in</strong>
                <span className="wallet-proof-note">
                  Wallet ownership verified. Signing in does not move funds.
                </span>
                <details className="wallet-session-details"><summary>Session details</summary>
                  <code className="wallet-proof-field">expires {new Date(wallet.proof.expiresAtMs).toISOString()}</code>
                </details>
              </div>
            )}
            <button type="button" onClick={() => void wallet.sign()} disabled={wallet.status === "signing"}>
              <PenLine size={15} />
              {wallet.status === "signing" ? "Signing…" : wallet.proof ? "Sign in again" : "Sign in"}
            </button>
            <a href="/events"><CalendarDays size={15} /> My events</a>
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
