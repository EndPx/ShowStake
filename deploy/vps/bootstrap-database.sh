#!/usr/bin/env bash
# Operator-run after an audited release is built and isolated postgres is healthy.
set -euo pipefail
set +x
umask 077
[ "$(id -u)" -eq 0 ] || { echo 'Run as root.' >&2; exit 1; }
[ -f /etc/showstake/operator.env ] && [ -f /etc/showstake/compose.env ] || { echo 'Missing isolated credentials.' >&2; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
node=/opt/showstake/tools/node-v24.18.0-linux-x64/bin/node
[ -x "$node" ] && [ -f /opt/showstake/current/migrations/cli.mjs ] || { echo 'Audited release or isolated Node missing.' >&2; exit 1; }
docker compose --env-file /etc/showstake/compose.env -f "$here/compose.yaml" ps --status running --services | grep -qx postgres || { echo 'ShowStake database is not running.' >&2; exit 1; }
expected_image="$(sed -n 's/^SHOWSTAKE_POSTGRES_IMAGE=//p' /etc/showstake/compose.env)"
identity="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}|{{ .Config.Image }}' showstake-postgres18)"
[ "$identity" = "showstake-prod|postgres|$expected_image" ] || { echo 'Container identity mismatch.' >&2; exit 1; }
mount="$(docker inspect -f '{{ range .Mounts }}{{ if eq .Destination "/var/lib/postgresql" }}{{ .Source }}{{ end }}{{ end }}' showstake-postgres18)"
[ "$mount" = /var/lib/showstake/postgres ] || { echo 'Container volume mismatch.' >&2; exit 1; }
health="$(docker inspect -f '{{.State.Health.Status}}' showstake-postgres18)"
[ "$health" = healthy ] || { echo 'ShowStake database is not healthy.' >&2; exit 1; }
. /etc/showstake/operator.env
export DATABASE_URL
[[ "$API_PASSWORD" =~ ^[0-9a-f]{64}$ && "$WORKER_PASSWORD" =~ ^[0-9a-f]{64}$ ]] || { echo 'Invalid stored credentials.' >&2; exit 1; }
"$node" /opt/showstake/current/migrations/cli.mjs up
{
  printf 'BEGIN;\n'
  cat <<'SQL'
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('showstake_api_login','showstake_worker_login')) THEN RAISE EXCEPTION 'service login collision'; END IF; END $$;
SQL
  printf "CREATE ROLE showstake_api_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '%s';\n" "$API_PASSWORD"
  printf "CREATE ROLE showstake_worker_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '%s';\n" "$WORKER_PASSWORD"
  printf 'GRANT showstake_api TO showstake_api_login WITH INHERIT FALSE, SET TRUE;\n'
  printf 'GRANT showstake_worker TO showstake_worker_login WITH INHERIT FALSE, SET TRUE;\n'
  printf 'COMMIT;\n'
} | docker exec -i showstake-postgres18 sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -q -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' > /etc/showstake/role-bootstrap.log 2>&1 || { echo 'Restricted-role bootstrap failed; details retained in root-only /etc/showstake/role-bootstrap.log' >&2; exit 1; }
unset DATABASE_URL API_PASSWORD WORKER_PASSWORD
echo 'Migrations and restricted service logins installed; run the documented role checks before starting services.'
