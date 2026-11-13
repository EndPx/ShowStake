# ShowStake VPS backend

The reviewed templates were executed on the existing VPS on 2026-11-13. Public
API origin: `https://srv1330754.hstgr.cloud`; frontend: `https://showstake.vercel.app`.
Runtime source release: `aa18ce818275ccb32c2aa7af5a42bafd03b7d6da`. API/worker
are independent keyless systemd services, with seven applied migrations and
PostgreSQL 18.6. Financial, Rhea and factory acceptance remain separate gates.

## Isolation
Use a new isolated PostgreSQL 18 container, Unix identities and service ports; do
not change the existing CommitPass, NabungFi, PostgreSQL 16, global Node/pnpm,
nginx virtual hosts, or unrelated containers. No wallet keys, transaction signer,
funded action or Rhea approval is installed by this deployment.

## Inputs and boundaries

- An independently verified Node **24.18.0 Linux x64** archive and its official
  SHA-256; a reviewed immutable PostgreSQL 18 image reference ending in
  `@sha256:<digest>`. The operator verifies the digest before use.
- A reviewed source commit, copied into a new `/opt/showstake/releases/<id>`;
  the release must contain the workspace lockfile, migration SQL, packages and
  built API/worker `dist`. Keep previous releases for rollback.
- `AUTH_DOMAIN=showstake.app` is the NEP-413 recipient. Browser Origin is
  `https://showstake.vercel.app`; these are intentionally distinct values.
- A verified baseline height for the deployed manual escrow. Before any event
  exists, the operator must independently save final code/config, `get_event`
  null and FT-zero evidence at that height and register the deployment row using
  the migration operator. Never replace or advance an existing cursor to skip
  chain history. No baseline height is guessed here.
- A verified, unused **exact** API hostname and certificate. `nginx.conf.example`
  is not an enabled site; replace only its hostname placeholders. The process
  serves `/health` and `/v1/` on loopback port 3912. No wildcard vhost.

## One-time isolation and database

1. Inspect existing accounts, listeners, Docker resources, nginx vhosts and disk
   headroom. `initialize-isolation.sh` repeats collision checks and refuses to
   overwrite ShowStake accounts, service units, container or ports. An existing
   `/opt/showstake` is accepted only with the unchanged `showstake-vps/1` owner
   marker; existing verified tools there are preserved.
2. Set `SHOWSTAKE_POSTGRES_IMAGE` to the independently verified PostgreSQL 18
   tag-and-digest reference, then run
   `sudo --preserve-env=SHOWSTAKE_POSTGRES_IMAGE,SHOWSTAKE_DOCKER_SUBNET bash deploy/vps/initialize-isolation.sh`.
   `SHOWSTAKE_DOCKER_SUBNET` must be checked
   against every existing Docker subnet and host route first. The deployed subnet
   is `10.253.250.0/28`; global Docker address pools were not modified. It creates separate system users,
   root-only operator/database files, separate service-owned env files, private
   content storage and one persistent random QR key. Secrets are never printed.
   `/var/lib/showstake/postgres` is the only database bind mount, mounted at
   `/var/lib/postgresql` with PGDATA `/var/lib/postgresql/18/docker`. Its owner is
   derived from the pinned image's postgres UID/GID (70:70 for this Alpine image).
   It is separate
   from all existing containers and volumes. Preserve `/etc/showstake` and the
   private directory across releases; rotating the QR key invalidates old QR
   challenges.
3. Load only `/etc/showstake/compose.env` as Compose interpolation input and
   start this project using `docker compose --env-file /etc/showstake/compose.env
   -f deploy/vps/compose.yaml up -d`. Confirm image digest, loopback port 55441,
   container health and volume source before continuing. The Docker postgres
   data directory is persistent; do not use `down -v` as a routine rollback.
4. Install the verified Node archive with `sudo bash deploy/vps/install-node.sh
   /path/to/node-v24.18.0-linux-x64.tar.xz <verified-sha256>`. The script does
   not replace system Node. Install `pnpm@10.21.0` into the isolated prefix
   `/opt/showstake/tools/pnpm` with this Node/npm (never `npm -g`), verify its
   version, and prepend both isolated `bin` directories to PATH for builds.
5. Create the new release directory as `showstake-build`-owned (never chown the
   shared parent or an existing release). As that dedicated non-login user, in
   the new writable isolated release directory run `pnpm install --frozen-lockfile`, then
   `pnpm --filter @showstake/api build` and `pnpm --filter @showstake/worker
   build`. Verify build success and `node --version`/`pnpm --version`; switch
   `/opt/showstake/current` only after the release is complete and reviewed.
