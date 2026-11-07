// ShowStake T02 browser harness — real NEAR Connect + near-api-js SDK logic.
//
// This is a MINIMAL DIAGNOSTIC PROBE, not product UI and not a login backend.
// It performs, at most, READ-ONLY RPC calls and an off-chain NEP-413 message
// signature (when the human consents in a real wallet). It NEVER:
//   * creates a wallet/account, requests a faucet, or broadcasts a transaction,
//   * deposits, spends, deploys, or uses any paid resource,
//   * treats a signature as a deposit/pass success, or fakes a wallet response.
//
// Security posture (fail-closed, mirrors packages/wallet-adapter):
//   * The ONLY acceptable verification path is a network-pinned RPC access-key
//     resolver (near-api-js `viewAccessKey`) requiring FullAccess, plus the
//     canonical NEP-413 ed25519/secp256k1 signature check. If the RPC is
//     missing/unavailable, live authentication DENIES (never falls back to a
//     local implicit-account guess). There is no implicit-account fallback in
//     live mode — that fallback exists only in the Node fixture selftests
//     (scripts/verify-t02-*.mjs) and is explicitly labeled fixture-only.
//   * The signed message binds domain/network/purpose/account/issued_at/
//     expires_at/nonce; expiration <=5m.

import { NearConnector } from '@hot-labs/near-connect';
import { JsonRpcProvider } from 'near-api-js';
import { verifyMessage } from 'near-api-js/nep413';

export const NETWORK = 'testnet';
export const APP_DOMAIN = 'showstake.app';
export const APP_PURPOSE = 'login';
export const RPC_URL = 'https://rpc.testnet.near.org';
export const MAX_CHALLENGE_TTL_MS = 5 * 60 * 1000;

// Candidate list. NEAR Connect is fully wired; NEAR Auth is documented/prepared
// but its ON-CHAIN `sign` action is intentionally NOT invoked by this harness.
export const CANDIDATES = Object.freeze([
  { id: 'near-connect', label: 'NEAR Connect (native wallet, offchain NEP-413)', wired: true },
  { id: 'near-auth', label: 'NEAR Auth (social/email, testnet — on-chain sign, PREPARED not invoked)', wired: false },
]);

export const NEAR_AUTH_TESTNET = Object.freeze({
  // PUBLIC development-only shared config (docs.auth.near.org/resources/testnet).
  // Not a secret.
  network: 'testnet',
  clientId: 'np8paqIpMWmNbzT4xAvOOapZBjsOpptl',
  domain: 'login.testnet.fast-auth.com',
  signingAudience: 'auth0.jwt.fast-auth.testnet',
  fastAuthContractId: 'fast-auth.testnet',
  mpcContractId: 'v1.signer-prod.testnet',
  rpcUrl: 'https://rpc.testnet.near.org',
  // NEAR Auth sign-message is ON-CHAIN: requestMessageSignature -> createSignAction
  // builds a `sign` action that a FUNDED account/relayer broadcasts to the NEAR Auth
  // contract. This harness PREPARES these exact values but flashes a hard stop
  // instead of broadcasting (no funded relayer, no human Auth0 approval here).
  signAction: Object.freeze({
    contractId: 'fast-auth.testnet',
    method: 'sign',
    gas: '300000000000000', // 300 Tgas (docs.auth.near.org sign-messages guide)
    deposit: '1',           // 1 yoctoNEAR attached deposit
    broadcasts: true,        // this IS a transaction -> must never run in this probe
    approvalBoundary: 'requires (1) human Auth0 approval in popup, (2) a funded relayer/backend account, (3) explicit scoped user authorization to spend. NOT executed here.',
  }),
});

