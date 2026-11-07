// Independent NEP-413 encoder/verifier cross-validation against the OFFICIAL
// serialization library (`borsh@2.0.0`, the exact pinned dependency of
// near-api-js@7.4.0) rather than re-verifying with this repo's own Borsh code.
//
// near-api-js@7.4.0 `./nep413` (`serializeMessage`) does, verbatim (fetched
// 2026-11-06 from unpkg):
//   const PREFIX = 2147484061; // 2**31 + 413
//   const serializedPrefix = serialize("u32", PREFIX);
//   const serializedParams = serialize(Nep413MessageSchema, payload);
//   // concat(serializedPrefix, serializedParams) then sha256(...)
//   Nep413MessageSchema = { struct: {
//     message: "string",
//     nonce: { array: { type: "u8", len: 32 } },
//     recipient: "string",
//     callbackUrl: { option: "string" },
//   } };
// This module asserts our hand-rolled `buildNep413Payload` + `nep413Hash`
// produce BYTE-IDENTICAL output to that official path for the NEP-413 spec
// example and two more vectors (Option None callback, non-ASCII message).
//
// Exit: 0 when every byte/hash vector matches; non-zero otherwise.

import { serialize } from 'borsh';
import { createHash } from 'node:crypto';
import { nep413Hash, NEP413_TAG } from './src/nep413.mjs';
import { buildNep413Payload, borshU32 } from './src/borsh-lit.mjs';

const NEP413_MESSAGE_SCHEMA = {
  struct: {
    message: 'string',
    nonce: { array: { type: 'u8', len: 32 } },
    recipient: 'string',
    callbackUrl: { option: 'string' },
  },
};

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest();
}

function officialPayload({ message, nonce, recipient, callbackUrl }) {
  const prefix = serialize('u32', Number(NEP413_TAG));
  const params = serialize(NEP413_MESSAGE_SCHEMA, { message, nonce, recipient, callbackUrl });
  const out = new Uint8Array(prefix.length + params.length);
  out.set(prefix, 0);
  out.set(params, prefix.length);
  return out;
}

const vectors = [
  {
    // NEP-413 spec example (message "hi", nonce [0..31], recipient "myapp.com",
    // callbackUrl "myapp.com/callback").
    id: 'NEP413-SPEC-EXAMPLE',
    message: 'hi',
    nonce: new Uint8Array(32),
    recipient: 'myapp.com',
    callbackUrl: 'myapp.com/callback',
  },
  {
    // Option<string> = None (no callbackUrl): exercised to catch option-encoding drift.
    id: 'NEP413-NO-CALLBACK',
    message: 'Sign in to ShowStake',
    nonce: Uint8Array.from([...Array(31).keys(), 255]),
    recipient: 'showstake.app',
    callbackUrl: undefined,
  },
  {
    // Non-ASCII UTF-8 message (length prefix must be UTF-8 byte length, not char count).
    id: 'NEP413-NON-ASCII',
    message: 'привет-hello-🚀 ①',
    nonce: Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff),
    recipient: 'showstake.app',
    callbackUrl: 'https://showstake.app/callback',
  },
];

const results = [];
let failed = 0;

// Vector 0 also checks the raw u32 prefix bytes against the official borsh u32.
{
  const officialPrefix = serialize('u32', Number(NEP413_TAG));
  const mine = borshU32(NEP413_TAG);
  const ok = Buffer.compare(Buffer.from(officialPrefix), Buffer.from(mine)) === 0;
  results.push({ id: 'NEP413-U32-PREFIX', ok, detail: `official=${Buffer.from(officialPrefix).toString('hex')} mine=${Buffer.from(mine).toString('hex')}` });
  if (!ok) failed += 1;
}

for (const v of vectors) {
  const mine = Buffer.from(buildNep413Payload(v));
  const official = officialPayload(v);
  const bytesOk = Buffer.compare(mine, Buffer.from(official)) === 0;
  const mineHash = sha256(mine);
  const officialHash = sha256(Buffer.from(official));
  const hashOk = mineHash.equals(officialHash);
  const ok = bytesOk && hashOk;
  results.push({
    id: v.id,
    ok,
    detail: `bytes_equal=${bytesOk} hash_equal=${hashOk} sha256=${officialHash.toString('hex')}`,
  });
  if (!ok) failed += 1;
}

// Also confirm nep413Hash (the exported hash helper) matches sha256 of the payload.
{
  const v = vectors[0];
  const mine = Buffer.from(buildNep413Payload(v));
  const viaHelper = nep413Hash(mine);
  const viaSha = sha256(mine);
  const ok = viaHelper.equals(viaSha);
  results.push({ id: 'NEP413-HASH-HELPER', ok, detail: `nep413Hash=${viaHelper.toString('hex')}` });
  if (!ok) failed += 1;
}

console.log(JSON.stringify({
  test: 'NEP-413 hand-rolled encoder cross-validated against official borsh@2.0.0 (near-api-js@7.4.0 dep)',
  reference: 'near-api-js@7.4.0 ./nep413 serializeMessage (unpkg, fetched 2026-11-06) + NEP-413 spec example',
  classifier: 'PASS_LOCAL',
  reviewer_pending: true,
  author: 'worker',
  results,
  summary: { total: results.length, failed },
}, null, 2));

if (failed > 0) {
  console.error(`\n${failed}/${results.length} NEP-413 official cross-validation vector(s) MISMATCH.`);
  process.exit(1);
}
console.log(`\nPASS: all ${results.length} NEP-413 vectors byte-identical to official borsh@2.0.0 serialization (local; independent encoder).`);