6. With the current symlink pointing to that reviewed release, run `sudo bash
   deploy/vps/bootstrap-database.sh`. It runs the existing checksum-aware locked
   migration runner and creates distinct NOINHERIT restricted LOGIN roles; it
   refuses to overwrite existing login roles. API/worker invoke their own
   least-privilege guards on startup. Verify migration status and role grants,
   including API denial of projection writes, worker denial of API-user writes,
   and both service logins lacking superuser/createdb/createrole/replication.
   Connect using env files without putting passwords into command arguments or
   logs. Treat any mismatch as a stop condition.
7. Set `WORKER_START_HEIGHT` in `/etc/showstake/worker.env` to the independently
   approved baseline and verify every pinned deployment field against final RPC.
   The template organizer is the verified current manual-escrow organizer. No
   factory allowlist is enabled, and `RHEA_MICROTEST_APPROVAL_FILE` is blank.

## Service and HTTPS activation

The Node24 archive was checked against the official SHASUMS256 manifest. The
PostgreSQL image is pinned to
`postgres:18.6-alpine@sha256:9ba53c7d41ea093baf5c1ba635ba5434c4f979880527d49bb7d9237d3193085b`.
Permanent reviewed operator scripts are installed root-owned under
`/opt/showstake/ops`; the initial staging copy is retained, not a cleanup target.
Use `prepare-https.sh` only for a new exact-host challenge site; both IPv4 and
IPv6 must route the HTTP challenge when DNS publishes A and AAAA. Existing nginx
sites are preserved, and only a successful `nginx -t` permits reload.

Review env-file ownership and mode (`api.env` and `worker.env` are separate
0600 files). Install only the two named unit files into `/etc/systemd/system`,
run `systemctl daemon-reload`, and start these two units only. Confirm API health
on `127.0.0.1:3912`, worker cursor progress from the approved baseline, and
absence of cross-network projections. A zero-event result is not a funded or
provider acceptance test. Journal errors must not reveal credentials.

After the exact API hostname and certificate exist, review `install-nginx-site.sh`
and install a separately named nginx site only if both its destination and
server name are unused. The script runs `nginx -t` and reloads only on success;
the operator must also assess existing wildcard/default host routing. Do not overwrite a
default site or change unrelated server blocks. Verify HTTPS certificate, exact
Host routing, `/health`, `/v1/mainnet/readiness`, frontend proxy and private
session origin/cookie behavior. Runtime process/HTTP checks are separate from
wallet, Rhea and financial acceptance.

For rollback, stop only `showstake-api` and `showstake-worker`, restore the prior
reviewed release symlink, and restart those units. Preserve the database and
private files; do not assume schema migrations are reversible. Changing DNS,
TLS, firewall, paid resources, factory trust or financial gates requires the
corresponding scoped authorization and independent review.

## RPC and indexing limits

Initial baseline `224310604` was obtained from the official mainnet RPC with the
escrow empty, paused and holding zero USDC. A trusted-source checkpoint match was
then verified independently against the public RPCs used below. No existing
cursor/start height was reset or moved to head. `register-baseline.cjs` deliberately
fails closed if its official RPC is unavailable; pause only the ShowStake worker
and retry after the provider's rate-limit window, or independently review a
checkpoint-verified secondary before changing that operator-only bootstrap.

The deployed API uses `https://free.rpc.fastnear.com`, and the worker uses the
independent `https://rpc.intea.rs`. Both are listed as public/free, non-archival
providers in [NEAR's provider list](https://docs.near.org/api/rpc/providers).
Their numeric public limits are not published. Earlier shared RPC endpoints
returned429 under worker traffic, so API traffic is isolated from the worker's
provider. This is observed configuration, not an uptime or quota guarantee.
Each block still receives canonical/finality checks; unknown gaps do not advance
the cursor. The worker may be catching up; process health does not imply fresh
projections. Do not skip blocks or loosen freshness to make a UI look successful.

## Backup scope

`showstake-backup.timer` runs the root-only `/opt/showstake/ops/backup.sh` daily.
An actual local DB dump and private-content archive were created; `pg_restore
--list` verified archive readability only. These are local backups, not proof of
successful restoration or offsite disaster recovery. `/etc/showstake` credentials
and persistent QR key need a separate operator-controlled encrypted recovery
procedure; never publish them in GitHub, chat, evidence or logs. Backups are not
automatically deleted, and the script stops when less than2GiB is available.
Monitor timer failures and disk capacity; choose retention explicitly before
long-running production use. No restore is performed over the active database.
