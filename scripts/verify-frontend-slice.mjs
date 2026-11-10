// verify-frontend-slice — behavioral checks for the ShowStake web slice
// (API envelope/enrichment, event detail, exact NEAR Connect transaction
// actions, registration confirmation, native-wallet proof binding, accepted
// deployment identity). Behavioral, not string-presence: it imports the shipped
// modules (Node 24 native TS type-stripping) and asserts actual return values.
//
// Run from the repo root: `node scripts/verify-frontend-slice.mjs`

const { formatUnits, isAtomicString } = await import("../apps/web/src/lib/money.ts");
const { statusLabel } = await import("../apps/web/src/lib/events.ts");
const config = await import("../apps/web/src/lib/config.ts");
const api = await import("../apps/web/src/lib/api.ts");
const deposit = await import("../apps/web/src/lib/deposit.ts");
const actions = await import("../apps/web/src/lib/near/actions.ts");
const { confirmRegistration, findRegistrationForAccount } = await import("../apps/web/src/lib/registration.ts");
const viewsMap = await import("../apps/web/src/lib/near/views-map.ts");
const proof = await import("../apps/web/src/lib/near/proof.ts");
const attempt = await import("../apps/web/src/lib/attempt.ts");
const receipt = await import("../apps/web/src/lib/near/receipt.ts");
const commitFlow = await import("../apps/web/src/lib/commit-flow.ts");

let passed = 0;
let failed = 0;
const failures = [];
function ok(name) {
  passed += 1;
  console.log(`  PASS  ${name}`);
}
function bad(name, detail) {
  failed += 1;
  failures.push(name);
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}
function assert(name, cond, detail) {
  if (cond) ok(name);
  else bad(name, detail);
}

// ---- accepted deployment identity (never a fixture catalogue) ---------------
assert("accepted event resolves", config.acceptedEvent("d036-settle-five")?.eventId === "d036-settle-five", config.acceptedEvent("d036-settle-five")?.eventId);
assert("accepted contract fixed", config.acceptedEvent("d036-settle-five")?.contractId === "showstake-settle-endpx.testnet", "contract");
assert("accepted policy v6", config.acceptedEvent("d036-settle-five")?.policyVersion === "showstake-v2-d036-settle/1", "policy");
assert("FT identity fixed", config.CANONICAL_FT === "showstake-ft-endpx.testnet" && config.CANONICAL_FT_DECIMALS === 6, `${config.CANONICAL_FT}/${config.CANONICAL_FT_DECIMALS}`);
assert("unknown event rejected", config.isAcceptedEvent("d036-settle-five") && !config.isAcceptedEvent("invented-event"), "unknown");
assert("contract -> accepted resolves", config.acceptedContract("showstake-settle-endpx.testnet")?.eventId === "d036-settle-five", "acceptedContract");
assert("api is same-origin /api/v1", config.API_PUBLIC_BASE === "/api/v1" && config.apiBaseUrl() === "/api/v1", config.apiBaseUrl());

// ---- money / u128 ----------------------------------------------------------
assert("u128: deposit formats 6dp", formatUnits("6000000", 6, "SYN") === "6 SYN", formatUnits("6000000", 6, "SYN"));
assert("u128: overflow rejected", !isAtomicString("340282366920938463463374607431768211456"), "2^128");
assert("u128: canonical predicate", isAtomicString("0") && isAtomicString("6000000"), "0/6000000");

// ---- state gating ----------------------------------------------------------
const endedEvent = {
  eventId: "d036-settle-five",
  state: "SETTLED",
  depositAtomic: "6000000",
  capacity: 20,
  regOpen: "2026-01-01T00:00:00Z",
  regClose: "2026-01-02T00:00:00Z",
};
assert("state: SETTLED never open", deposit.computeDepositPreflight({
  event: endedEvent,
  nowMs: Date.parse("2026-01-01T12:00:00Z"),
  ftRegistered: null,
  ftBalanceAtomic: null,
  nativeStorageDeposited: null,
}).phase === "ended" && deposit.computeDepositPreflight({
  event: endedEvent,
  nowMs: Date.parse("2026-01-01T12:00:00Z"),
  ftRegistered: null,
  ftBalanceAtomic: null,
  nativeStorageDeposited: null,
}).registrationAllowed === false, "settled");
assert("state: settled label", statusLabel("SETTLED") === "Event ended", statusLabel("SETTLED"));

