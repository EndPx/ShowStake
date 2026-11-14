#!/usr/bin/env bash
# Existing ShowStake VPS only; blockchain upgrade proof is independently checked.
set -euo pipefail
set +x
umask 077
test "$#" -ge 1 && test "$#" -le 2
proof=$1
mode=${2:-}
test -z "$mode" || test "$mode" = --apply
node=/opt/showstake/tools/node-v24.18.0-linux-x64/bin/node
helper=$(cd "$(dirname "$0")" && pwd)/activate-shared-profile.mjs
"$node" "$helper" "$proof"
if test -z "$mode";then exit 0;fi
test "$(systemctl is-active showstake-api.service)" = active
backup=$(mktemp -d /etc/showstake/shared-profile-backup-XXXXXX)
cp /etc/showstake/api.env "$backup/api.env"
cp /etc/showstake/worker.env "$backup/worker.env"
docker exec showstake-postgres18 sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_dump -h127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup/database.dump"
docker exec -i showstake-postgres18 pg_restore --list < "$backup/database.dump" > "$backup/database.list"
systemctl stop showstake-worker.service showstake-api.service
rollback(){ code=$?;trap - ERR;cp "$backup/api.env" /etc/showstake/api.env;cp "$backup/worker.env" /etc/showstake/worker.env;chmod 600 /etc/showstake/api.env /etc/showstake/worker.env;systemctl restart showstake-api.service showstake-worker.service;echo 'Profile failed: both env files restored; inspect any new revision row, never reset old cursors' >&2;exit "$code"; }
trap rollback ERR
"$node" "$helper" "$proof" --apply
systemctl restart showstake-api.service showstake-worker.service
ready=0
for _ in $(seq 1 20);do if curl --silent --fail --max-time 3 http://127.0.0.1:3912/health;then ready=1;break;fi;sleep 1;done
test "$ready" = 1
systemctl is-active showstake-api.service showstake-worker.service
trap - ERR
printf '\nVerified shared profile active; no USDC or provider transaction submitted\n'
