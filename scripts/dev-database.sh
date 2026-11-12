#!/usr/bin/env bash
# Dedicated loopback-only development DB; reuses the reviewed PG package helpers.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/postgres-disposable/setup.sh"
DEV_ROOT="/var/tmp/showstake-dev-$(id -u)"
mkdir -p "$DEV_ROOT"
[ "$(readlink -f "$DEV_ROOT")" = "$DEV_ROOT" ] || exit 2
[ "$(stat -c %u "$DEV_ROOT")" = "$(id -u)" ] || exit 2
PGBIN="$DEV_ROOT/extracted/usr/lib/postgresql/18/bin"
if [ ! -x "$PGBIN/postgres" ]; then
  download_extract "$DEV_ROOT" postgresql-18
  download_extract "$DEV_ROOT" postgresql-client-18
  fetch_runtime_libs "$DEV_ROOT"
fi
export LD_LIBRARY_PATH="$DEV_ROOT/extracted/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
mkdir -p "$DEV_ROOT/socket"
if [ ! -f "$DEV_ROOT/data/PG_VERSION" ]; then
  "$PGBIN/initdb" -D "$DEV_ROOT/data" -L "$DEV_ROOT/extracted/usr/share/postgresql/18" -U showstake --auth-local=trust --auth-host=trust --no-locale -E UTF8 > "$DEV_ROOT/initdb.log"
fi
if ! "$PGBIN/pg_ctl" -D "$DEV_ROOT/data" status >/dev/null 2>&1; then
  "$PGBIN/pg_ctl" -D "$DEV_ROOT/data" -l "$DEV_ROOT/server.log" -o "-k $DEV_ROOT/socket -c listen_addresses=127.0.0.1 -p 55440" -w start
fi
if [ "$("$PGBIN/psql" -h "$DEV_ROOT/socket" -p 55440 -U showstake -d postgres -Atc "SELECT count(*) FROM pg_database WHERE datname='showstake_dev'")" = 0 ]; then
  "$PGBIN/psql" -h "$DEV_ROOT/socket" -p 55440 -U showstake -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE showstake_dev'
fi
echo 'Development database ready on loopback port 55440; database showstake_dev.'
if [ "$("$PGBIN/psql" -h "$DEV_ROOT/socket" -p 55440 -U showstake -d showstake_dev -Atc "SELECT count(*) FROM pg_roles WHERE rolname IN ('showstake_api','showstake_worker')")" = 2 ]; then
  "$PGBIN/psql" -h "$DEV_ROOT/socket" -p 55440 -U showstake -d showstake_dev -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='showstake_dev_api') THEN
  CREATE ROLE showstake_dev_api LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='showstake_dev_worker') THEN
  CREATE ROLE showstake_dev_worker LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
END $$;
GRANT showstake_api TO showstake_dev_api WITH INHERIT FALSE, SET TRUE;
GRANT showstake_worker TO showstake_dev_worker WITH INHERIT FALSE, SET TRUE;
SQL
else
  echo 'Apply migrations with the local operator URL, then rerun this script to create restricted service logins.'
fi
echo "Data retained at $DEV_ROOT. Stop only this cluster with pg_ctl -D $DEV_ROOT/data stop."