assert("deposit: open+ready (explicit storage approval)", (() => {
  const p = deposit.computeDepositPreflight({
    event: { ...endedEvent, state: "PUBLISHED", capacity: 20, registeredCount: 3 },
    nowMs: Date.parse("2026-01-01T12:00:00Z"),
    ftRegistered: true,
    ftBalanceAtomic: "6000000",
    nativeStorageDeposited: true,
  });
  return p.phase === "open" && p.readyToSign === true;
})(), "open-ready");

assert("deposit: positive credit alone is NOT enough", (() => {
  const p = deposit.computeDepositPreflight({
    event: { ...endedEvent, state: "PUBLISHED", capacity: 20, registeredCount: 3 },
    nowMs: Date.parse("2026-01-01T12:00:00Z"),
    ftRegistered: true,
    ftBalanceAtomic: "6000000",
    nativeStorageDeposited: false, // credit>0 but no in-session approval
  });
  const native = p.steps.find((s) => s.id === "native_storage");
  return native?.kind === "action" && p.readyToSign === false;
})(), "native-storage-not-auto-ok");

assert("deposit: insufficient balance blocks", deposit.computeDepositPreflight({
  event: { ...endedEvent, state: "PUBLISHED", capacity: 20, registeredCount: 3 },
  nowMs: Date.parse("2026-01-01T12:00:00Z"),
  ftRegistered: true,
  ftBalanceAtomic: "5999999",
  nativeStorageDeposited: true,
}).readyToSign === false, "short balance");

assert("deposit: unknown count is not 0/full", (() => {
  const p = deposit.computeDepositPreflight({
    event: { ...endedEvent, state: "PUBLISHED", capacity: 3 },
    nowMs: Date.parse("2026-01-01T12:00:00Z"),
    ftRegistered: true,
    ftBalanceAtomic: "6000000",
    nativeStorageDeposited: true,
  });
  return p.phase === "open" && p.readyToSign === true;
})(), "unknown registeredCount");

assert("deposit: unknown preflight fails closed", deposit.computeDepositPreflight({
  event: { ...endedEvent, state: "PUBLISHED", capacity: 20, registeredCount: 3 },
  nowMs: Date.parse("2026-01-01T12:00:00Z"),
  ftRegistered: null,
  ftBalanceAtomic: null,
  nativeStorageDeposited: null,
}).canProceed === false, "unknown");

// ---- exact FT call + commitment -------------------------------------------
const call = deposit.buildFtTransferCall({
  ftContractId: config.CANONICAL_FT,
  showstakeContractId: config.acceptedEvent("d036-settle-five").contractId,
  depositAtomic: "6000000",
  eventId: "d036-settle-five",
  commitmentId: "abc-123",
});
assert("ft: receiver is escrow", call.args.receiver_id === "showstake-settle-endpx.testnet", call.args.receiver_id);
assert("ft: amount + msg exact", call.args.amount === "6000000" && call.args.msg === JSON.stringify({ version: 1, event_id: "d036-settle-five", commitment_id: "abc-123" }), call.args.msg);
assert("ft: NEP-141 1 yocto", call.attachedDeposit === "1" && call.methodName === "ft_transfer_call", call.attachedDeposit);
assert("ft: gas is the NEP-141 default", call.gasTgas === 300, String(call.gasTgas));
assert("commitment: valid id accepted", deposit.buildCommitMessage("d036-settle-five", "abc-123").version === 1, "version");

// ---- exact NEAR Connect transaction actions (no invalid NEP args) ----------
const transferAction = actions.buildFtTransferCallAction({
  ftContractId: config.CANONICAL_FT,
  showstakeContractId: config.SHOWSTAKE_CONTRACT,
  depositAtomic: "6000000",
  msg: '{"version":1,"event_id":"d036-settle-five","commitment_id":"abc-123"}',
});
assert("action: ft_transfer_call shape", transferAction.type === "FunctionCall" && transferAction.params.methodName === "ft_transfer_call", transferAction.params.methodName);
assert("action: ft transfer args exact", transferAction.params.args.receiver_id === config.SHOWSTAKE_CONTRACT && transferAction.params.args.amount === "6000000" && transferAction.params.args.msg === '{"version":1,"event_id":"d036-settle-five","commitment_id":"abc-123"}', JSON.stringify(transferAction.params.args));
assert("action: ft transfer gas/deposit", transferAction.params.gas === "300000000000000" && transferAction.params.deposit === "1", `${transferAction.params.gas}/${transferAction.params.deposit}`);

