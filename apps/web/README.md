# apps/web — ShowStake web application (Next.js)

Next App Router application reusing the CommitPass frontend shell (read-only
baseline `542273df306a7e5887f1dfcabf1383e78930f579`), adapted to ShowStake tokens
and copy. See `../../DESIGN.md` and `../../docs/frontend-provenance.json`.

## Sliced scope (this increment)

- `/` — landing (hero, walkthrough, host/manifesto/FAQ, native-CSS sample art).
- `/discover` — public catalog wired to the real `/v1/events` projection with
  honest loading / empty / error / stale states. An empty list is only shown when
  the API actually returns one; `meta.stale` (or missing freshness) disables money
  actions and is labelled. Detail links only use a **resolved chain event id**
  (never the API UUID). The API is reached same-origin through a Next rewrite.
- `/events/[eventId]` — public event detail for **accepted** deployments only
  (`d036-settle-five` on `showstake-settle-endpx.testnet`, policy
  `showstake-v2-d036-settle/1`). Reads the contract's read-only views
  (`get_config`, `get_event`, `get_settlement`) and the canonical FT
  (`showstake-ft-endpx.testnet`, 6 decimals) `ft_metadata`. `d036-settle-five` is
  **Settled**, so it shows finished/settlement/claim outcomes, not open
  registration. Unknown ids/deployments fail closed.
- `/events` — personal plans list; a server session is not wired (the wallet
  button connects/signs but that is not a session), shown honestly.
- `/events/new` — event creation unavailable (needs organizer identity + NEAR binding).

### Native NEAR wallet + deposit (testnet)

The shell header exposes **Connect wallet** (`@hot-labs/near-connect@0.12.0`) and
an off-chain **Sign proof** (NEP-413) for account display; verification stays
server-side (`/auth/verify` via `near-api-js@7.4.0` `verifyMessage`; the browser
does not verify ed25519 or bundle near-api-js).

On an **accepted open event**, the detail route's register panel runs a real,
user-clicked, separately-approved flow (each approval is its own wallet prompt):

1. canonical-FT `storage_deposit` (register the participant's token account),
2. ShowStake native-NEAR `storage_deposit` (measured escrow credit),
3. the exact NEP-141 `ft_transfer_call` (`receiver_id` = escrow, exact `amount`,
   versioned `msg` with a fresh `commitment_id`, 1 yoctoNEAR attached),
4. receipt-confirmed pass lookup (`list_event_registrations` →
   `get_registration` + `get_pass`) with contract/network/commitment/amount and
   `pass_id` binding. A positive storage credit is **never** treated as
   sufficient; an unknown reserved-count is **never** defaulted to 0; the chain
   clock/phase is re-read before commit; and a pending submission is reconciled
   (never auto re-deposited) across reload/account change.

The driver here is the NEAR Connect `NearConnector` with JSON-safe
`ConnectorAction`s (`{type:"FunctionCall", params:{methodName,args,gas,deposit}}`)
— no near-api-js in the browser, no hand-rolled transaction, no invalid NEP args.

## Configuration

The browser reaches the API **same-origin**: `next.config.ts` rewrites
`/api/v1/:path*` to a single server-side upstream
(`SHOWSTAKE_API_UPSTREAM_URL`, default `http://127.0.0.1:3001`). The client reads
no `NEXT_PUBLIC_*` env (so nothing needs static inlining), crosses no origin, and
the rewrite is closed (only the one configured upstream, only the `/v1` prefix).

Accepted deployment/contract/FT/policy identities are frozen in
`src/lib/config.ts`; future events require an explicit reviewed entry (no
invented catalogue, no automatic network swap).

> Note: the API projection's `Event` does not yet carry the chain event id, so the
> catalog resolves each accepted deployment's single event id read-only via the
> contract `list_events` (one-event-per-contract v6). Exposing `chainEventId`
> directly in the projection is the cleaner agreed boundary and belongs to the API
> owner (Codex) — not edited here.

## Commands (from the repo root)

```sh
pnpm --filter @showstake/web dev         # http://localhost:3000
pnpm --filter @showstake/web build       # Next production build
pnpm --filter @showstake/web typecheck   # tsc --noEmit
node scripts/verify-frontend-slice.mjs   # behavioral money/u128/state/action/registration/proof/envelope guards
pnpm verify:t08-frontend                 # pre-existing static/timezone/money/status guards
```

### Reproducible local setup

1. Start the backend (API Fastify on **3001**, worker + Postgres) per
   `apps/api` / `apps/worker` READMEs (root `migrations:up` / `verify:api` /
   `verify:worker` suites on a disposable Postgres).
2. Point the rewrite at it (server-side):
   `SHOWSTAKE_API_UPSTREAM_URL=http://127.0.0.1:3001 pnpm --filter @showstake/web dev`.
3. Without the backend, `/discover` shows an explicit retryable error and
   `/events/[eventId]` still reads the real contract views (read-only, freshness
   shown), so state/times/deposit/settlement stay truthful.

## File manifest (this increment, new/adapted under `apps/web/**`)

- `src/lib/config.ts`, `src/lib/api.ts`, `src/lib/catalog.ts`, `src/lib/types.ts`
- `src/lib/deposit.ts`, `src/lib/registration.ts`
- `src/lib/near/{config,proof,rpc,views-map,views,actions,wallet}.ts`
- `src/components/wallet/{wallet-context,wallet-menu}.tsx`
- `src/components/event/{event-detail,register-panel}.tsx`
- `src/app/(platform)/events/[eventId]/page.tsx`
- adapted: `next.config.ts` (same-origin rewrite), `discover-events.tsx`,
  `event-list-card.tsx` (chain-id links only), `platform-shell.tsx`,
  `(platform)/layout.tsx`, `(platform)/platform.css`
- verification: `scripts/verify-frontend-slice.mjs`

## Limits / not run

- Interactive wallet connect/sign/deposit and mobile-return, keyboard, 200%-zoom
  were **NOT_RUN** (need a consenting human wallet). The transaction actions are
  unit-verified for their exact NEP shapes; the live wallet click is Codex/human's
  scoped action.
- **HOT testnet capability is ABSENT/UNPROVEN in the shared NEAR Connect manifest**
  (a known, documented decision) — not an inferred incapability; the connector
  surfaces only wallets that declare testnet support.
- `near-api-js` remains the canonical server-side NEP-413 verifier
  (`packages/wallet-adapter` + onboarding probe) and is intentionally not bundled
  into the browser.
- No key is held, no DB seat/balance/payout write, no real assets/mainnet, no
  automatic retry of an unknown submission, no legacy EVM/Privy path claimed;
  Google/email/EVM scope is retained but not wired.

## Diagnostics (unrelated, preserved)

`onboarding-probe/` is the T02 Vite diagnostic harness, run separately with the
root `dev:t02-harness` / `build:t02-harness` / `verify:t02-*` scripts. It is not
part of this Next.js application and is excluded from its `tsconfig.json`.