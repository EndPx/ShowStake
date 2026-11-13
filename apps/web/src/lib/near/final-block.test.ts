import assert from "node:assert/strict";
import { finalBlockViews } from "./rpc.ts";
let mismatch = false;
const mock = async (_url: unknown, options?: RequestInit) => {
  const payload = JSON.parse(String(options?.body));
  if (payload.method === "block") return new Response(JSON.stringify({ result: { header: { hash: "final-hash", height: 42 } } }));
  assert.equal(payload.params.block_id, "final-hash");
  if (payload.params.request_type === "view_account") return new Response(JSON.stringify({ result: { block_hash: "final-hash", code_hash: "code" } }));
  return new Response(JSON.stringify({ result: { block_hash: mismatch ? "other" : "final-hash", result: Array.from(new TextEncoder().encode("{}")) } }));
};
assert.equal((await finalBlockViews("contract.near", ["get_config"], "https://rpc.invalid", mock as typeof fetch)).ok, true);
mismatch = true;
assert.equal((await finalBlockViews("contract.near", ["get_config"], "https://rpc.invalid", mock as typeof fetch)).ok, false);
console.log("PASS_LOCAL same final block enforcement");