const nativeAction = actions.buildShowstakeStorageDepositAction({ accountId: "alice.testnet" });
assert("action: showstake storage args", nativeAction.type === "FunctionCall" && nativeAction.params.methodName === "storage_deposit" && nativeAction.params.args.account_id === "alice.testnet", JSON.stringify(nativeAction.params));
assert("action: showstake storage gas/buffer", nativeAction.params.gas === "50000000000000" && nativeAction.params.deposit === "10000000000000000000000", `${nativeAction.params.gas}/${nativeAction.params.deposit}`);

const ftStorageAction = actions.buildFtStorageDepositAction({});
assert("action: ft storage args", ftStorageAction.params.methodName === "storage_deposit" && Object.keys(ftStorageAction.params.args).length === 0 && ftStorageAction.params.gas === "30000000000000", JSON.stringify(ftStorageAction.params));

// ---- registration confirmation --------------------------------------------
const regView = {
  registration_id: "reg-0",
  event_id: "d036-settle-five",
  pass_id: "pass-0",
  participant: "alice.testnet",
  beneficiary: "alice.testnet",
  commitment_id: "c1",
  amount: "6000000",
  event_sequence: 0,
  registration_status: "Active",
  attendance_status: "Attended",
  financial_status: "Claimable",
  registered_at: 1700000000000,
};
const passView = {
  pass_id: "pass-0",
  event_id: "d036-settle-five",
  registration_id: "reg-0",
  owner: "alice.testnet",
  issued_at: 1700000000000,
  registration_status: "Active",
  attendance_status: "Attended",
  financial_status: "Claimable",
  policy_version: "showstake-v2-d036-settle/1",
};
assert("registration: confirmed when owner+pass_id match", confirmRegistration({ eventId: "d036-settle-five", accountId: "alice.testnet", contractId: config.SHOWSTAKE_CONTRACT, network: "testnet", registration: regView, pass: passView, committedDepositAtomic: "6000000", expectedCommitmentId: "c1" }).status === "confirmed", "confirmed");
assert("registration: pass_id mismatch denied", confirmRegistration({ eventId: "d036-settle-five", accountId: "alice.testnet", registration: regView, pass: { ...passView, pass_id: "pass-other" } }).status === "mismatch", "pass_id");
assert("registration: commitment mismatch denied", confirmRegistration({ eventId: "d036-settle-five", accountId: "alice.testnet", registration: regView, pass: passView, expectedCommitmentId: "other" }).status === "mismatch", "commitment");
assert("registration: owner mismatch denied", confirmRegistration({ eventId: "d036-settle-five", accountId: "bob.testnet", registration: regView, pass: passView }).status === "mismatch", "mismatch");
assert("registration: missing stays pending", confirmRegistration({ eventId: "d036-settle-five", accountId: "alice.testnet", registration: null, pass: null }).status === "pending", "pending");
assert("registration: find scans participant", findRegistrationForAccount([regView], "alice.testnet")?.registration_id === "reg-0", findRegistrationForAccount([regView], "alice.testnet")?.registration_id);
assert("registration: foreign event denied", confirmRegistration({ eventId: "other-event", accountId: "alice.testnet", registration: regView, pass: passView }).status === "wrong_event", "wrong_event");

// ---- canonical wallet proof binding ----------------------------------------
const nonce = Uint8Array.from({ length: 32 }, (_, i) => i);
const msg = proof.canonicalProofMessage("alice.testnet", nonce, 1700000000000, 1700000300000);
assert("wallet: canonical binder exact", msg === [
  "ShowStake v2 proof-of-control",
  "domain=showstake.app",
  "network=testnet",
  "purpose=login",
  "account_id=alice.testnet",
  "issued_at_ms=1700000000000",
  "expires_at_ms=1700000300000",
  "nonce=000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
].join("\n"), msg);
assert("wallet: domain bound", proof.APP_DOMAIN === "showstake.app", proof.APP_DOMAIN);

// ---- contract state normalization (CamelCase -> frontend enum) ------------
assert("state: Published -> PUBLISHED", viewsMap.mapContractEventState("Published") === "PUBLISHED", String(viewsMap.mapContractEventState("Published")));
assert("state: Cancelled -> CANCELLED", viewsMap.mapContractEventState("Cancelled") === "CANCELLED", String(viewsMap.mapContractEventState("Cancelled")));
assert("state: RefundOnly -> REFUND_ONLY", viewsMap.mapContractEventState("RefundOnly") === "REFUND_ONLY", String(viewsMap.mapContractEventState("RefundOnly")));
assert("state: AttendanceFinalized -> ATTENDANCE_FINALIZED", viewsMap.mapContractEventState("AttendanceFinalized") === "ATTENDANCE_FINALIZED", String(viewsMap.mapContractEventState("AttendanceFinalized")));
assert("state: Settling -> SETTLING", viewsMap.mapContractEventState("Settling") === "SETTLING", String(viewsMap.mapContractEventState("Settling")));
assert("state: Settled -> SETTLED", viewsMap.mapContractEventState("Settled") === "SETTLED", String(viewsMap.mapContractEventState("Settled")));
assert("state: unknown rejected", viewsMap.mapContractEventState("NotAState") === null && viewsMap.mapContractEventState("SETTLED") === null, "reject");
assert("state: non-string rejected", viewsMap.mapContractEventState(undefined) === null && viewsMap.mapContractEventState(42) === null, "non-string");

