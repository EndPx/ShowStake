# GitHub-connected frontend deployment

Vercel project: `showstake`, account/team `muhammad-meidy-noor-al-barrys-projects`, Hobby plan. Git source is `EndPx/ShowStake`, production branch `main`. Deployments must build that Git source, not an upload of the dirty local workspace.

Project settings: Next.js; root `apps/web`; Node `24.x`; install `pnpm install --frozen-lockfile`; build `pnpm run build`; source files outside root enabled for workspace imports. `NEXT_PUBLIC_SHOWSTAKE_NETWORK=mainnet` is plain public configuration for production/preview. No signing credential, database credential, wallet seed or session secret belongs in the frontend environment.

`apps/web/next.config.ts` traces workspace imports from the monorepo root. The bundled public contract candidate is downloaded automatically and must match full SHA-256 `03076c4a9496e8ae1e6af68c791752d4a7220597942effd0c3a1839a252be9d2`; users do not upload a contract as part of normal creation. Request IDs are managed per wallet/factory, with recovery blocking unknown attempts.

The organizer comes from the connected wallet and the contract's predecessor check. The existing fixed-organizer allocated escrow is an explicit Legacy review option, not a whitelist for the product. Factory, event principal and Rhea financial release gates remain disabled until their separate technical acceptance.

## API boundary

The current API runs locally on loopback port3002. No public hosted API origin has been configured. A Vercel deployment cannot access that computer's loopback. With no `SHOWSTAKE_API_UPSTREAM_URL`, hosted `/api/v1/*` returns explicit `503 BACKEND_UNAVAILABLE`, `data:null`, `meta.stale:true`. It does not invent a session or event and does not attempt a local proxy. This frontend publication is not full hosted backend or mainnet financial acceptance.

When a reviewed public API is deployed, set the server-only `SHOWSTAKE_API_UPSTREAM_URL` to its HTTPS origin, without credentials, path, query or fragment, then rebuild. Configure its secure session cookie, exact frontend allowed Origin and NEP-413 recipient; migrate its production database with an operator role, run its API with the restricted service role and supervise its finalized-receipt worker. These backend resources are not created by this frontend deployment.

## Browser checks

Open `/events/new`, confirm any connected NEAR wallet is the organizer and Legacy is opt-in. Connect opens the mainnet wallet picker; an actual wallet sign-in must be tested separately. Check a 390px viewport for overflow. `/earn` shows the read-only provider inspection and disabled approval controls; `/funding` provides DRY-only quotes. Public publishing must not enable financial gates, show a quote as a transfer, or show a transaction success before canonical final receipt reconciliation.

Factory nonce recovery uses local storage plus pinned factory history. Clearing browser data or using another device does not prove an old unknown transaction is absent. Cross-device no-resend acceptance remains open before opening the factory financial release.
