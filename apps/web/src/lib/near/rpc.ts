// Minimal dependency-free read-only NEAR JSON-RPC client.
//
// This calls standard read-only methods only: `query` (view functions and
// account/access-key reads) and `EXPERIMENTAL_tx_status` (final transaction
// outcome for receipt reconciliation). It never signs, never sends, never
// holds a key, and never invents an API route: the methods below are the
// standard NEAR RPC surface.
// Authoritative NEP-413 signature verification stays server-side with
// `near-api-js` `verifyMessage` (packages/wallet-adapter + onboarding probe);
// this module deliberately does NOT reimplement ed25519.

export type RpcResult<T> =
  | { ok: true; value: T; blockHeight: number; blockHash: string; observedAt: string }
  | { ok: false; code: string; message: string };

export interface ViewAccount {
  amount: string;
  block_height: number;
  block_hash: string;
  locked: string;
  storage_usage: number;
  code_hash: string;
  [key: string]: unknown;
}

export interface AccessKeyView {
  nonce: number;
  permission:
    | "FullAccess"
    | { FunctionCall: { allowance: string; receiver_id: string; method_names: string[] } };
  block_height: number;
  block_hash: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function encodeUtf8Base64(value: unknown): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeUtf8Base64(b64: string): string {
  return new TextDecoder().decode(base64ToBytes(b64));
}

async function post(
  rpcUrl: string,
  method: string,
  params: unknown,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "showstake", method, params }),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`NEAR RPC HTTP ${response.status}`);
  }
  return (await response.json()) as unknown;
}

/** Call a contract view function (read-only) and return its decoded JSON value. */
export async function callView<T = unknown>(
  contractId: string,
  methodName: string,
  args: unknown,
  rpcUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RpcResult<T>> {
  try {
    const body = (await post(rpcUrl, "query", {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: methodName,
      args_base64: encodeUtf8Base64(args),
    }, fetchImpl)) as {
      result?: { result?: number[]; block_height?: number; block_hash?: string };
      error?: { code?: unknown; message?: unknown; data?: unknown };
    };
    if (body.error) {
      const message = typeof body.error.message === "string" ? body.error.message : "RPC error";
      const code = body.error.data && typeof body.error.data === "object" && typeof (body.error.data as { name?: unknown }).name === "string"
        ? String((body.error.data as { name: string }).name)
        : String(body.error.code ?? "RPC_ERROR");
      return { ok: false, code, message };
    }
    const result = body.result?.result;
    if (!Array.isArray(result)) {
      return { ok: false, code: "RPC_NO_RESULT", message: "view returned no result bytes" };
    }
    const bytes = Uint8Array.from(result);
    const value = JSON.parse(new TextDecoder().decode(bytes)) as T;
    return {
      ok: true,
      value,
      blockHeight: body.result?.block_height ?? 0,
      blockHash: body.result?.block_hash ?? "",
      observedAt: new Date().toISOString(),
    };
  } catch (error) {
    return { ok: false, code: "RPC_UNAVAILABLE", message: String((error as Error)?.message ?? error) };
  }
}

/** Read-only NEAR account view (balance/storage/block freshness). */
export async function viewAccountView(
  accountId: string,
  rpcUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RpcResult<ViewAccount>> {
  try {
    const body = (await post(rpcUrl, "query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    }, fetchImpl)) as { result?: ViewAccount; error?: { message?: unknown } };
    if (body.error) {
      return { ok: false, code: "RPC_UNAVAILABLE", message: String(body.error.message ?? "RPC error") };
    }
    if (!body.result) return { ok: false, code: "RPC_NO_RESULT", message: "no account result" };
    return {
      ok: true,
      value: body.result,
      blockHeight: body.result.block_height,
      blockHash: body.result.block_hash,
      observedAt: new Date().toISOString(),
    };
  } catch (error) {
    return { ok: false, code: "RPC_UNAVAILABLE", message: String((error as Error)?.message ?? error) };
  }
}

/**
 * Read-only access-key view. A `FullAccess` key is surfaced purely for
 * transparency ("this key may sign"); it is NOT proof-of-identity and must not
 * be presented as a verified session.
 */
export async function viewAccessKeyView(
  accountId: string,
  publicKey: string,
  rpcUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RpcResult<AccessKeyView>> {
  try {
    const body = (await post(rpcUrl, "query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: accountId,
      public_key: publicKey,
    }, fetchImpl)) as { result?: AccessKeyView; error?: { message?: unknown } };
    if (body.error) {
      return { ok: false, code: "ACCESS_KEY_NOT_FOUND", message: String(body.error.message ?? "RPC error") };
    }
    if (!body.result) return { ok: false, code: "RPC_NO_RESULT", message: "no access key result" };
    return {
      ok: true,
      value: body.result,
      blockHeight: body.result.block_height,
      blockHash: body.result.block_hash,
      observedAt: new Date().toISOString(),
    };
  } catch (error) {
    return { ok: false, code: "RPC_UNAVAILABLE", message: String((error as Error)?.message ?? error) };
  }
}

/**
 * Read-only final transaction outcome (`EXPERIMENTAL_tx_status`). This is what
 * lets the UI distinguish a merely-returned wallet hash from a FINAL receiver
 * receipt (`ft_transfer_call` -> ShowStake `ft_on_transfer` ->
 * `RegistrationCommitted`). It never mutates anything; an unknown hash or an
 * unavailable node surfaces `ok:false` and the caller fails closed (pending).
 */
export async function transactionStatus(
  txHash: string,
  senderId: string,
  rpcUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RpcResult<unknown>> {
  try {
    const body = (await post(rpcUrl, "EXPERIMENTAL_tx_status", [txHash, senderId], fetchImpl)) as {
      result?: unknown;
      error?: { code?: unknown; message?: unknown; data?: unknown };
    };
    if (body.error) {
      const code =
        body.error.data && typeof body.error.data === "object" && typeof (body.error.data as { name?: unknown }).name === "string"
          ? String((body.error.data as { name: string }).name)
          : String(body.error.code ?? "TX_STATUS_ERROR");
      const message = typeof body.error.message === "string" ? body.error.message : body.error.code ? String(body.error.code) : "RPC error";
      return { ok: false, code, message };
    }
    if (body.result === undefined || body.result === null) {
      return { ok: false, code: "TX_UNKNOWN", message: "transaction status is not available (not yet final or unknown hash)" };
    }
    return { ok: true, value: body.result, blockHeight: 0, blockHash: "", observedAt: new Date().toISOString() };
  } catch (error) {
    return { ok: false, code: "RPC_UNAVAILABLE", message: String((error as Error)?.message ?? error) };
  }
}