// ---- view mapping (atomics preserved, ms -> ISO, CamelCase state normalized)
const ev = viewsMap.mapEventViewToSummary({
  event_id: "d036-settle-five",
  organizer: "host.testnet",
  canonical_ft: config.CANONICAL_FT,
  rules_hash: "x",
  deposit: "6000000",
  capacity: 20,
  reg_open: 1700000000000,
  reg_close: 1700000100000,
  cancel_cutoff: 1700000100000,
  checkin_open: 1700000200000,
  checkin_close: 1700000300000,
  finalize_deadline: 1700086700000,
  policy_version: config.POLICY_VERSION,
  state: "Settled",
  phase: "Settled",
  active_registrations: 20,
  total_registrations: 20,
  withdrawn_registrations: 0,
  accepted_principal: "120000000",
  created_at: 1699990000000,
}, { contractId: config.SHOWSTAKE_CONTRACT, assetDecimals: 6, assetSymbol: "SYN" });
assert("view: deposit preserved", ev.depositAtomic === "6000000", ev.depositAtomic);
assert("view: state normalized to frontend enum", ev.state === "SETTLED", ev.state);
assert("view: ms -> ISO", viewsMap.msToIso(1700000000000) === "2023-11-14T22:13:20.000Z", viewsMap.msToIso(1700000000000));
{
  // Unknown state in the raw view fails closed (throws) — never fabricated.
  let threw = null;
  try {
    viewsMap.mapEventViewToSummary({
      event_id: "x",
      organizer: "host.testnet",
      canonical_ft: config.CANONICAL_FT,
      rules_hash: "x",
      deposit: "1",
      capacity: 1,
      reg_open: 1,
      reg_close: 2,
      cancel_cutoff: 2,
      checkin_open: 3,
      checkin_close: 4,
      finalize_deadline: 5,
      policy_version: config.POLICY_VERSION,
      state: "WeirdState",
      phase: "?",
      active_registrations: 0,
      total_registrations: 0,
      withdrawn_registrations: 0,
      accepted_principal: "0",
      created_at: 1,
    }, {});
  } catch (e) {
    threw = e;
  }
  assert("view: unknown state throws (reject at boundary)", threw instanceof Error, threw?.message ?? "no throw");
}

// ---- API envelope mapping + fail-closed freshness --------------------------
const apiEvent = {
  id: "uuid-1",
  network: "testnet",
  contractId: "showstake-settle-endpx.testnet",
  chainEventId: "d036-settle-five",
  state: "SETTLED",
  depositAtomic: "6000000",
  capacity: 20,
  times: {
    regOpen: "2026-01-01T00:00:00Z",
    regClose: "2026-01-02T00:00:00Z",
    cancelCutoff: "2026-01-02T00:00:00Z",
    checkinOpen: "2026-01-02T01:00:00Z",
    checkinClose: "2026-01-02T02:00:00Z",
  },
  title: "Test Event",
  registeredCount: 7,
};
const mapped = api.mapApiEvent(apiEvent);
assert("api: registeredCount -> participantCount", mapped.participantCount === 7, String(mapped.participantCount));
assert("api: chainEventId preserved", mapped.chainEventId === "d036-settle-five", mapped.chainEventId);
assert("api: money stays a string", typeof mapped.depositAtomic === "string", typeof mapped.depositAtomic);