const state = {
  candidate: 'near-connect',
  connector: null,
  wallet: null,
  accounts: [],
  status: 'IDLE',
  sequence: 0,
  sessions: [],        // [{seq, event, accountId, publicKey, network, at}]
  connectCycle: 0,     // increments only on a genuine CONNECTED (after a disconnect boundary)
  lastConnectedAccount: null,
  lastChallenge: null, // {message, recipient, nonceHex, nonce, accountId, publicKey, signature, issuedAtMs, expiresAtMs}
  lastResult: null,
  verificationGeneration: 0,   // bumped on every invalidation (disconnect/account/candidate switch)
  consumedNonces: new Set(),   // nonce hex -> already consumed (single-use/replay protection)
  verifyingNonces: new Set(),  // nonce hex -> verification in flight (overlap guard)
  // Test seam (FIXTURE-ONLY; never set by live/browser code): allows an offline
  // test to inject a fake `verifyMessage` and a fixed clock so the four Codex
  // defense checks (future issuance, TTL<=5m, nonce replay, genuine relogin) are
  // exercised against the REAL harness logic rather than string presence.
  deps: null, // { verifyMessage(payload): Promise<void>, now(): number }
};

export function getState() { return state; }

const nowMs = () => (state.deps && typeof state.deps.now === 'function' ? state.deps.now() : Date.now());

function invalidateSignedState() {
  // A disconnect, account switch or candidate switch invalidates any signed
  // proof-of-control state from a prior session. Bumping the generation makes any
  // in-flight `signChallenge`/`verifyChallenge` await completion stale, so a late
  // callback cannot publish success or overwrite the newer session's status.
  state.verificationGeneration += 1;
  state.lastChallenge = null;
  state.lastResult = null;
  state.verifyingNonces.clear();
}

export function selectCandidate(id) {
  const c = CANDIDATES.find((x) => x.id === id);
  if (!c) throw new Error(`unknown candidate ${id}`);
  state.candidate = id;
  state.status = id === 'near-connect' ? 'IDLE' : 'NOT_WIRED';
  invalidateSignedState();
  return c;
}

