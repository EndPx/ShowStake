// Final receiver-receipt verification for an exact ShowStake deposit attempt.
//
// A transaction hash returned by the wallet is NOT a seat. The seat exists only
// when the ShowStake escrow's `ft_on_transfer` executes against the canonical FT
// and emits a `RegistrationCommitted` event whose `event_id`, `commitment_id`,
// `participant`, `beneficiary` and `amount` match THIS attempt. A rejected
// resolver returns the full amount and grants no seat; an absent/mismatched
// commit is never interpreted as success. Everything here is pure and
// self-contained (no RPC, no DOM) so the Node verification script can drive it
// with injected outcomes.

export interface ParsedCommitLog {
  eventId: string;
  registrationId: string;
  passId: string;
  participant: string;
  beneficiary: string;
  commitmentId: string;
  amount: string;
  eventSequence: number;
}

export interface ParsedFtTransferLog {
  oldOwnerId: string;
  newOwnerId: string;
  amount: string;
}

export type ReceiptVerdict =
  | { status: "committed"; registrationId: string; passId: string; commit: ParsedCommitLog }
  /** The resolver rejected/refunded the deposit — no seat exists. */
  | { status: "rejected"; reason: string }
  /** The receipt exists but does not prove THIS commitment/amount/account/event. */
  | { status: "mismatch"; reason: string }
  /** The transaction or a required receipt failed outright (no seat). */
  | { status: "failed"; reason: string }
  /** Status unavailable or no final receiver receipt yet — reconcile read-only. */
  | { status: "pending"; reason: string };

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** NEAR `ExecutionStatus` serializes as a single-key object. */
export function isSuccessStatus(status: unknown): boolean {
  const o = asObject(status);
  return o !== null && (Object.prototype.hasOwnProperty.call(o, "SuccessValue") || Object.prototype.hasOwnProperty.call(o, "SuccessReceiptId"));
}

export function isFailureStatus(status: unknown): boolean {
  const o = asObject(status);
  return o !== null && Object.prototype.hasOwnProperty.call(o, "Failure");
}

/** Parse every `EVENT_JSON:` log into `{standard, version, event, data}`. */
export function parseEventJsonLogs(logs: string[]): Array<{ standard: string; version: string; event: string; data: unknown }> {
  const out: Array<{ standard: string; version: string; event: string; data: unknown }> = [];
  for (const raw of logs) {
    if (!raw.startsWith("EVENT_JSON:")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice("EVENT_JSON:".length));
    } catch {
      continue; // ignore unparseable (negative paths carry SHOWSTAKE_REJECT instead)
    }
    const o = asObject(parsed);
    if (!o) continue;
    const standard = typeof o["standard"] === "string" ? o["standard"] : "";
    const version = typeof o["version"] === "string" ? o["version"] : "";
    const event = typeof o["event"] === "string" ? o["event"] : "";
    out.push({ standard, version, event, data: o["data"] });
  }
  return out;
}