function fakeFetch(body, status = 200) {
  return async () => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
  });
}
{
  const envelope = await api.fetchEventList("/api/v1", fakeFetch({
    data: { items: [apiEvent], nextCursor: null },
    meta: { requestId: "r1", observedAt: "2026-01-01T00:00:00Z", network: "testnet", stale: true },
    error: null,
  }));
  assert("api: stale surfaced", envelope.meta.stale === true, JSON.stringify(envelope.meta));
}
{
  // missing observedAt => fail closed (stale), never defaults false
  const envelope = await api.fetchEventList("/api/v1", fakeFetch({
    data: { items: [], nextCursor: null },
    meta: { requestId: "r2", observedAt: null, network: null, stale: false },
    error: null,
  }));
  assert("api: missing freshness fails closed", envelope.meta.stale === true, JSON.stringify(envelope.meta));
}
{
  // error field present alongside meta => throw (never a silent success)
  let threw = null;
  try {
    await api.fetchEventList("/api/v1", fakeFetch({
      data: null,
      meta: { requestId: "r3", observedAt: "2026-01-01T00:00:00Z", network: null, stale: false },
      error: { code: "PROJECTION_DOWN", message: "worker unavailable", retryable: true },
    }));
  } catch (e) {
    threw = e;
  }
  assert("api: error honored with meta present", threw instanceof api.ApiRequestError && threw.code === "PROJECTION_DOWN" && threw.retryable === true, threw?.code ?? "no throw");
}

// ---- attempt persistence: full-identity key (network+contract+event+account) -
const memStore = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
};
{
  const store = memStore();
  const key = { network: "testnet", contractId: config.SHOWSTAKE_CONTRACT, eventId: "d036-settle-five", accountId: "alice.testnet" };
  const rec = {
    version: 1,
    status: "PREPARED",
    network: "testnet",
    contractId: config.SHOWSTAKE_CONTRACT,
    ftContractId: config.CANONICAL_FT,
    eventId: "d036-settle-five",
    accountId: "alice.testnet",
    amount: "6000000",
    commitmentId: "c1",
    txHash: null,
    at: "2026-01-01T00:00:00.000Z",
  };
  const persisted = attempt.persistAttempt(store, rec);
  assert("attempt: durable write succeeds + read-back", persisted.ok === true, persisted.ok ? "ok" : persisted.reason);
  const storedKey = attempt.attemptStorageKey(key);
  assert("attempt: key binds network+contract+event+account", storedKey.includes("testnet") && storedKey.includes(config.SHOWSTAKE_CONTRACT) && storedKey.includes("d036-settle-five") && storedKey.includes("alice.testnet"), storedKey);
  assert("attempt: key is NOT account+event alone", !storedKey.endsWith(`:alice.testnet:d036-settle-five`) && storedKey !== `showstake:pending:alice.testnet:d036-settle-five`, storedKey);
  assert("attempt: round-trips", attempt.readAttempt(store, key)?.commitmentId === "c1", attempt.readAttempt(store, key)?.commitmentId);
  // A record for a different identity must never be returned (isolation).
  assert("attempt: foreign identity ignored", attempt.readAttempt(store, { ...key, accountId: "bob.testnet" }) === null, "bob");
  assert("attempt: foreign event ignored", attempt.readAttempt(store, { ...key, eventId: "other-event" }) === null, "other event");
  assert("attempt: belongs matches identity", attempt.attemptBelongsTo(rec, key) === true && attempt.attemptBelongsTo(rec, { ...key, contractId: "other.testnet" }) === false, "belongs");
  attempt.clearAttempt(store, key);
  assert("attempt: cleared", attempt.readAttempt(store, key) === null, "clear");
  // A failing storage (throws on setItem) must surface a durable-write failure.
  const failingStore = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => {} };
  const failedPersist = attempt.persistAttempt(failingStore, rec);
  assert("attempt: quota/exception write is NOT silently ok", failedPersist.ok === false, failedPersist.ok ? "ok" : failedPersist.reason);
  assert("attempt: null storage fails closed", attempt.persistAttempt(null, rec).ok === false, "null storage");
}

// ---- attempt boundary: synchronous inflight guard + monotonic generation ----
{
  const b = attempt.createAttemptBoundary();
  assert("boundary: starts idle", b.generation === 0 && b.inflight === false, "idle");
  assert("boundary: first enter succeeds", attempt.enterAttempt(b) === true, "enter1");
  assert("boundary: second enter is synchronously refused", attempt.enterAttempt(b) === false, "double-click guard");
  attempt.exitAttempt(b);
  assert("boundary: re-enters after exit", attempt.enterAttempt(b) === true, "enter-after-exit");
  attempt.exitAttempt(b);
  const gen = attempt.currentGeneration(b);
  attempt.bumpAttemptBoundary(b);
  assert("boundary: bump advances generation", b.generation === gen + 1, String(b.generation));
  assert("boundary: stale generation detected", attempt.isStaleGeneration(b, gen) === true, "stale");
  assert("boundary: current generation not stale", attempt.isStaleGeneration(b, b.generation) === false, "current");
}

