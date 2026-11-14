#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077
[ "$(id -u)" -eq 0 ] || exit 1
here="$(cd "$(dirname "$0")" && pwd)"
node=/opt/showstake/tools/node-v24.18.0-linux-x64/bin/node
[ "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}|{{ .State.Health.Status }}' showstake-testnet-postgres18)" = 'showstake-testnet|postgres|healthy' ] || { echo 'TESTNET database identity/health check failed' >&2; exit 1; }
[ "$(docker inspect -f '{{ range .Mounts }}{{ if eq .Destination "/var/lib/postgresql" }}{{ .Source }}{{ end }}{{ end }}' showstake-testnet-postgres18)" = /var/lib/showstake-testnet/postgres ] || { echo 'mount mismatch' >&2; exit 1; }
. /etc/showstake-testnet/operator.env
export DATABASE_URL
[[ "$DATABASE_URL" =~ ^postgresql://showstake_operator:[0-9a-f]{64}@127\.0\.0\.1:55442/showstake$ && "$API_PASSWORD" =~ ^[0-9a-f]{64}$ && "$WORKER_PASSWORD" =~ ^[0-9a-f]{64}$ ]] || exit 1
"$node" /opt/showstake-testnet/release/migrations/cli.mjs up
{
printf 'BEGIN;\n'
printf '%s\n' "DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('showstake_api_login','showstake_worker_login')) THEN RAISE EXCEPTION 'login collision'; END IF; END \$\$;"
printf "CREATE ROLE showstake_api_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '%s';\n" "$API_PASSWORD"
printf "CREATE ROLE showstake_worker_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '%s';\n" "$WORKER_PASSWORD"
printf 'GRANT showstake_api TO showstake_api_login WITH INHERIT FALSE, SET TRUE;\nGRANT showstake_worker TO showstake_worker_login WITH INHERIT FALSE, SET TRUE;\nCOMMIT;\n'
} | docker exec -i showstake-testnet-postgres18 sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -q -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' > /etc/showstake-testnet/bootstrap.log 2>&1 || { echo 'role bootstrap failed; inspect root-only log privately' >&2; exit 1; }
unset DATABASE_URL API_PASSWORD WORKER_PASSWORD
printf '%s\n' 'Migrations and separate restricted logins installed.'