function hex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function b64ToBytes(b64) {
  if (b64 instanceof Uint8Array) return b64;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Canonical signed message. MUST equal what the wallet is shown and what the
 * backend later re-verifies; identity-consistent with
 * packages/wallet-adapter/src/verify-binding.mjs `canonicalChallengeMessage`.
 */
export function canonicalMessage({ accountId, nonce, issuedAtMs, expiresAtMs }) {
  return [
    'ShowStake v2 proof-of-control',
    `domain=${APP_DOMAIN}`,
    `network=${NETWORK}`,
    `purpose=${APP_PURPOSE}`,
    `account_id=${accountId}`,
    `issued_at_ms=${issuedAtMs}`,
    `expires_at_ms=${expiresAtMs}`,
    `nonce=${hex(nonce)}`,
  ].join('\n');
}

function provider() {
  return new JsonRpcProvider({ url: RPC_URL });
}

// --- NEAR Connect (native wallet) -------------------------------------------

export async function connectWallet() {
  if (state.candidate !== 'near-connect') {
    throw new Error(`candidate '${state.candidate}' is not wired for interactive connect`);
  }
  if (!state.connector) {
    state.connector = new NearConnector({ network: NETWORK, features: { testnet: true } });
    state.connector.on('wallet:signIn', ({ accounts }) => {
      // Informational only: `sameAccountAcrossSessions` ignores SIGN_IN_EVENT rows
      // so a single connect (SIGN_IN_EVENT + CONNECTED) cannot satisfy a relogin.
      recordSession('SIGN_IN_EVENT', accounts?.[0]);
    });
    state.connector.on('wallet:signOut', ({ success }) => {
      // A FAILED external signOut is NOT a successful disconnect boundary: it
      // must not count toward `sameAccountAcrossSessions`, nor invalidate a
      // still-signed-in session (Codex async-review).
      if (success === false) {
        state.status = 'SIGN_OUT_FAILED';
        return;
      }
      recordSession('SIGNED_OUT', null);
      invalidateSignedState();
      state.lastConnectedAccount = null;
      state.status = 'SIGNED_OUT';
    });
  }
  state.status = 'CONNECTING_POPUP';
  try {
    // Opens the wallet selector (popup/iframe). Resolves with the selected wallet.
    await state.connector.connect();
    state.wallet = await state.connector.wallet();
    state.accounts = (await state.wallet.getAccounts()) ?? [];
    if (state.accounts.length === 0) {
      state.status = 'NO_ACCOUNT';
      return { ok: false, code: 'NO_ACCOUNT', detail: 'wallet returned no accounts' };
    }
    const acct = state.accounts[0];
    state.connectCycle += 1;
    if (state.lastConnectedAccount !== null && acct.accountId !== state.lastConnectedAccount) {
      invalidateSignedState();
    }
    recordSession('CONNECTED', acct);
    state.lastConnectedAccount = acct.accountId;
    state.status = 'SIGNED_IN';
    return { ok: true, code: 'SIGNED_IN', account: acct };
  } catch (e) {
    state.status = 'CONNECT_DENIED';
    return { ok: false, code: 'CONNECT_DENIED', detail: String(e?.message ?? e) };
  }
}

function recordSession(event, account) {
  state.sequence += 1;
  const rec = {
    seq: state.sequence,
    event,
    accountId: account ? account.accountId : null,
    publicKey: account ? account.publicKey : null,
    network: NETWORK,
    at: new Date().toISOString(),
  };
  state.sessions.push(rec);
  return rec;
}

export function sameAccountAcrossSessions() {
  // A genuine relogin requires a disconnect (DISCONNECTED or SIGNED_OUT) BETWEEN
  // two CONNECTED records. SIGN_IN_EVENT rows are ignored because a single connect
  // emits both SIGN_IN_EVENT and CONNECTED — those two rows are ONE session and
  // must not satisfy relogin (Codex harness-review defect #4).
  const connected = [];
  let boundary = true; // true right before the first connect (no prior session)
  for (const s of state.sessions) {
    if (s.event === 'DISCONNECTED' || s.event === 'SIGNED_OUT') {
      boundary = true;
    } else if (s.event === 'CONNECTED' && s.accountId) {
      if (boundary) {
        connected.push(s.accountId);
        boundary = false;
      }
    }
  }
  if (connected.length < 2) {
    return { ok: false, code: 'NEED_TWO_SESSIONS', detail: 'connect at least twice (incl. after a disconnect)' };
  }
  const first = connected[0];
  const last = connected[connected.length - 1];
  return {
    ok: true,
    code: first === last ? 'SAME_ACCOUNT' : 'DIFFERENT_ACCOUNT',
    first,
    last,
    same: first === last,
  };
}

export async function disconnectWallet() {
  if (!state.connector) return { ok: false, code: 'NOT_CONNECTED' };
  // Invalidate immediately, BEFORE the disconnect await, so no in-flight
  // sign/verify can publish after the user chooses to leave (Codex async-review).
  invalidateSignedState();
  state.lastConnectedAccount = null;
  state.status = 'SIGNING_OUT';
  try {
    await state.connector.disconnect();
    recordSession('DISCONNECTED', null);
    state.wallet = null;
    state.accounts = [];
    state.status = 'SIGNED_OUT';
    return { ok: true, code: 'DISCONNECTED' };
  } catch (e) {
    return { ok: false, code: 'DISCONNECT_FAILED', detail: String(e?.message ?? e) };
  }
}

/** Read account state through the real RPC (read-only). */
export async function readAccount(accountId) {
  try {
    const acc = await provider().viewAccount({ accountId });
    return { ok: true, code: 'ACCOUNT_READ', observed: acc };
  } catch (e) {
    return { ok: false, code: 'RPC_UNAVAILABLE', detail: String(e?.message ?? e) };
  }
}

/** Off-chain NEP-413 signature via the connected wallet (human consents). */
export async function signChallenge(accountId) {
  if (!state.wallet) return { ok: false, code: 'NOT_CONNECTED' };
  if (typeof state.wallet.signMessage !== 'function') {
    return { ok: false, code: 'SIGNING_UNSUPPORTED', detail: 'selected wallet does not expose NEP-413 signMessage' };
  }
  const gen = state.verificationGeneration;
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const issuedAtMs = Date.now();
  const expiresAtMs = issuedAtMs + MAX_CHALLENGE_TTL_MS;
  const message = canonicalMessage({ accountId, nonce, issuedAtMs, expiresAtMs });
  state.status = 'AWAITING_SIGNATURE';
  try {
    // signature is a base64 string in @hot-labs/near-connect.
    const signed = await state.wallet.signMessage({ message, recipient: APP_DOMAIN, nonce, network: NETWORK });
    // A candidate/account/disconnect boundary crossed while the wallet prompt was
    // open: the late sign callback must NOT (re)populate the signed challenge or
    // overwrite the newer session's status (Codex async-review).
    if (state.verificationGeneration !== gen) {
      return { ok: false, code: 'STALE_OPERATION', detail: 'session changed while signing; sign again' };
    }
    state.lastChallenge = {
      message,
      recipient: APP_DOMAIN,
      nonceHex: hex(nonce),
      nonce,
      accountId: signed.accountId,
      publicKey: signed.publicKey,
      signature: signed.signature,
      issuedAtMs,
      expiresAtMs,
    };
    state.status = 'SIGNED';
    return { ok: true, code: 'SIGNED', signed };
  } catch (e) {
    if (state.verificationGeneration !== gen) {
      return { ok: false, code: 'STALE_OPERATION', detail: 'session changed while signing' };
    }
    state.status = 'SIGN_DENIED';
    return { ok: false, code: 'SIGN_DENIED', detail: String(e?.message ?? e) };
  }
}

/**
 * A stale async completion: returned WITHOUT mutating state, so it can never
 * overwrite a newer session's status/result. Distinct from `fail`, which records
 * a genuine denial for the CURRENT challenge.
 */
function stale(code, detail) {
  return { ok: false, code, detail };
}

function fail(code, detail) {
  state.status = 'VERIFY_DENIED';
  state.lastResult = { ok: false, code, detail };
  return state.lastResult;
}

/**
 * Verify the proof through the REAL SDK: near-api-js `verifyMessage` performs both
 * (a) the canonical NEP-413 signature check and (b) the network-pinned access-key
 * ownership resolver (`viewAccessKey`, FullAccess required). It THROWS (and we
 * deny) when the RPC is unavailable, the account/key does not exist, or the key
 * lacks FullAccess — i.e. live auth FAILS CLOSED with no implicit-account fallback.
 *
 * App-level defenses (Codex harness-review) run BEFORE and AFTER the SDK, all of
 * them fail-closed:
 *   * finite INTEGER issued/expiry ms; issuance <= now; 0 < TTL <= 5m; not expired;
 *   * canonical domain/network/purpose/account binding (message equality + non-empty
 *     account + recipient == APP_DOMAIN);
 *   * nonce is exactly 32 bytes and single-use — consumed exactly once on success,
 *     with a synchronous in-flight reservation so overlapping awaits cannot both
 *     pass (adversarial seam: `getState().deps = { verifyMessage, now }`).
 */
export async function verifyChallenge() {
  const c = state.lastChallenge;
  if (!c) return { ok: false, code: 'NO_CHALLENGE', detail: 'sign a challenge first' };
  const gen = state.verificationGeneration;
  const now = nowMs();

  // -- canonical binding (domain/network/purpose/account) ---------------------
  if (c.recipient !== APP_DOMAIN) return fail('WRONG_DOMAIN', `recipient '${c.recipient}' != expected '${APP_DOMAIN}'`);
  if (typeof c.accountId !== 'string' || c.accountId.length === 0) return fail('INVALID_ACCOUNT', 'challenge account is missing');
  if (!(c.nonce instanceof Uint8Array) || c.nonce.length !== 32) return fail('BAD_NONCE', 'nonce must be exactly 32 bytes');

  // -- timestamps: finite integer ms, not future, 0 < TTL <= 5m, not expired ---
  for (const [name, v] of [['issuedAtMs', c.issuedAtMs], ['expiresAtMs', c.expiresAtMs]]) {
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
      return fail('BAD_TIMESTAMP', `${name} must be a finite integer ms epoch (got ${String(v)})`);
    }
  }
  const nowInt = Math.trunc(now);
  if (c.issuedAtMs > nowInt) return fail('FUTURE_ISSUANCE', `issuedAtMs ${c.issuedAtMs} > now ${nowInt}`);
  const ttl = c.expiresAtMs - c.issuedAtMs;
  if (ttl <= 0) return fail('NONPOSITIVE_TTL', `expiresAtMs ${c.expiresAtMs} <= issuedAtMs ${c.issuedAtMs}`);
  if (ttl > MAX_CHALLENGE_TTL_MS) return fail('EXPIRY_TOO_LONG', `TTL ${ttl}ms exceeds ${MAX_CHALLENGE_TTL_MS}ms`);
  if (nowInt >= c.expiresAtMs) return fail('STALE_PROOF', `expired at ${c.expiresAtMs} (now ${nowInt})`);

  // -- the signed message must be the exact canonical binder ------------------
  const expected = canonicalMessage({ accountId: c.accountId, nonce: c.nonce, issuedAtMs: c.issuedAtMs, expiresAtMs: c.expiresAtMs });
  if (c.message !== expected) return fail('MESSAGE_NOT_BOUND', 'signed message != canonical binder (context tampered)');

  // -- single-use nonce + overlapping-await guard (synchronous reserve) -------
  const nk = hex(c.nonce);
  if (state.consumedNonces.has(nk) || state.verifyingNonces.has(nk)) {
    return fail('REUSED_NONCE', `nonce ${nk} already consumed or verification in flight`);
  }
  state.verifyingNonces.add(nk); // reserve now so two concurrent verifies can't both pass

  try {
    if (state.deps && typeof state.deps.verifyMessage === 'function') {
      await state.deps.verifyMessage({
        signerAccountId: c.accountId,
        signerPublicKey: c.publicKey,
        signature: b64ToBytes(c.signature),
        payload: { message: c.message, recipient: c.recipient, nonce: c.nonce },
      });
    } else {
      await verifyMessage({
        signerAccountId: c.accountId,
        signerPublicKey: c.publicKey,
        signature: b64ToBytes(c.signature),
        payload: { message: c.message, recipient: c.recipient, nonce: c.nonce },
        provider: provider(),
      });
    }
  } catch (e) {
    // A candidate/account/disconnect boundary crossed while the verifier was
    // pending: invalidateSignedState already cleared `verifyingNonces`, so the
    // stale completion must NOT release/consume the nonce, overwrite status, or
    // act like a successful verification.
    if (state.verificationGeneration !== gen) {
      return stale('STALE_OPERATION', 'session changed while verifying');
    }
    state.verifyingNonces.delete(nk); // release on failure -> a later honest retry is allowed
    return fail('VERIFY_DENIED', String(e?.message ?? e));
  }

  // AFTER the SDK await: re-validate currency + freshness (Codex async-review).
  // If the challenge was invalidated (gen changed / lastChallenge replaced) while
  // pending, the stale completion must not publish success or touch state.
  if (state.verificationGeneration !== gen || state.lastChallenge !== c) {
    return stale('STALE_OPERATION', 'challenge invalidated while verification was in flight');
  }
  state.verifyingNonces.delete(nk); // we still own the reservation (same generation)

  const nowAfter = Math.trunc(nowMs());
  if (nowAfter >= c.expiresAtMs) return fail('STALE_PROOF', `expired at ${c.expiresAtMs} (now ${nowAfter})`);
  if (c.issuedAtMs > nowAfter) return fail('FUTURE_ISSUANCE', `issuedAtMs ${c.issuedAtMs} > now ${nowAfter}`);

  // success: move from in-flight to consumed exactly once.
  state.consumedNonces.add(nk);
  state.status = 'VERIFIED';
  state.lastResult = { ok: true, code: 'VERIFIED', accountId: c.accountId, publicKey: c.publicKey };
  return state.lastResult;
}

/** Explicit key-ownership resolver (surfaced for transparency on the UI). */
export async function resolveAccessKey(accountId, publicKey) {
  try {
    const ak = await provider().viewAccessKey({ accountId, publicKey });
    return {
      ok: true,
      code: 'RESOLVED',
      permission: ak.permission,
      blockHeight: ak.block_height,
      nonce: ak.nonce,
    };
  } catch (e) {
    return { ok: false, code: 'RPC_UNAVAILABLE', detail: String(e?.message ?? e) };
  }
}