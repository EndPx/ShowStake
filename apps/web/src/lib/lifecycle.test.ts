import assert from "node:assert/strict";
import { canClaim, contentReason, lifecycleReducer, type LifecycleState } from "./lifecycle.ts";

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
console.log("PASS_LOCAL lifecycle state transitions");