// ---- final receiver-receipt verification (hash alone is never a seat) -----
const ftTransferLog = (amt, to) => `EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"alice.testnet","new_owner_id":"${to}","amount":"${amt}"}]}`;
const commitLog = (commitment, amt, eventId) => `EVENT_JSON:{"standard":"showstake","version":"1.0.0","event":"RegistrationCommitted","data":{"event_id":"${eventId}","registration_id":"reg-0","pass_id":"pass-0","participant":"alice.testnet","beneficiary":"alice.testnet","commitment_id":"${commitment}","amount":"${amt}","event_sequence":0,"storage_cost_yocto":"500001"}}`;
const outcome = (tx, receipts) => ({ status: { SuccessValue: "" }, transaction_outcome: tx, receipts_outcome: receipts });
const baseParams = {
  senderId: "alice.testnet",
  ftContractId: config.CANONICAL_FT,
  showstakeContractId: config.SHOWSTAKE_CONTRACT,
  eventId: "d036-settle-five",
  commitmentId: "c1",
  amount: "6000000",
};
{
  const committed = receipt.verifyDepositReceipt({
    ...baseParams,
    txOutcome: outcome(
      { outcome: { executor_id: "alice.testnet", status: { SuccessReceiptId: "r" }, logs: [] } },
      [
        { outcome: { executor_id: config.CANONICAL_FT, status: { SuccessValue: "" }, logs: [ftTransferLog("6000000", config.SHOWSTAKE_CONTRACT)] } },
        { outcome: { executor_id: config.SHOWSTAKE_CONTRACT, status: { SuccessValue: "" }, logs: [commitLog("c1", "6000000", "d036-settle-five")] } },
      ],
    ),
  });
  assert("receipt: committed when RegistrationCommitted matches", committed.status === "committed" && committed.registrationId === "reg-0" && committed.passId === "pass-0", committed.status);
}
{
  const rejected = receipt.verifyDepositReceipt({
    ...baseParams,
    txOutcome: outcome(
      { outcome: { executor_id: "alice.testnet", status: { SuccessReceiptId: "r" }, logs: [] } },
      [
        { outcome: { executor_id: config.CANONICAL_FT, status: { SuccessValue: "" }, logs: [ftTransferLog("6000000", config.SHOWSTAKE_CONTRACT)] } },
        { outcome: { executor_id: config.SHOWSTAKE_CONTRACT, status: { SuccessValue: "" }, logs: ["SHOWSTAKE_REJECT reason=WRONG_AMOUNT amount=99"] } },
      ],
    ),
  });
  assert("receipt: rejected resolver refund means no seat", rejected.status === "rejected" && /no seat/.test(rejected.reason), rejected.status);
}
{
  const mismatch = receipt.verifyDepositReceipt({
    ...baseParams,
    txOutcome: outcome(
      { outcome: { executor_id: "alice.testnet", status: { SuccessReceiptId: "r" }, logs: [] } },
      [
        { outcome: { executor_id: config.CANONICAL_FT, status: { SuccessValue: "" }, logs: [ftTransferLog("6000000", config.SHOWSTAKE_CONTRACT)] } },
        { outcome: { executor_id: config.SHOWSTAKE_CONTRACT, status: { SuccessValue: "" }, logs: [commitLog("other", "6000000", "d036-settle-five")] } },
      ],
    ),
  });
  assert("receipt: wrong commitment is a mismatch", mismatch.status === "mismatch", mismatch.status);
}
{
  const wrongAmount = receipt.verifyDepositReceipt({
    ...baseParams,
    txOutcome: outcome(
      { outcome: { executor_id: "alice.testnet", status: { SuccessReceiptId: "r" }, logs: [] } },
      [
        { outcome: { executor_id: config.CANONICAL_FT, status: { SuccessValue: "" }, logs: [ftTransferLog("5999999", config.SHOWSTAKE_CONTRACT)] } },
        { outcome: { executor_id: config.SHOWSTAKE_CONTRACT, status: { SuccessValue: "" }, logs: [commitLog("c1", "5999999", "d036-settle-five")] } },
      ],
    ),
  });
  assert("receipt: transferred amount mismatch rejected", wrongAmount.status === "mismatch", wrongAmount.status);
}
{
  const wrongSender = receipt.verifyDepositReceipt({
    ...baseParams,
    txOutcome: outcome(
      { outcome: { executor_id: "bob.testnet", status: { SuccessReceiptId: "r" }, logs: [] } },
      [],
    ),
  });
  assert("receipt: sender must be the connected account", wrongSender.status === "mismatch", wrongSender.status);
}
{
  const noReceiver = receipt.verifyDepositReceipt({
    ...baseParams,
    txOutcome: outcome(
      { outcome: { executor_id: "alice.testnet", status: { SuccessReceiptId: "r" }, logs: [] } },
      [{ outcome: { executor_id: config.CANONICAL_FT, status: { SuccessValue: "" }, logs: [ftTransferLog("6000000", config.SHOWSTAKE_CONTRACT)] } }],
    ),
  });
  assert("receipt: hash-only (no receiver receipt) is pending", noReceiver.status === "pending", noReceiver.status);
}
{
  const wrapped = receipt.verifyDepositReceipt({
    ...baseParams,
    txOutcome: { final_execution_outcome: outcome(
      { outcome: { executor_id: "alice.testnet", status: { SuccessReceiptId: "r" }, logs: [] } },
      [
        { outcome: { executor_id: config.CANONICAL_FT, status: { SuccessValue: "" }, logs: [ftTransferLog("6000000", config.SHOWSTAKE_CONTRACT)] } },
        { outcome: { executor_id: config.SHOWSTAKE_CONTRACT, status: { SuccessValue: "" }, logs: [commitLog("c1", "6000000", "d036-settle-five")] } },
      ],
    ) },
  });
  assert("receipt: congestion-control wrapper unwrapped", wrapped.status === "committed", wrapped.status);
}
{
  // A FAILED escrow receipt can still carry a RegistrationCommitted log (e.g.
  // gas exhausted after the log); its state writes were rolled back -> NOT a seat.
  const failedEscrow = receipt.verifyDepositReceipt({
    ...baseParams,
    txOutcome: outcome(
      { outcome: { executor_id: "alice.testnet", status: { SuccessReceiptId: "r" }, logs: [] } },
      [
        { outcome: { executor_id: config.CANONICAL_FT, status: { SuccessValue: "" }, logs: [ftTransferLog("6000000", config.SHOWSTAKE_CONTRACT)] } },
        { outcome: { executor_id: config.SHOWSTAKE_CONTRACT, status: { Failure: { ActionError: { index: 0 } } }, logs: [commitLog("c1", "6000000", "d036-settle-five")] } },
      ],
    ),
  });
  assert("receipt: failed escrow with matching commit log is NOT committed", failedEscrow.status === "failed", failedEscrow.status);
}
{
  // An unknown/malformed escrow status must not be trusted even with a matching log.
  const unknownEscrow = receipt.verifyDepositReceipt({
    ...baseParams,
    txOutcome: outcome(
      { outcome: { executor_id: "alice.testnet", status: { SuccessReceiptId: "r" }, logs: [] } },
      [
        { outcome: { executor_id: config.CANONICAL_FT, status: { SuccessValue: "" }, logs: [ftTransferLog("6000000", config.SHOWSTAKE_CONTRACT)] } },
        { outcome: { executor_id: config.SHOWSTAKE_CONTRACT, status: {}, logs: [commitLog("c1", "6000000", "d036-settle-five")] } },
      ],
    ),
  });
  assert("receipt: unknown escrow status stays pending (not trusted)", unknownEscrow.status === "pending", unknownEscrow.status);
}
{
  // Incomplete outcome: the FT receipt succeeded but has no ft_transfer debit log.
  const noDebit = receipt.verifyDepositReceipt({
    ...baseParams,
    txOutcome: outcome(
      { outcome: { executor_id: "alice.testnet", status: { SuccessReceiptId: "r" }, logs: [] } },
      [
        { outcome: { executor_id: config.CANONICAL_FT, status: { SuccessValue: "" }, logs: [] } },
        { outcome: { executor_id: config.SHOWSTAKE_CONTRACT, status: { SuccessValue: "" }, logs: [commitLog("c1", "6000000", "d036-settle-five")] } },
      ],
    ),
  });
  assert("receipt: missing ft_transfer debit is incomplete (pending)", noDebit.status === "pending", noDebit.status);
}
{
  // Action identity: the debit must come from the connected account, not a stranger.
  const strangerTransferLog = `EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"bob.testnet","new_owner_id":"${config.SHOWSTAKE_CONTRACT}","amount":"6000000"}]}`;
  const foreignDebit = receipt.verifyDepositReceipt({
    ...baseParams,
    txOutcome: outcome(
      { outcome: { executor_id: "alice.testnet", status: { SuccessReceiptId: "r" }, logs: [] } },
      [
        { outcome: { executor_id: config.CANONICAL_FT, status: { SuccessValue: "" }, logs: [strangerTransferLog] } },
        { outcome: { executor_id: config.SHOWSTAKE_CONTRACT, status: { SuccessValue: "" }, logs: [commitLog("c1", "6000000", "d036-settle-five")] } },
      ],
    ),
  });
  assert("receipt: ft transfer must debit the connected account", foreignDebit.status === "mismatch", foreignDebit.status);
}

