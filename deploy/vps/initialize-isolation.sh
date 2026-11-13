#!/usr/bin/env bash
# Operator-run only. Creates ShowStake-specific accounts, paths and secrets once.
set -euo pipefail
set +x
umask 077
[ "$(id -u)" -eq 0 ] || { echo 'Run as root.' >&2; exit 1; }
image="${SHOWSTAKE_POSTGRES_IMAGE:-}"
subnet="${SHOWSTAKE_DOCKER_SUBNET:-}"
[[ "$subnet" =~ ^([0-9]{1,3}[.]){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || { echo 'Provide a verified non-overlapping IPv4 subnet.' >&2; exit 1; }
[[ "$image" =~ ^postgres:18([.][0-9]+)?(-alpine)?@sha256:[0-9a-f]{64}$ ]] || { echo 'Provide postgres 18 image pinned by digest.' >&2; exit 1; }
for cmd in docker ss openssl useradd install; do command -v "$cmd" >/dev/null || { echo "Missing $cmd" >&2; exit 1; }; done
docker compose version >/dev/null
create_opt=false
if [ -e /opt/showstake ] || [ -L /opt/showstake ]; then
  [ -d /opt/showstake ] && [ ! -L /opt/showstake ] && [ -f /opt/showstake/.showstake-owner ] && [ ! -L /opt/showstake/.showstake-owner ] && [ "$(cat /opt/showstake/.showstake-owner)" = 'showstake-vps/1' ] || { echo 'Existing /opt/showstake lacks the approved ownership marker.' >&2; exit 1; }
else
  create_opt=true
fi
for path in /etc/showstake /var/lib/showstake /etc/systemd/system/showstake-api.service /etc/systemd/system/showstake-worker.service; do
  [ ! -e "$path" ] && [ ! -L "$path" ] || { echo "Collision: $path" >&2; exit 1; }
done
for user in showstake-api showstake-worker; do ! getent passwd "$user" >/dev/null || { echo "User exists: $user" >&2; exit 1; }; done
if ss -H -ltn '( sport = :55441 or sport = :3912 )' | grep -q .; then echo 'Required port already in use.' >&2; exit 1; fi
if docker inspect showstake-postgres18 >/dev/null 2>&1; then echo 'Container name already in use.' >&2; exit 1; fi
if docker network inspect showstake-prod_default >/dev/null 2>&1 || [ -n "$(docker ps -aq --filter label=com.docker.compose.project=showstake-prod)" ]; then echo 'Compose project or network already exists.' >&2; exit 1; fi
for path in /opt/showstake/releases /opt/showstake/tools; do [ ! -L "$path" ] || { echo "Symlink rejected: $path" >&2; exit 1; }; [ ! -e "$path" ] || [ -d "$path" ] || { echo "Path collision: $path" >&2; exit 1; }; done
if [ "$create_opt" = true ]; then install -d -m 0755 /opt/showstake; printf '%s\n' 'showstake-vps/1' > /opt/showstake/.showstake-owner; chmod 0644 /opt/showstake/.showstake-owner; fi
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin showstake-api
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin showstake-worker
for path in /opt/showstake/releases /opt/showstake/tools; do [ -d "$path" ] || install -d -m 0755 "$path"; done
install -d -m 0755 /var/lib/showstake
install -d -m 0711 /etc/showstake
install -d -m 0700 /var/lib/showstake/postgres
pg_uid="$(docker run --rm --network none --entrypoint id "$image" -u postgres)"
pg_gid="$(docker run --rm --network none --entrypoint id "$image" -g postgres)"
[[ "$pg_uid" =~ ^[0-9]+$ && "$pg_gid" =~ ^[0-9]+$ ]] || { echo 'Invalid pinned image postgres identity.' >&2; exit 1; }
chown "$pg_uid:$pg_gid" /var/lib/showstake/postgres
install -d -o showstake-api -g showstake-api -m 0700 /var/lib/showstake/private
operator_password="$(openssl rand -hex 32)"
api_password="$(openssl rand -hex 32)"
worker_password="$(openssl rand -hex 32)"
qr_secret="$(openssl rand -hex 32)"
printf 'POSTGRES_USER=showstake_operator\nPOSTGRES_DB=showstake\nPOSTGRES_PASSWORD=%s\n' "$operator_password" > /etc/showstake/postgres.env
printf 'SHOWSTAKE_POSTGRES_IMAGE=%s\n' "$image" > /etc/showstake/compose.env
printf 'SHOWSTAKE_DOCKER_SUBNET=%s\n' "$subnet" >> /etc/showstake/compose.env
printf 'DATABASE_URL=postgresql://showstake_operator:%s@127.0.0.1:55441/showstake\nAPI_PASSWORD=%s\nWORKER_PASSWORD=%s\n' "$operator_password" "$api_password" "$worker_password" > /etc/showstake/operator.env
here="$(cd "$(dirname "$0")" && pwd)"
{ cat "$here/api.env.example" | sed '/^DATABASE_URL=/d; /^QR_HMAC_KEY=/d'; printf 'DATABASE_URL=postgresql://showstake_api_login:%s@127.0.0.1:55441/showstake\nQR_HMAC_KEY=%s\n' "$api_password" "$qr_secret"; } > /etc/showstake/api.env
{ cat "$here/worker.env.example" | sed '/^DATABASE_URL=/d'; printf 'DATABASE_URL=postgresql://showstake_worker_login:%s@127.0.0.1:55441/showstake\n' "$worker_password"; } > /etc/showstake/worker.env
chown showstake-api:showstake-api /etc/showstake/api.env
chown showstake-worker:showstake-worker /etc/showstake/worker.env
chmod 0600 /etc/showstake/*.env
unset operator_password api_password worker_password qr_secret
echo 'ShowStake isolation initialized. Worker start height remains an explicit placeholder.'