function str(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** `RegistrationCommitted` logs (showstake/1.0.0) across every receipt log. */
export function parseRegistrationCommittedLogs(logs: string[]): ParsedCommitLog[] {
  const out: ParsedCommitLog[] = [];
  for (const ev of parseEventJsonLogs(logs)) {
    if (ev.standard !== "showstake" || ev.event !== "RegistrationCommitted") continue;
    const data = asObject(ev.data);
    if (!data) continue;
    const eventId = str(data, "event_id");
    const registrationId = str(data, "registration_id");
    const passId = str(data, "pass_id");
    const participant = str(data, "participant");
    const beneficiary = str(data, "beneficiary");
    const commitmentId = str(data, "commitment_id");
    const amount = str(data, "amount");
    const seq = data["event_sequence"];
    if (!eventId || !registrationId || !passId || !participant || !beneficiary || !commitmentId || !amount) continue;
    out.push({
      eventId,
      registrationId,
      passId,
      participant,
      beneficiary,
      commitmentId,
      amount,
      eventSequence: typeof seq === "number" ? seq : Number(seq),
    });
  }
  return out;
}

/** NEP-141 `ft_transfer` log transfers (the array `data` entries). */
export function parseFtTransferLogs(logs: string[]): ParsedFtTransferLog[] {
  const out: ParsedFtTransferLog[] = [];
  for (const ev of parseEventJsonLogs(logs)) {
    if (ev.standard !== "nep141" || ev.event !== "ft_transfer") continue;
    const list = Array.isArray(ev.data) ? ev.data : [ev.data];
    for (const item of list) {
      const o = asObject(item);
      if (!o) continue;
      const oldOwnerId = str(o, "old_owner_id");
      const newOwnerId = str(o, "new_owner_id");
      const amount = str(o, "amount");
      if (oldOwnerId && newOwnerId && amount) out.push({ oldOwnerId, newOwnerId, amount });
    }
  }
  return out;
}

const REJECT_PREFIX = "SHOWSTAKE_REJECT reason=";

/** `SHOWSTAKE_REJECT reason=... amount=...` negative-path evidence. */
export function parseShowstakeRejectReason(logs: string[]): string | null {
  for (const raw of logs) {
    if (!raw.startsWith(REJECT_PREFIX)) continue;
    const rest = raw.slice(REJECT_PREFIX.length);
    const reason = (rest.split(/\s+amount=/)[0] ?? "").trim();
    if (reason) return reason;
  }
  return null;
}

interface NormalizedReceipt {
  executorId: string;
  status: unknown;
  logs: string[];
}

function unwrapFinalOutcome(raw: unknown): Record<string, unknown> | null {
  const o = asObject(raw);
  if (!o) return null;
  const nested = o["final_execution_outcome"];
  const n = asObject(nested);
  return n ?? o;
}

/**
 * Authoritative final-outcome check for THIS attempt. Tolerates both the
 * classic `EXPERIMENTAL_tx_status`/`tx` shape (`{transaction_outcome,
 * receipts_outcome}`) and the congestion-control wrapper
 * (`{final_execution_outcome: {...}}`) by unwrapping either.
 */
export function verifyDepositReceipt(params: {
  txOutcome: unknown;
  senderId: string;
  ftContractId: string;
  showstakeContractId: string;
  eventId: string;
  commitmentId: string;
  amount: string;
}): ReceiptVerdict {
  const outcome = unwrapFinalOutcome(params.txOutcome);
  if (!outcome) return { status: "pending", reason: "transaction outcome shape unrecognized" };

  const top = asObject(outcome["transaction_outcome"]);
  const topOutcome = top ? asObject(top["outcome"]) : null;
  const topStatus = topOutcome ? topOutcome["status"] : outcome["status"];
  const sender = topOutcome && typeof topOutcome["executor_id"] === "string" ? topOutcome["executor_id"] : null;

  if (sender === null) return { status: "pending", reason: "transaction executor is unavailable" };
  if (sender !== params.senderId) return { status: "mismatch", reason: `transaction was signed by ${sender}, not ${params.senderId}` };
  if (isFailureStatus(topStatus)) return { status: "failed", reason: "transaction failed before any receipt executed" };
  if (!isSuccessStatus(topStatus)) return { status: "pending", reason: "transaction outcome is not a confirmed success yet" };

  const receipts: NormalizedReceipt[] = [];
  const rawReceipts = outcome["receipts_outcome"];
  if (Array.isArray(rawReceipts)) {
    for (const r of rawReceipts) {
      const ro = asObject(r);
      const oo = ro ? asObject(ro["outcome"]) : null;
      if (!oo) continue;
      receipts.push({
        executorId: typeof oo["executor_id"] === "string" ? oo["executor_id"] : "",
        status: oo["status"],
        logs: asStringList(oo["logs"]),
      });
    }
  }

  // The FT receipt must be an EXPLICIT success and must debit THIS account to the
  // accepted escrow (action identity: signer -> canonical FT -> escrow).
  const ft = receipts.find((r) => r.executorId === params.ftContractId);
  if (!ft) return { status: "pending", reason: "canonical FT receipt is not available yet" };
  if (isFailureStatus(ft.status)) return { status: "failed", reason: "ft_transfer_call failed on the canonical FT" };
  if (!isSuccessStatus(ft.status)) return { status: "pending", reason: "canonical FT receipt is not a confirmed success yet" };
  const transfers = parseFtTransferLogs(ft.logs);
  const forward = transfers.find((t) => t.oldOwnerId === params.senderId);
  if (!forward) {
    if (transfers.length === 0) return { status: "pending", reason: "no ft_transfer debit from the connected account in the FT receipt (incomplete)" };
    return { status: "mismatch", reason: `the FT receipt does not debit ${params.senderId}` };
  }
  if (forward.newOwnerId !== params.showstakeContractId) {
    return { status: "mismatch", reason: `funds were received by ${forward.newOwnerId}, not the accepted ShowStake escrow` };
  }
  if (forward.amount !== params.amount) {
    return { status: "mismatch", reason: `transferred ${forward.amount}, expected ${params.amount}` };
  }

  // The escrow handler must be an EXPLICIT success BEFORE its commit log is
  // trusted: a failed receipt can still carry a RegistrationCommitted log whose
  // state writes the protocol rolled back (gas exhaustion after the log).
  const escrow = receipts.find((r) => r.executorId === params.showstakeContractId);
  if (!escrow) return { status: "pending", reason: "ShowStake receiver receipt is not available yet" };
  if (isFailureStatus(escrow.status)) return { status: "failed", reason: "ShowStake ft_on_transfer failed (commit writes were rolled back)" };
  if (!isSuccessStatus(escrow.status)) return { status: "pending", reason: "ShowStake receiver status is not a confirmed success yet" };

  const commits = parseRegistrationCommittedLogs(escrow.logs);
  const match = commits.find(
    (c) =>
      c.eventId === params.eventId &&
      c.commitmentId === params.commitmentId &&
      c.participant === params.senderId &&
      c.beneficiary === params.senderId &&
      c.amount === params.amount,
  );
  if (match) return { status: "committed", registrationId: match.registrationId, passId: match.passId, commit: match };

  const reject = parseShowstakeRejectReason(escrow.logs);
  if (reject) return { status: "rejected", reason: `resolver refunded the deposit (${reject}); no seat was granted` };
  if (commits.length > 0) {
    return {
      status: "mismatch",
      reason: `a RegistrationCommitted receipt exists but does not match this commitment/amount/account/event`,
    };
  }
  return { status: "pending", reason: "no final ShowStake receiver receipt has landed yet" };
}