// ---- commit sequencing: durable persist gate + UNKNOWN hash-less submission -
const preparedRec = {
  version: 1,
  status: "PREPARED",
  network: "testnet",
  contractId: config.SHOWSTAKE_CONTRACT,
  ftContractId: config.CANONICAL_FT,
  eventId: "d036-settle-five",
  accountId: "alice.testnet",
  amount: "6000000",
  commitmentId: "c1",
  txHash: null,
  at: "2026-01-01T00:00:00.000Z",
};
{
  // Storage failure: the wallet must never be called (call count 0).
  let signCalls = 0;
  const res = await commitFlow.runCommitSteps({
    prepared: preparedRec,
    sign: async () => {
      signCalls += 1;
      return { ok: true, txHash: "abc", status: null };
    },
    persistPrepared: () => ({ ok: false, reason: "unavailable" }),
    persistSubmitted: (r) => ({ ok: true, record: r }),
  });
  assert("commit: storage failure blocks wallet (call count 0)", res.kind === "persist_failed" && signCalls === 0, `${res.kind}/${signCalls}`);
}
{
  // Wallet ok but hash missing (transient/broadcast unknown): SUBMITTED with null hash, still blocked.
  const res = await commitFlow.runCommitSteps({
    prepared: preparedRec,
    sign: async () => ({ ok: true, txHash: null, status: "pending" }),
    persistPrepared: (r) => ({ ok: true, record: r }),
    persistSubmitted: (r) => ({ ok: true, record: r }),
  });
  assert("commit: submitted-but-hash-missing keeps SUBMITTED + null hash", res.kind === "submitted" && res.record.status === "SUBMITTED" && res.record.txHash === null, `${res.kind}/${res.record.txHash}`);
  assert("commit: hash-missing attempt still blocks a new send", commitFlow.attemptBlocksNewSend(res.record) === true, "blocked");
}
{
  // Wallet rejected (generic error): UNKNOWN -> stays blocked; there is NO reset path.
  const res = await commitFlow.runCommitSteps({
    prepared: preparedRec,
    sign: async () => ({ ok: false, txHash: null, status: null, detail: "user denied or timed out" }),
    persistPrepared: (r) => ({ ok: true, record: r }),
    persistSubmitted: (r) => ({ ok: true, record: r }),
  });
  assert("commit: wallet_rejected stays blocked (no unsafe reset)", res.kind === "wallet_rejected" && commitFlow.attemptBlocksNewSend(res.prepared) === true, `${res.kind}`);
}
{
  assert("commit: no attempt never blocks a new send", commitFlow.attemptBlocksNewSend(null) === false, "null");
}
{
  const res = await commitFlow.runCommitSteps({
    prepared: preparedRec,
    sign: async () => ({ ok: true, txHash: "HASH123", status: "SuccessValue" }),
    persistPrepared: (r) => ({ ok: true, record: r }),
    persistSubmitted: (r) => ({ ok: true, record: r }),
  });
  assert("commit: successful sign persists SUBMITTED + hash", res.kind === "submitted" && res.record.txHash === "HASH123" && res.persisted === true, `${res.kind}`);
}

// ---- explicit OPEN test-event slot (real deployment reference, no fixture) --
assert("slot: real testnet open instance configured", config.OPEN_TEST_EVENT_SLOT?.eventId === "wallet-browser-test" && config.OPEN_TEST_EVENT_SLOT?.contractId === "showstake-event-v2-endpx.testnet" && config.OPEN_TEST_EVENT_SLOT?.canonicalFt === "mockusdc.testnet", "verified deployed slot");
assert("slot: unknown open-test id stays rejected", !config.isAcceptedEvent("d036-open-slot"), "d036-open-slot");
assert("slot: accepted event still resolves", config.acceptedEvent("d036-settle-five")?.contractId === config.SHOWSTAKE_CONTRACT, "settle-five");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.error("Failed:", failures.join(", "));
  process.exit(1);
}
console.log("verify-frontend-slice OK");
