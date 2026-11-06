# packages/domain — shared domain (exact amounts & states)

Framework-agnostic domain vocabulary shared by API/worker/web: exact unsigned-128
atomic money (canonical base-10 **strings** at the JSON boundary, `bigint` only for
internal arithmetic), NEAR account ids, and the state enums that mirror the
database `CHECK (... IN (...))` constraints. No secrets, no network, no provider
code.

- `src/atomic.mjs` — `parseAtomic`/`assertAtomic`/`toAtomicString`/`atomicAdd`/
  `atomicSub`/`U128_MAX`; rejects signs, fractions, leading zeros, JS numbers and
  values above 2^128-1.
- `src/envelope.mjs` — `{data, meta, error}` typed envelope + `isMoneyString`
  (strings only; the OpenAPI `Money` semantic predicate).
- `src/states.mjs` — the state enums (event/registration/payout/funding/checkin/
  job) as a *mirror* of the schema; the database is authoritative.
- `verify.mjs` — self-check; run via `pnpm verify:domain`.

The database `atomic_amount` DOMAIN is the authority for persisted values; this
module is the code enforcement point at every trust boundary.