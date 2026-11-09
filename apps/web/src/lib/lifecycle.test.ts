import assert from "node:assert/strict";
import { canClaim, contentReason, lifecycleReducer, walletGate, type LifecycleState } from "./lifecycle.ts";

const base: LifecycleState = { receipt: "idle", eventState: "PUBLISHED", role: "organizer", attendance: "none", claimsEnabled: false, abiConfigured: true, content: "checking" };
assert.equal(lifecycleReducer({ ...base, abiConfigured: false }, { type: "submit" }).receipt, "idle");
assert.equal(lifecycleReducer(base, { type: "submit" }).receipt, "pending");
assert.equal(lifecycleReducer({ ...base, receipt: "pending" }, { type: "receipt_failed", message: "rejected" }).receipt, "failed");
assert.equal(lifecycleReducer({ ...base, receipt: "pending" }, { type: "receipt_stale" }).receipt, "stale");
assert.equal(lifecycleReducer({ ...base, role: "participant" }, { type: "attendance_requested" }).attendance, "none");
const settled = lifecycleReducer({ ...base, receipt: "confirmed" }, { type: "settlement_confirmed" });
assert.equal(canClaim(settled), true);
assert.equal(canClaim({ ...settled, receipt: "stale" }), false);
assert.match(contentReason({ ...settled, attendance: "none", content: "denied" }), /organizer-confirmed attendee/);
assert.equal(contentReason({ ...settled, attendance: "attended", content: "eligible" }), "Attendance and settlement are finalized for this account-bound pass.");
assert.equal(walletGate({ status: "idle", accountId: null, network: "testnet", expectedNetwork: "testnet", proof: false }, "claiming").allowed, false);
assert.match(walletGate({ status: "connected", accountId: "alice.testnet", network: "mainnet", expectedNetwork: "testnet", proof: true }, "claiming").reason, /Wrong network/);
assert.match(walletGate({ status: "error", accountId: "alice.testnet", network: "testnet", expectedNetwork: "testnet", proof: false, error: "User rejected" }, "claiming").reason, /User rejected/);
console.log("PASS_LOCAL lifecycle state transitions");

