"use client";

// Registration / deposit panel on the event detail route. Performs REAL,
// separately-approved NEAR Connect transactions on explicit user clicks:
//   1. canonical-FT `storage_deposit` (register the participant's token account)
//   2. ShowStake native-NEAR `storage_deposit` (measured escrow credit)
//   3. the exact NEP-141 `ft_transfer_call` commit
//
// Submission hardening (Codex round-2):
//   * the PREPARED attempt (network/contract/event/account/amount/commitment) is
//     persisted BEFORE the wallet is asked, so a redirect/timeout/close cannot
//     lose it; a denial/unknown outcome keeps the attempt blocked from a fresh
//     send until read-only reconciliation confirms the exact commitment.
//   * the chain clock is re-read before commit and FAILS CLOSED (never trusts
//     client time); FT/native/gas preflight is re-read fresh at commit.
//   * a monotonic boundary (generation + synchronous inflight guard) invalidates
//     A→B→A stale async completions and blocks a second click before React state.
//   * `check` verifies the FINAL receiver receipt (`ft_transfer_call` ->
//     ShowStake `ft_on_transfer` -> `RegistrationCommitted`) for THIS
//     commitment/amount/account/event, then cross-checks the exact pass +
//     registration from the same accepted contract; a returned wallet hash alone
//     is never treated as a seat, and a rejected resolver refund means no seat.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, Circle, CircleX, Info, Loader2, RefreshCw } from "lucide-react";
import type { EventState, EventTimes } from "@/lib/types";
import { NETWORK, RPC_URL, acceptedContract } from "@/lib/config";
import {
  computeDepositPreflight,
  newCommitmentId,
  buildCommitMessage,
  commitMessageToJson,
  type DepositPreflight,
} from "@/lib/deposit";
import {
  buildFtStorageDepositAction,
  buildShowstakeStorageDepositAction,
  buildFtTransferCallAction,
  signParams,
} from "@/lib/near/actions";
import {
  confirmRegistration,
  findRegistrationForAccount,
  type RegistrationConfirmation,
} from "@/lib/registration";
import {
  ftBalanceOf,
  ftStorageBalance,
  getBlockTimestampMs,
  getEvent,
  getPass,
  getRegistration,
  listEventRegistrations,
  mapContractEventState,
  showstakeStorageBalance,
} from "@/lib/near/views";
import { transactionStatus } from "@/lib/near/rpc";
import { verifyDepositReceipt } from "@/lib/near/receipt";
import { signAndSendTransaction } from "@/lib/near/wallet";
import { runCommitSteps, attemptBlocksNewSend } from "@/lib/commit-flow";
import {
  ATTEMPT_SCHEMA_VERSION,
  attemptBelongsTo,
  bumpAttemptBoundary,
  clearAttempt,
  createAttemptBoundary,
  currentGeneration,
  enterAttempt,
  exitAttempt,
  isStaleGeneration,
  persistAttempt,
  readAttempt,
  type AttemptKey,
  type AttemptRecord,
} from "@/lib/attempt";
import { useWallet } from "@/components/wallet/wallet-context";
import { Amount } from "@/components/ui/amount";

interface RegisterPanelProps {
  eventId: string;
  contractId: string;
  ftContractId: string;
  policyVersion: string;
  state: EventState;
  depositAtomic: string;
  capacity: number;
  times: EventTimes;
  assetSymbol?: string;
  assetDecimals?: number;
  registeredCount?: number;
  acceptedPrincipal?: string;
  claimsEnabled?: boolean;
}

type Busy = "ft_storage" | "native_storage" | "deposit" | "refresh" | "check" | null;

