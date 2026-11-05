# ShowStake design system v1

## Direction

Warm, practical event product. Event imagery and typography lead; money rules remain readable. Light theme only initially. Cream canvas, white surfaces, dark forest text, burnt-orange primary action. Avoid finance-terminal dashboards, glowing gradients, glass effects and fake live activity. Logo not yet chosen: use text wordmark ShowStake; do not borrow Keyfolio key artwork.

Implementation source: `tokens.css`. All product colors, spacing, radii and motion reference tokens; no ad-hoc hex values in components. Typography: locally bundled Inter if its package/license verified, system sans fallback. Financial amounts use tabular numerals. Icons one installed consistent outline set,20px/1.75stroke. No decorative icon-only critical actions.

## Token contract

| Group | Values |
|---|---|
| Canvas/surface | #F7F5F0 / #FFFFFF |
| Text/muted | #19231D / #5B645E |
| Primary/hover | #B33A1B / #912B13, white text |
| Secondary action | White surface, dark text, strong border |
| Success | #245C3E on #E8F2EB |
| Warning | #7A4A00 on #FFF2D6 |
| Error | #A12622 on #FCECEB |
| Focus | #1D4ED8,3px outline,2px offset |
| Border decorative/control | #DCDDD6 / #78837A |
| Type |12/16 label,14/20 body-sm,16/24 body,20/28 title-sm,24/32 section,32/40 heading,48/52 hero |
| Spacing |4,8,12,16,20,24,32,40,48,64px |
| Radius |8 input,12 card,20 feature panel,999 badge |
| Motion |120ms feedback,180ms disclosure; reduced-motion0ms |

Normal text target WCAG AA4.5:1, large text3:1, meaningful control outlines3:1. Decorative separators may be lower contrast but cannot be the only control boundary. Color always paired with status text/icon. Dark mode deferred, not auto-inverted. Contrast checker artifact validates listed pairs; actual UI audited separately.

## Layout

Global max width1200px; main content event detail1120px. Page padding16px mobile,24px tablet,32px desktop. Breakpoints640/1024px. Header64px; mobile56px. Desktop event detail: minmax(0,1fr) +360px RSVP panel,32px gap. <=1023px single column. Cover aspect16:9; mobile header content first, checkout summary below cover. Sticky RSVP starts below header; mobile bottom CTA must reserve height + safe-area inset and never cover error/claim actions.

Dashboard desktop sidebar224px + content, mobile navigation collapses into menu. Tables remain semantic; at mobile use labeled rows or horizontal overflow with instruction, never hide amount/status. Primary controls min44px height. Max form width640px. Do not use placeholder text as field label.

## Components

| Component | Variants/data | States/behavior |
|---|---|---|
| Button | primary/secondary/ghost/danger; sm40/md44/lg48 | Hover,focus,disabled,pending; pending preserves width and announces aria-busy; click idempotent |
| Amount | atomic string,decimals,symbol,approx flag | Exact formatted value; unknown='Unavailable', never0; whole amount copyable |
| StatusBadge | funding/registration/attendance/payout enums | Text + optional icon; no invented combined status |
| EventCard | cover,title,time,venue,deposit,availability | Link entire card with one accessible main link; no autoplay |
| RsvpPanel | rules,phase,account,deposit,fees,action | Branch by authoritative state table below |
| AccountPicker | verified accounts,network,selected | Warn before binding; existing registration cannot silently switch |
| WalletLogin | Google,email,wallet groups | Popup rejection/retry; persist return URL; native NEAR and EVM visibly labeled |
| PaymentProgress | funding attempt state | Actual stages; no fake timer; tx links only known network |
| PassCard | event,owner,status,QR | QR only in allowed state,60s expiry; countdown accessible refresh button |
| Scanner | camera permission/manual option | Permission denied,invalid,expired,used,pending,confirmed distinct |
| RulesSummary | D,cutoff,host attestation,refund | Always visible before payment, expandable details |
| ClaimPanel | principal,bonus,total,payout state | Claim/retry/view receipt; never display sent as paid |
| Dialog | confirm cancel/withdraw/publish | Focus trap,Escape before submission,return focus; irreversible tx pending persisted |
| Toast | success/info/error | Supplement inline result; error never only transient toast |
| ProtectedContent | list and access reason | Closed/eligible/downloading/unavailable; no public href until auth |

Button destructive copy names action: Cancel event / Withdraw registration. No generic Confirm for money action without amount and consequence. On pending wallet prompt, use 'Approve in your wallet'; broadcast 'Transaction submitted'; final 'Registration confirmed'. Source swap success uses 'Funds received — finish registration'.

## RSVP state -> action

| State | Primary CTA | Supporting text |
|---|---|---|
| Logged out | Sign in to reserve | Deposit amount and rules visible |
| Signed in, NEAR unbound | Set up participant account | Explain pass/refund account |
| Open, no registration | Reserve with deposit | Show deposit vs fees, no seat until confirmed |
| Funding pending | View payment progress | No new payment CTA |
| Funds ready | Confirm registration | Display selected NEAR account |
| COMMIT_PENDING | View transaction | 'Waiting for confirmation' |
| COMMITTED before window | View pass | Withdrawal if before cutoff |
| Check-in open | Show check-in QR | Only eligible owner |
| Check-in submitted | View check-in status | Host confirmation pending |
| Attended | View pass | Settlement timeline |
| Claimable | Claim [amount] | Principal+bonus breakdown |
| Payout pending | View claim status | Duplicate action disabled |
| Payout failed | Retry claim | Storage/funds requirement actionable |
| Paid | View receipt | Attendee content if eligible |
| Full/closed/no-show | View event details | No misleading reserve/claim |
| Cancelled/timeout refund | Claim refund | Exact principal and cause |
| Chain data stale | Refresh status | Money action disabled until authoritative check |

## Screen contracts

`/`: upcoming event cards, clear product explanation, create-event action. `/events/:id`: detail+rules+RSVP. `/events/:id/pay/:attempt`: immutable account, route choice, price/fee, progress/recovery. `/passes`: connected account's passes and owner label. `/passes/:id`: QR and status, no transfer button. `/host/events/new`: validated fields and immutable-rules preview. `/host/events/:id`: roster+scan+finalize/cancel, never ordinary participant controls. `/events/:id/results`: totals and personal claim panel. `/events/:id/content`: attended content gate. `/activity`: funding and claims. `/settings/accounts`: verified login/account links; cannot change existing pass owner.

Each screen tested at390x844 and1440x900,200% zoom and keyboard. QR scanner camera test on actual mobile browser; use synthetic camera fixture only for automated parsing test. Logout clears cached private data. Skeletons preserve layout; empty states explain next action. All date labels include timezone; exact deadline visible near withdrawal/finalize controls. No hidden seat reservations.

## Delivery design artifacts

Executor builds a component gallery `/dev/design-system` in local/test mode only, covering every state above. Run contrast script and visual checks, capture screenshots with fixture label. No screenshot is evidence of chain execution. Product designer/Codex accepts token/component consistency, state correctness and accessibility before cosmetic polish. Do not add animated charts or motion without a task requirement.
