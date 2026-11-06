# packages/api-contract — shared API contract

Provisional `/v1` contract for ShowStake, derived from
`docs/planning/showstake-v2/02-ARCHITECTURE.md` ("API contract"). **Not frozen**
— Codex freezes the ABI after review (T01 acceptance).

- `openapi.yaml` — OpenAPI 3.0.3, 16 baseline paths, 26+ schemas, 5 public routes
  (`security: []`: event list/detail, results, auth challenge, auth verify), host-only
  routes (`/events/{eventId}/checkin-requests` and `/events/{eventId}/attendance`)
  that declare a 403 so a participant can never pass, request bodies + idempotency +
  validation + 4xx/5xx error envelopes for every mutation.
- Money is the `Money` schema (`type: string`, canonical base-10). The `pattern`
  is STRUCTURAL only; the authoritative 2^128-1 ceiling is semantic
  (`packages/domain` BigInt parse + the `atomic_amount` DB domain) and is asserted
  by `scripts/verify-openapi.mjs`.
- Authentication provider is **reopened**: NEAR Auth / HOT Connect first, Privy an
  alternative only. No provider is a final choice here.

Validate the spec (pinned `js-yaml` + `openapi-schema-validator`, reference
resolution, route inventory, permissions, semantic u128):

```sh
pnpm verify:openapi
```