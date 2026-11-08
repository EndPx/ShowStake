# ShowStake — frontend design & reuse notes (first slice)

## Direction

Warm, practical event product, reusing the editorial CommitPass shell rather than
a greenfield redesign (docs/decisions.md D022/D024). The author with a text
wordmark **ShowStake.** leads; illustrative artwork is pure native CSS and is
labelled *sample*. No finance-terminal dashboards, no glowing gradients, no fake
live activity.

The authoritative token contract is `docs/planning/showstake-v2/tokens.css`.
`apps/web/src/app/globals.css` defines those tokens and maps the reused
CommitPass shell variables (`--canvas/--white/--ink/--muted/--line/--accent/
--green/--shadow`) onto them, so the adapted shell keeps its composition and
interaction while carrying ShowStake colour/type/radius/motion.

## First-slice scope

Home/landing, navigation, discovery/list with empty/loading/error states,
timezone formatting, and the chain-independent view primitives those routes need
(`Amount`, `StatusBadge`, `EventCover`, `EventListCard`, state components,
`display-time`/`money`/`events` helpers). Event-management, pass/QR, host and
settlement screens remain tracked for later slices and are **not** wired here.

## Honesty rules (product)

- The discovery catalog is **unavailable** until the ShowStake API is connected;
  the loader returns `{ kind: "unavailable" }` — no fake events/users/counts/balances.
- Amounts are canonical unsigned-128 base-10 strings formatted exactly with
  BigInt (never floats); unknown/invalid amounts render **Unavailable**, never `0`.
- Every time label carries its timezone (`clockLabel`: `HH:mm UTC±hh:mm`).
- No transaction success, no participant pass requirement for the public listing,
  no auth/session/provider readiness is invented.
- Prefers-reduced-motion, `:focus-visible`, and `skip-link` are preserved.

## Responsive & motion

Breakpoints 600/900/1200 inherited from the CommitPass shell; `390×844` and
`1440×900` are the acceptance viewports (not interactively observed in this
execution — recorded `NOT_RUN`). GSAP scroll reveal/pin honours
`prefers-reduced-motion` via `gsap.matchMedia`.

## Reuse & provenance

Reference repository: `CommitPass Monad`, read-only, baseline
`542273df306a7e5887f1dfcabf1383e78930f579`. Per-file origin, source blob SHA256
and changes are in `docs/frontend-provenance.json`. No root LICENSE exists in the
reference; reuse is by explicit human authorization (D022), disclosed rather than
presented as newly authored. No logo/font/generated-image binary or Cloudinary
manifest was imported.

## Dependency & license inventory

| Package | Version | License (verified from installed metadata unless noted) |
|---|---|---|
| next | 15.5.26 | MIT |
| react | 19.1.9 | MIT |
| react-dom | 19.1.9 | MIT |
| lucide-react | 1.48.0 | ISC |
| gsap | 3.15.0 | GreenSock standard "no-charge" license (not MIT; retained per original app's usage) |
| @gsap/react | 2.1.2 | GreenSock standard license |
| typescript | 5.8.3 | Apache-2.0 |
| @types/node / @types/react / @types/react-dom | 22.x / 19.1.17 / 19.1.11 | MIT |

Versions are pinned in `apps/web/package.json`; final license confirmation is
recorded in the T08 build evidence after `pnpm install`.

## Not inherited

viem, @privy-io/react-auth, QR scanner/package, Monad/EVM chain config, gas
sponsorship, Anvil/local fund endpoints, legacy `server-api`, Envio/CRE, yield
behaviour, Cloudinary media transforms, and any `.env`/deployment configuration.