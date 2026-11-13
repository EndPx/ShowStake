# ShowStake — frontend design & CommitPass reuse

## Current app direction (2026-11-14)

The user explicitly chose the actual CommitPass app frontend, not a new design.
The read-only source is `../CommitPass Monad/apps/web` at
`542273df306a7e5887f1dfcabf1383e78930f579`. Preserve its editorial event
editor, cover/sidebar composition, compact navigation, event cards and detail
hierarchy. Replace its EVM/Privy/CRE execution with the existing NEAR wallet,
pinned contract reads, exact storage quote and receipt reconciliation.

This section supersedes the initial-slice scope below for app routes. The landing
page stays separate. Within `.platform`, restore the source palette:
canvas `#faf9f6`, ink `#252622`, muted `#686963`, line `#e5e5de`,
accent `#b9462d`, accent-soft `#fae6db`, white `#fff`, green `#315c45`.
The source minimal theme adds three broad radial washes (sky at the top,
accent at bottom-left, mist at right), using `page-theme.tsx`'s 16%, 14%,
and 6% color mixtures with the canvas. These are app surfaces, not new artwork.
Typography follows the source DM Sans / DM Serif Display with system fallbacks.
Brand links use the existing transparent ShowStake wordmark; the same ticket
and check identity is provided as a compact vector mark for mobile and favicon.
Reuse the original CSS measurements and shared controls instead of creating a
second theme. The document owns scrolling; the header is sticky; the create
editor has a cover aside and a shrinking main column, stacked on mobile.

### Shared app primitives and states

- Navigation: source icon/text links, current-page indication, NEAR account menu,
  connected/disconnected/signing/error states and visible keyboard focus.
- Event editor: source cover, title, schedule rows and option rows; validated
  editable fields, inline error and preview state. Artwork is presentation only
  until the frozen ABI accepts cover metadata.
- Event card/detail: source cover and date/location/host hierarchy; loading,
  empty, unavailable and error states never invent registrations or balances.
- Publish panel: exact native storage reservation, gas separate, wallet sign-in,
  submitted/unknown/final-receipt states and durable pending recovery. A quote
  does not imply a transaction and a transaction hash does not imply success.

The frozen mainnet release supports CREATE only. Clearly disclose before any
storage payment that USDC registration and Earn are not enabled. Never enable
deposit, attendance, settlement or claims merely through frontend styling.
Desktop and 390px browser verification must include these same app primitives;
no new showcase framework or development instrumentation is needed.

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
