// Canonical proof-of-control message (NEP-413 login binder), self-contained so
// both the browser wallet (lib/near/wallet.ts) and the Node verification script
// can import it. No runtime imports — the strings below are the frozen binder
// values; they must stay identical to packages/wallet-adapter
// `canonicalChallengeMessage` for a context-less login challenge.

export const APP_DOMAIN = "showstake.app";
export const APP_NETWORK = "testnet";
export const APP_PURPOSE = "login";
export const MAX_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function canonicalProofMessage(
  accountId: string,
  nonce: Uint8Array,
  issuedAtMs: number,
  expiresAtMs: number,
): string {
  return [
    "ShowStake v2 proof-of-control",
    `domain=${APP_DOMAIN}`,
    `network=${APP_NETWORK}`,
    `purpose=${APP_PURPOSE}`,
    `account_id=${accountId}`,
    `issued_at_ms=${issuedAtMs}`,
    `expires_at_ms=${expiresAtMs}`,
    `nonce=${hex(nonce)}`,
  ].join("\n");
}