export function RegisterPanel(props: RegisterPanelProps) {
  const wallet = useWallet();
  const accountId = wallet.account?.accountId ?? null;
  const accountRef = useRef<string | null>(accountId);
  accountRef.current = accountId;

  const boundaryRef = useRef(createAttemptBoundary());
  const nativeDepositedRef = useRef(false);

  const storage = useMemo(() => (typeof window !== "undefined" ? window.localStorage : null), []);

  const [preflight, setPreflight] = useState<DepositPreflight | null>(null);
  const [escrowFtRegistered, setEscrowFtRegistered] = useState<boolean | null>(null);
  const [nativeStorageCredit, setNativeStorageCredit] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<AttemptRecord | null>(null);
  const [confirmation, setConfirmation] = useState<RegistrationConfirmation | null>(null);
  const [manualHash, setManualHash] = useState("");

  const attemptKey = (account: string): AttemptKey => ({
    network: NETWORK,
    contractId: props.contractId,
    eventId: props.eventId,
    accountId: account,
  });

  /** Clear the persisted attempt ONLY when it still is this exact commitment. */
  const clearAttemptIfCommitmentMatches = useCallback(
    (key: AttemptKey, commitmentId: string) => {
      const currentAttempt = readAttempt(storage, key);
      if (currentAttempt && currentAttempt.commitmentId === commitmentId) {
        clearAttempt(storage, key);
      }
    },
    [storage],
  );

  const refreshPreflight = useCallback(async () => {
    const account = accountRef.current;
    if (!account) return;
    const gen = currentGeneration(boundaryRef.current);
    setBusy("refresh");
    setError(null);
    try {
      const [ev, blockTs] = await Promise.all([
        getEvent(props.contractId, props.eventId, RPC_URL),
        getBlockTimestampMs(props.contractId, RPC_URL),
      ]);
      if (isStaleGeneration(boundaryRef.current, gen) || accountRef.current !== account) return;
      if (!ev.ok) {
        setError(ev.message || "Could not read the event.");
        return;
      }
      if (!blockTs.ok) {
        // Fail closed: the chain clock is authoritative; never fall back to Date.now().
        setPreflight(null);
        setError("Could not read the chain clock. Registration is blocked until the clock can be re-read.");
        return;
      }
      const nowMs = blockTs.value;
      const [myFt, ecFt, balance, snow] = await Promise.all([
        ftStorageBalance(props.ftContractId, account, RPC_URL),
        ftStorageBalance(props.ftContractId, props.contractId, RPC_URL),
        ftBalanceOf(props.ftContractId, account, RPC_URL),
        showstakeStorageBalance(props.contractId, account, RPC_URL),
      ]);
      if (isStaleGeneration(boundaryRef.current, gen) || accountRef.current !== account) return;
      const ftRegistered = myFt.ok ? !!(myFt.value && myFt.value.total !== "0") : null;
      const ftBalanceAtomic = balance.ok ? balance.value : null;
      const escRegistered = ecFt.ok ? !!(ecFt.value && ecFt.value.total !== "0") : null;
      setNativeStorageCredit(snow.ok ? snow.value : null);
      setEscrowFtRegistered(escRegistered);
      setPreflight(
        computeDepositPreflight({
          event: {
            eventId: props.eventId,
            state: mapContractEventState(ev.value.state),
            depositAtomic: ev.value.deposit,
            capacity: ev.value.capacity,
            registeredCount: ev.value.active_registrations,
            regOpen: msIso(ev.value.reg_open),
            regClose: msIso(ev.value.reg_close),
          },
          nowMs,
          ftRegistered,
          ftBalanceAtomic,
          nativeStorageDeposited: nativeDepositedRef.current,
          escrowFtRegistered: escRegistered,
        }),
      );
    } catch (e) {
      if (!isStaleGeneration(boundaryRef.current, gen)) setError(String((e as Error)?.message ?? e));
    } finally {
      if (!isStaleGeneration(boundaryRef.current, gen)) setBusy(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.ftContractId, props.contractId, props.eventId]);

  /** Read-only list scan for THIS account (optionally filtered to a commitment). */
  const scanRegistration = useCallback(
    async (account: string, commitmentId?: string) => {
      for (let page = 0; page < 4; page++) {
        const list = await listEventRegistrations(props.contractId, props.eventId, page * 50, 50, RPC_URL);
        if (!list.ok) break;
        const match = commitmentId
          ? list.value.find((r) => r.participant === account && r.commitment_id === commitmentId)
          : findRegistrationForAccount(list.value, account);
        if (match) return match;
        if (list.value.length < 50) break;
      }
      return null;
    },
    [props.contractId, props.eventId],
  );

  const checkPass = useCallback(
    async (record: AttemptRecord | null) => {
      const account = accountRef.current;
      if (!account || (record && !attemptBelongsTo(record, attemptKey(account)))) return;
      const gen = currentGeneration(boundaryRef.current);
      setBusy("check");
      setError(null);
      try {
        // Cross-check the record only from the accepted contract/event.
        const accepted = acceptedContract(props.contractId);
        if (!accepted || accepted.eventId !== props.eventId) {
          setConfirmation({
            status: "not_found",
            registrationId: "",
            passId: null,
            participant: account,
            beneficiary: account,
            owner: null,
            amount: "",
            attendanceStatus: "",
            financialStatus: "",
            reason: "This contract/event is not an accepted ShowStake deployment.",
          });
          return;
        }

        const confirmFromViews = async (
          registrationId: string,
          passId: string,
          expectCommitmentId: string | undefined,
          expectAmount: string | undefined,
        ) => {
          const [reg, pass] = await Promise.all([
            getRegistration(props.contractId, registrationId, RPC_URL),
            getPass(props.contractId, passId, RPC_URL),
          ]);
          if (isStaleGeneration(boundaryRef.current, gen) || accountRef.current !== account) return;
          const result = confirmRegistration({
            eventId: props.eventId,
            accountId: account,
            contractId: props.contractId,
            network: NETWORK,
            registration: reg.ok ? reg.value : null,
            pass: pass.ok ? pass.value : null,
            committedDepositAtomic: expectAmount,
            expectedCommitmentId: expectCommitmentId,
          });
          setConfirmation(result);
          if (result.status === "confirmed" && expectCommitmentId) {
            clearAttemptIfCommitmentMatches(attemptKey(account), expectCommitmentId);
            setAttempt(null);
          }
        };

        if (!record) {
          // No pending attempt: show whatever registration exists for this account.
          const found = await scanRegistration(account);
          if (!found) {
            setConfirmation({
              status: "pending",
              registrationId: "",
              passId: null,
              participant: account,
              beneficiary: account,
              owner: null,
              amount: "",
              attendanceStatus: "",
              financialStatus: "",
              reason: "No registration found yet. The final ShowStake receiver receipt may not have landed; check again.",
            });
            return;
          }
          await confirmFromViews(found.registration_id, found.pass_id, undefined, undefined);
          return;
        }

        if (record.txHash) {
          // Authoritative FINAL receipt check — a hash alone is never a seat.
          const status = await transactionStatus(record.txHash, account, RPC_URL);
          if (isStaleGeneration(boundaryRef.current, gen) || accountRef.current !== account) return;
          if (!status.ok) {
            setConfirmation({
              status: "pending",
              registrationId: "",
              passId: null,
              participant: account,
              beneficiary: account,
              owner: null,
              amount: record.amount,
              attendanceStatus: "",
              financialStatus: "",
              reason: `Receipt status unavailable (${status.message}); the attempt stays blocked and we will not re-deposit.`,
            });
            return;
          }
          const verdict = verifyDepositReceipt({
            txOutcome: status.value,
            senderId: account,
            ftContractId: props.ftContractId,
            showstakeContractId: props.contractId,
            eventId: props.eventId,
            commitmentId: record.commitmentId,
            amount: record.amount,
          });
          if (verdict.status === "committed") {
            await confirmFromViews(verdict.registrationId, verdict.passId, record.commitmentId, record.amount);
          } else if (verdict.status === "rejected") {
            // Resolver refunded: no seat. This is a KNOWN outcome, so the attempt may close.
            setConfirmation({
              status: "not_found",
              registrationId: "",
              passId: null,
              participant: account,
              beneficiary: account,
              owner: null,
              amount: record.amount,
              attendanceStatus: "",
              financialStatus: "",
              reason: verdict.reason,
            });
            clearAttemptIfCommitmentMatches(attemptKey(account), record.commitmentId);
            setAttempt(null);
          } else if (verdict.status === "failed" || verdict.status === "mismatch") {
            setConfirmation({
              status: "mismatch",
              registrationId: "",
              passId: null,
              participant: account,
              beneficiary: account,
              owner: null,
              amount: record.amount,
              attendanceStatus: "",
              financialStatus: "",
              reason: verdict.reason,
            });
            clearAttemptIfCommitmentMatches(attemptKey(account), record.commitmentId);
            setAttempt(null);
          } else {
            setConfirmation({
              status: "pending",
              registrationId: "",
              passId: null,
              participant: account,
              beneficiary: account,
              owner: null,
              amount: record.amount,
              attendanceStatus: "",
              financialStatus: "",
              reason: verdict.reason,
            });
          }
          return;
        }

        // No txHash (e.g. wallet returned without one): read-only scan by commitment.
        const found = await scanRegistration(account, record.commitmentId);
        if (!found) {
          setConfirmation({
            status: "pending",
            registrationId: "",
            passId: null,
            participant: account,
            beneficiary: account,
            owner: null,
            amount: record.amount,
            attendanceStatus: "",
            financialStatus: "",
            reason: "No confirmed registration for this attempt yet; the outcome is unknown and re-deposit stays blocked.",
          });
          return;
        }
        await confirmFromViews(found.registration_id, found.pass_id, record.commitmentId, record.amount);
      } catch (e) {
        if (!isStaleGeneration(boundaryRef.current, gen)) setError(String((e as Error)?.message ?? e));
      } finally {
        if (!isStaleGeneration(boundaryRef.current, gen)) setBusy(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.contractId, props.eventId, props.ftContractId, scanRegistration, clearAttemptIfCommitmentMatches],
  );

  const runApproval = useCallback(
    async (kind: "ft_storage" | "native_storage") => {
      const boundary = boundaryRef.current;
      if (!enterAttempt(boundary)) return; // synchronous double-click guard
      const account = accountRef.current;
      if (!account) {
        exitAttempt(boundary);
        return;
      }
      const gen = currentGeneration(boundary);
      setBusy(kind);
      setError(null);
      try {
        const action =
          kind === "native_storage"
            ? buildShowstakeStorageDepositAction({ accountId: account })
            : buildFtStorageDepositAction({});
        const result = await signAndSendTransaction(
          signParams(NETWORK, account, kind === "native_storage" ? props.contractId : props.ftContractId, [action]),
        );
        if (isStaleGeneration(boundary, gen) || accountRef.current !== account) return;
        if (!result.ok) {
          setBusy(null);
          setError(result.detail);
          return;
        }
        if (kind === "native_storage") {
          nativeDepositedRef.current = true;
        }
        await refreshPreflight();
      } catch (e) {
        if (!isStaleGeneration(boundary, gen)) setError(String((e as Error)?.message ?? e));
      } finally {
        exitAttempt(boundary);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.contractId, props.ftContractId, refreshPreflight],
  );

  const commitDeposit = useCallback(async () => {
    const boundary = boundaryRef.current;
    if (!enterAttempt(boundary)) return; // synchronous double-click guard
    const account = accountRef.current;
    if (!account) {
      exitAttempt(boundary);
      return;
    }
    const gen = currentGeneration(boundary);
    setBusy("refresh");
    setError(null);
    try {
      // 1. Authoritative chain clock + event FIRST (fail closed, no Date.now()).
      const [ev, blockTs] = await Promise.all([
        getEvent(props.contractId, props.eventId, RPC_URL),
        getBlockTimestampMs(props.contractId, RPC_URL),
      ]);
      if (isStaleGeneration(boundary, gen) || accountRef.current !== account) return;
      if (!blockTs.ok) {
        setBusy(null);
        setError("Could not read the chain clock; commit is blocked. Retrying the read is safe and never auto-deposits.");
        return;
      }
      if (!ev.ok) {
        setBusy(null);
        setError(ev.message || "Could not read the event.");
        return;
      }
      const nowMs = blockTs.value;

      // 2. Fresh FT/native/gas preflight at commit (never stale refs; no zero assumptions).
      const [myFt, ecFt, balance, snow] = await Promise.all([
        ftStorageBalance(props.ftContractId, account, RPC_URL),
        ftStorageBalance(props.ftContractId, props.contractId, RPC_URL),
        ftBalanceOf(props.ftContractId, account, RPC_URL),
        showstakeStorageBalance(props.contractId, account, RPC_URL),
      ]);
      if (isStaleGeneration(boundary, gen) || accountRef.current !== account) return;
      const ftRegistered = myFt.ok ? !!(myFt.value && myFt.value.total !== "0") : null;
      const ftBalanceAtomic = balance.ok ? balance.value : null;
      const escRegistered = ecFt.ok ? !!(ecFt.value && ecFt.value.total !== "0") : null;
      const depositAtomic = ev.value.deposit;
      const phase = computeDepositPreflight({
        event: {
          eventId: props.eventId,
          state: mapContractEventState(ev.value.state),
          depositAtomic,
          capacity: ev.value.capacity,
          registeredCount: ev.value.active_registrations,
          regOpen: msIso(ev.value.reg_open),
          regClose: msIso(ev.value.reg_close),
        },
        nowMs,
        ftRegistered,
        ftBalanceAtomic,
        nativeStorageDeposited: nativeDepositedRef.current,
        escrowFtRegistered: escRegistered,
      });
      setNativeStorageCredit(snow.ok ? snow.value : null);
      setEscrowFtRegistered(escRegistered);
      setPreflight(phase);
      if (phase.phase !== "open" || !phase.readyToSign) {
        setBusy(null);
        setError(
          phase.phaseReason ||
            phase.steps.find((s) => s.kind === "action" || s.kind === "unknown")?.detail ||
            "Registration is not open or preflight is incomplete.",
        );
        return;
      }

      // 3. Persist PREPARED durably BEFORE the wallet is asked. `runCommitSteps`
      // guarantees the wallet is not called unless the write + read-back succeed.
      const commitmentId = newCommitmentId();
      const msg = commitMessageToJson(buildCommitMessage(props.eventId, commitmentId));
      const action = buildFtTransferCallAction({
        ftContractId: props.ftContractId,
        showstakeContractId: props.contractId,
        depositAtomic,
        msg,
      });
      const record: AttemptRecord = {
        version: ATTEMPT_SCHEMA_VERSION,
        status: "PREPARED",
        network: NETWORK,
        contractId: props.contractId,
        ftContractId: props.ftContractId,
        eventId: props.eventId,
        accountId: account,
        amount: depositAtomic,
        commitmentId,
        txHash: null,
        at: new Date().toISOString(),
      };
      const persistThat = (r: AttemptRecord) => persistAttempt(storage, r);
      setBusy("deposit");
      const step = await runCommitSteps({
        prepared: record,
        persistPrepared: persistThat,
        persistSubmitted: persistThat,
        sign: () =>
          signAndSendTransaction(signParams(NETWORK, account, props.ftContractId, [action])).then((res) => ({
            ok: res.ok,
            txHash: res.ok ? res.value.transactionHash : null,
            status: res.ok ? res.value.status : null,
            detail: res.ok ? undefined : res.detail,
          })),
      });
      if (isStaleGeneration(boundary, gen) || accountRef.current !== account) return;

      if (step.kind === "persist_failed") {
        setBusy(null);
        setError(
          `Your wallet was NOT asked: the attempt could not be stored durably (${step.reason}). ` +
            "Enable/allow storage and retry — no transaction was created.",
        );
        return;
      }
      if (step.kind === "wallet_rejected") {
        // UNKNOWN outcome: the PREPARED attempt stays blocked; no fresh commitment.
        setAttempt(step.prepared);
        setBusy(null);
        setError(`${step.reason} — the outcome is unknown, so a new deposit is blocked until it is reconciled.`);
        return;
      }
      // submitted (record.txHash may be null -> still UNKNOWN/blocked)
      setAttempt(step.record);
      if (!step.persisted) {
        setError(
          "The submission could not be stored durably; keep the transaction hash before leaving and reconcile now.",
        );
      }
      await checkPass(step.record);
    } catch (e) {
      if (!isStaleGeneration(boundary, gen)) setError(String((e as Error)?.message ?? e));
    } finally {
      exitAttempt(boundary);
      if (!isStaleGeneration(boundary, gen)) setBusy(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.contractId, props.eventId, props.ftContractId, storage, checkPass]);

  // (Re)load read-only facts + reconcile a pending attempt for THIS identity
  // (never auto re-deposit; only a read-only pass/receipt lookup).
  useEffect(() => {
    // Bump the generation FIRST so any in-flight completion from a prior account
    // is stale (A→B→A cannot be accepted by account-equality alone).
    bumpAttemptBoundary(boundaryRef.current);
    accountRef.current = accountId;
    setPreflight(null);
    setConfirmation(null);
    setError(null);
    setAttempt(null);
    setBusy(null);
    nativeDepositedRef.current = false;
    setNativeStorageCredit(null);
    setEscrowFtRegistered(null);
    setManualHash("");
    if (!accountId) return;
    const key = attemptKey(accountId);
    const record = readAttempt(storage, key);
    void refreshPreflight();
    if (record) {
      setAttempt(record);
      void checkPass(record);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, props.eventId, props.contractId, storage]);

  // Manual hash reconciliation for an attempt whose wallet outcome did not carry a
// hash (UNKNOWN). The user supplies the transaction hash their wallet/explorer
// shows; we persist it durably and re-run the read-only receipt check. A wrong
// hash fails closed (pending/mismatch) and can never trigger a deposit.
const reconcileManualHash = useCallback(async () => {
    const account = accountRef.current;
    const hash = manualHash.trim();
    if (!account || !attempt || attempt.txHash !== null || !hash) return;
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(hash)) {
      setError("That does not look like a NEAR transaction hash; paste the exact hash from your wallet/explorer.");
      return;
    }
    const updated: AttemptRecord = { ...attempt, status: "SUBMITTED", txHash: hash, at: new Date().toISOString() };
    const persisted = persistAttempt(storage, updated);
    if (!persisted.ok) {
      setError(`Could not store the reconciliation reference (${persisted.reason}); it was not recorded.`);
      return;
    }
    setAttempt(updated);
    setManualHash("");
    await checkPass(updated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualHash, attempt, storage, checkPass]);

  const isBusy = busy !== null;

  const stepIcon = (step: { kind: string }) => {
    if (step.kind === "ok") return <CheckCircle2 size={16} className="step-ok" />;
    if (step.kind === "action") return <CircleX size={16} className="step-action" />;
    if (step.kind === "blocked") return <CircleX size={16} className="step-blocked" />;
    return <Circle size={16} className="step-unknown" />;
  };

  const phaseCopy = useMemo(() => {
    if (preflight) return preflight;
    if (props.state === "SETTLED") return { phase: "ended", phaseReason: "This event has settled. Registration is closed." } as const;
    if (props.state === "CANCELLED" || props.state === "REFUND_ONLY") return { phase: "ended", phaseReason: "This event has ended. Registration is closed." } as const;
    if (props.state !== "PUBLISHED") return { phase: "closed", phaseReason: "Registration is not open." } as const;
    return null;
  }, [preflight, props.state]);

  const canCommit = preflight?.phase === "open" && preflight.readyToSign && !attemptBlocksNewSend(attempt);
  const canReconcileHash = attempt !== null && attempt.txHash === null;

  return (
    <aside className="register-panel reservation-panel">
      <div className="reservation-panel-heading">
        <strong>{props.state === "SETTLED" ? "Event settled" : "Registration"}</strong>
        <span>
          <Amount value={props.depositAtomic} decimals={props.assetDecimals} symbol={props.assetSymbol} />
          <small> deposit</small>
        </span>
      </div>

      {!accountId && (
        <>
          <p>Connect your NEAR testnet wallet to preflight, register or view your pass.</p>
          <button className="button" onClick={() => void wallet.connect()} disabled={wallet.status === "connecting"}>
            {wallet.status === "connecting" ? "Connecting…" : "Connect wallet"}
          </button>
        </>
      )}

      {accountId && phaseCopy && (
        <p className="register-phase">
          {phaseCopy.phase === "ended" || phaseCopy.phase === "closed" ? phaseCopy.phaseReason : "Registration is open."}
        </p>
      )}

      {accountId && preflight && preflight.phase === "open" && (
        <div className="register-preflight">
          <ul className="register-steps">
            {preflight.steps.map((step) => (
              <li key={step.id} className={`register-step register-step--${step.kind}`}>
                {stepIcon(step)}
                <span>
                  <strong>{step.label}</strong>
                  <small>{step.detail}</small>
                </span>
              </li>
            ))}
          </ul>
          {nativeStorageCredit !== null && (
            <p className="register-note">
              <Info size={13} />
              Current ShowStake storage credit: {nativeStorageCredit} yoctoNEAR. A positive credit is NOT
              treated as sufficient — the exact charge is measured at commit.
            </p>
          )}
          {escrowFtRegistered !== null && (
            <p className="register-note">
              <Info size={13} />
              The escrow contract is {escrowFtRegistered ? "already" : "not"} a registered receiver of the canonical token.
            </p>
          )}
          <div className="register-actions">
            {preflight.steps.find((s) => s.id === "ft_registered")?.kind === "action" && (
              <button className="button" disabled={isBusy} onClick={() => void runApproval("ft_storage")}>
                {busy === "ft_storage" ? <Loader2 size={16} className="spin" /> : "Approve FT storage"}
              </button>
            )}
            {preflight.steps.find((s) => s.id === "native_storage")?.kind === "action" && (
              <button className="button" disabled={isBusy} onClick={() => void runApproval("native_storage")}>
                {busy === "native_storage" ? <Loader2 size={16} className="spin" /> : "Approve native storage"}
              </button>
            )}
            {preflight.steps.find((s) => s.id === "ft_balance")?.kind === "action" && (
              <p className="register-note">
                <Info size={13} /> Your balance must cover the exact deposit; fund it manually (testnet token).
              </p>
            )}
          </div>
        </div>
      )}

      {accountId && (
        <div className="register-commit">
          {preflight?.phase === "open" && (
            <button className="button button--dark" disabled={!canCommit || isBusy} onClick={() => void commitDeposit()}>
              {busy === "refresh" || busy === "deposit" ? <Loader2 size={16} className="spin" /> : <ArrowRight size={16} />}
              {busy === "refresh" ? "Checking phase…" : busy === "deposit" ? "Waiting for wallet…" : "Commit deposit"}
            </button>
          )}
          {attempt && (
            <p className="register-note register-pending">
              <Info size={13} />
              Deposit {attempt.status === "PREPARED" ? "prepared" : "submitted"} — commitment {attempt.commitmentId}
              {attempt.txHash ? `; tx ${attempt.txHash}` : " (no transaction hash yet)"}. The outcome is unknown until
              reconciled read-only; we will not re-deposit automatically and there is no unsafe reset.
            </p>
          )}
          {canReconcileHash && (
            <div className="register-note register-reconcile">
              <Info size={13} /> Wallet broadcast without a captured hash? Paste the transaction hash from your
              wallet/explorer to reconcile it (read-only):
              <input
                className="register-hash-input"
                value={manualHash}
                placeholder="transaction hash"
                onChange={(e) => setManualHash(e.target.value)}
                spellCheck={false}
              />
              <button className="button" disabled={isBusy || !manualHash.trim()} onClick={() => void reconcileManualHash()}>
                {busy === "check" ? <Loader2 size={15} className="spin" /> : "Reconcile hash"}
              </button>
            </div>
          )}
          {error && <p className="form-error">{error}</p>}
          <button className="button" disabled={isBusy} onClick={() => void checkPass(attempt)}>
            {busy === "check" ? <Loader2 size={16} className="spin" /> : <RefreshCw size={15} />}
            Check my registration &amp; pass
          </button>
          {confirmation && (
            <div className={`register-confirm register-confirm--${confirmation.status}`}>
              {confirmation.status === "confirmed" ? (
                <>
                  <strong>Pass confirmed</strong>
                  <code>pass {confirmation.passId}</code>
                  <code>registration {confirmation.registrationId}</code>
                  <code>owner {confirmation.owner}</code>
                  <code>
                    {confirmation.attendanceStatus} · {confirmation.financialStatus} ·{" "}
                    <Amount value={confirmation.amount} decimals={props.assetDecimals} symbol={props.assetSymbol} />
                  </code>
                </>
              ) : (
                <>
                  <strong>{confirmation.status === "pending" ? "Not found yet" : "Not confirmed"}</strong>
                  <span>{confirmation.reason}</span>
                </>
              )}
            </div>
          )}
        </div>
      )}

      <small className="register-disclaimer">
        ShowStake is a NEAR testnet deployment with a synthetic token ({props.ftContractId}). Each approval opens in
        your wallet; nothing is signed unless you confirm, and one-click claims are not offered.
      </small>
    </aside>
  );
}

function msIso(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}