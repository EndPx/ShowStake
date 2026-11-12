export interface LifecycleAttempt { account: string; contract: string; event: string; method: string; args: Record<string, unknown>; hash: string | null }
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]));
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every(k => Object.hasOwn(y, k) && equal(x[k], y[k]));
}
function success(s: unknown) { return !!s && typeof s === "object" && ("SuccessValue" in s || "SuccessReceiptId" in s); }
function failure(s: unknown) { return !!s && typeof s === "object" && "Failure" in s; }
export function finalLifecycleReceipt(raw: unknown, a: LifecycleAttempt): "success" | "failed" | "pending" {
  if (!raw || typeof raw !== "object") return "pending";
  const wrap = raw as Record<string, any>; const o = wrap.final_execution_outcome ?? wrap;
  const tx = o.transaction; const call = tx?.actions?.[0]?.FunctionCall;
  if (!a.hash || tx?.hash !== a.hash || tx?.signer_id !== a.account || tx?.receiver_id !== a.contract || tx?.actions?.length !== 1 || call?.method_name !== a.method) return "pending";
  try { if (!equal(JSON.parse(atob(call.args)), a.args)) return "pending"; } catch { return "pending"; }
  if (String(call?.deposit) !== (a.method === "claim" ? "1" : "0")) return "pending";
  if (failure(o.status)) return "failed";
  if (!success(o.status) || !Array.isArray(o.receipts_outcome)) return "pending";
  const receipts = o.receipts_outcome as Array<{ outcome?: { executor_id?: string; status?: unknown } }>;
  if (receipts.some(r => failure(r.outcome?.status))) return "failed";
  return receipts.some(r => r.outcome?.executor_id === a.contract && success(r.outcome?.status)) ? "success" : "pending";
}
