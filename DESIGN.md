# ShowStake — frontend design & CommitPass reuse

## Event-centric app UX (2026-11-14, current)

The user requires the full app to follow CommitPass/Luma interaction quality, using the existing CommitPass-derived primitives rather than a separate finance UI. Mainnet V8 is now deployed; the old CREATE-only direction below is historical.

Current logo palette supersedes the initial rust/orange brand accents: logo navy `#04142b`, logo cyan `#00c5f5`, accessible interactive cyan-blue `#087295` (hover `#065775`), light blue surface `#dcf5fc`, muted navy-gray `#5b6676`, line `#dce3e8`. Canvas and semantic success/error colors remain as defined below. Existing gradient geometry, opacity, animation and landing layout are preserved; only their brand color stops follow the logo palette.

App type uses the existing DM Sans/DM Serif family: event heading48px desktop/36px narrow, section heading20px, body15–16px, controls14px and metadata12–13px. Existing spacing and breakpoint families are retained. Interactive primary on white is5.45:1, primary on soft blue4.81:1, muted on canvas5.53:1, and navy on canvas17.49:1. QR decoding uses pinned `jsqr@1.4.0` (Apache-2.0), dynamically loaded only when camera scanning lacks a native detector; frames never leave the device. This is a functional dependency, not a new instrumentation stack.

- One Connect action connects a NEAR wallet and requests server-verified NEP-413 sign-in automatically when needed. The user approves the message. Concurrent login prompts are deduplicated; rejection leaves a clear explicit retry. Verified server sessions may be restored only for the matching actual wallet/network.
- Internal navigation uses Next Link so wallet/account state survives navigation. The document remains the scroll owner; the existing sticky header and 340px desktop event-cover aside are retained, stacking at the existing narrow breakpoint.
- The event editor reuses CommitPass's large event title, compact schedule rows, editable field dialogs, cover/aside composition and option rows. Draft edits and recovery remain durable. Read-only default artwork is not presented as a saved custom upload.
- Registration has one primary action and an automatic commitment ID. Pass, check-in and claim are shown contextually by final event/registration state. Technical identifiers and manual receipt recovery use progressive disclosure.
- Cross-chain funding is an optional inline payment step within event registration, with distinct NEAR recipient and direct source-EVM wallet connection. It is not a separate navigation destination. Existing supported asset routes remain explicit.
- Supply/redeem are contextual organizer event actions, alongside guests/check-in and results. Standalone Earn/Funding pages redirect to event flows; legacy/internal treasury controls are removed from the public app.
- Reuse the source canvas/ink/muted/line/accent/white tokens and typography. Reused cards, dialogs, buttons and forms share existing 12/16/20/24/32px rhythm. Inputs/selects have labels, keyboard focus and >=44px hit targets; native browser default selects are not left unstyled. Dialogs trap focus, close on Escape and restore their trigger.
- Verify empty/loading/connected/signing/rejected/pending/final/failed/refunded/full/closed/denied states at desktop and390px. Never infer successful payment, registration or payout from a timer or backend flag. No new showcase framework, dev instrumentation or unrelated dependencies is required for this adaptation.

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

## Event appearance controls (2026-11-14)

Reference: user screenshot of the CommitPass create editor and read-only `components/events/{create-event,appearance-editors,page-theme}.tsx`. Restore its square cover button with image icon, 56px Theme row (44px swatch, name, edit icon), and separate 52px Shuffle button below the cover. Reuse the three user-owned CommitPass cover templates as local WebP renditions with source hashes recorded. Theme dialog: Minimal/Aurora/Confetti/Grid previews, accent swatches/custom color, Default/Editorial/Mono title fonts, Light/Dark modes, live preview, Cancel/Escape rollback and explicit Use this theme. Use existing modal focus/return behavior and 44px targets; picker grids become two columns at390px. Default Minimal uses ShowStake navy/cyan and preserves existing gradient geometry; extra patterns apply only when explicitly selected for an event. Landing remains unchanged.

Appearance is public event metadata carried in a versioned `rules_text` envelope within the existing8192-byte bound, including the human-readable rules, normalized appearance and cover choice. Contract fields, timing, funds, receipt verification and storage quote authority remain unchanged. Readers decode only a valid known envelope and otherwise render legacy rules as plain text. No HTML, script/data image URL or CSS string from metadata is executed. Public event/details, Discover and My Events show the saved cover; theme applies only to the relevant editor/event route and resets when leaving. Drafts retain the selected look across refresh/account handoff. Custom covers accept HTTPS image URLs, with an explicit notice that they must remain publicly accessible; no upload service is claimed.
