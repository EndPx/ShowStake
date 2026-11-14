#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077
[ "$(id -u)" -eq 0 ] || { echo 'root required' >&2; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
node=/opt/showstake/tools/node-v24.18.0-linux-x64/bin/node
image="${SHOWSTAKE_POSTGRES_IMAGE:-}"; subnet="${SHOWSTAKE_DOCKER_SUBNET:-}"; origin="${PREVIEW_ORIGIN:-}"
[[ "$image" =~ ^postgres:18\.6-alpine@sha256:9ba53c7d41ea093baf5c1ba635ba5434c4f979880527d49bb7d9237d3193085b$ ]] || { echo 'verified postgres 18.6 digest required' >&2; exit 1; }
[[ "$subnet" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || { echo 'verified subnet required' >&2; exit 1; }
[[ "$origin" =~ ^https://[a-zA-Z0-9.-]+$ ]] || { echo 'exact HTTPS preview origin required' >&2; exit 1; }
for c in docker ss openssl useradd install; do command -v "$c" >/dev/null; done
docker compose version >/dev/null
docker image inspect "$image" >/dev/null
[ -x "$node" ] && [ -f /opt/showstake-testnet/release/apps/api/dist/index.js ] && [ -f /opt/showstake-testnet/release/apps/worker/dist/cli.js ] && [ -f /opt/showstake-testnet/release/migrations/cli.mjs ] || { echo 'reviewed build or runtime missing' >&2; exit 1; }
[ ! -L /opt/showstake-testnet/release ] && [ "$(realpath /opt/showstake-testnet/release)" = /opt/showstake-testnet/release ] || { echo 'release path must be an independent directory' >&2; exit 1; }
[ "$("$node" --version)" = v24.18.0 ] || { echo 'unexpected Node runtime' >&2; exit 1; }
"$node" -e 'const p=require("/opt/showstake-testnet/release/package.json");if(p.packageManager!=="pnpm@10.21.0")process.exit(1)' || { echo 'unexpected release package manager' >&2; exit 1; }
"$node" "$here/validate.cjs" "$here/deployments.json"
for p in /etc/showstake-testnet /var/lib/showstake-testnet /etc/systemd/system/showstake-testnet-api.service /etc/systemd/system/showstake-testnet-worker.service; do [ ! -e "$p" ] && [ ! -L "$p" ] || { echo "collision: $p" >&2; exit 1; }; done
for u in showstake-testnet-api showstake-testnet-worker; do ! getent passwd "$u" >/dev/null || { echo "user collision: $u" >&2; exit 1; }; done
! ss -H -ltn '( sport = :55442 or sport = :3913 )' | grep -q . || { echo 'port collision' >&2; exit 1; }
! docker inspect showstake-testnet-postgres18 >/dev/null 2>&1 || { echo 'container collision' >&2; exit 1; }
! docker network inspect showstake-testnet_default >/dev/null 2>&1 || { echo 'network collision' >&2; exit 1; }
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=showstake-testnet)" ] || { echo 'project collision' >&2; exit 1; }
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin showstake-testnet-api
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin showstake-testnet-worker
install -d -m 0700 /etc/showstake-testnet /var/lib/showstake-testnet/postgres
install -d -o showstake-testnet-api -g showstake-testnet-api -m 0700 /var/lib/showstake-testnet/private
pg_uid="$(docker run --rm --network none --entrypoint id "$image" -u postgres)"; pg_gid="$(docker run --rm --network none --entrypoint id "$image" -g postgres)"
[[ "$pg_uid:$pg_gid" =~ ^[0-9]+:[0-9]+$ ]] || exit 1
chown "$pg_uid:$pg_gid" /var/lib/showstake-testnet/postgres
op="$(openssl rand -hex 32)"; api="$(openssl rand -hex 32)"; worker="$(openssl rand -hex 32)"; qr="$(openssl rand -hex 32)"
printf 'POSTGRES_USER=showstake_operator\nPOSTGRES_DB=showstake\nPOSTGRES_PASSWORD=%s\n' "$op" > /etc/showstake-testnet/postgres.env
printf 'SHOWSTAKE_POSTGRES_IMAGE=%s\nSHOWSTAKE_DOCKER_SUBNET=%s\n' "$image" "$subnet" > /etc/showstake-testnet/compose.env
printf 'DATABASE_URL=postgresql://showstake_operator:%s@127.0.0.1:55442/showstake\nAPI_PASSWORD=%s\nWORKER_PASSWORD=%s\n' "$op" "$api" "$worker" > /etc/showstake-testnet/operator.env
profile='{"testnet:ss-fac-c1113232934.testnet":{"schema":3,"factoryPolicy":"showstake-factory-atomic-event/3","leafPolicy":"showstake-native-usdc-event/1","leafSha256":"a90cc890fbda1d8e7166697551693de684a264b1a3bc86ff098f59371033514a","leafCodeHash":"CNuCzGqyU6Ypoz8qFtUvHKBESsEmppu4MW93WiZk6Au7","canonicalFt":"mockusdc.testnet","providerAccount":"ss-prov-b1113232402.testnet","providerKind":"MOCK_TESTNET"}}'
{
printf 'HOST=127.0.0.1\nPORT=3913\nAUTH_NETWORK=testnet\nAUTH_DOMAIN=showstake.app\nAUTH_ALLOWED_ORIGINS=%s\nCOOKIE_SECURE=true\nCOOKIE_NAME=showstake_testnet_session\nCOOKIE_SAME_SITE=none\nTRUST_PROXY=true\nDB_ROLE=showstake_api\n' "$origin"
printf 'DATABASE_URL=postgresql://showstake_api_login:%s@127.0.0.1:55442/showstake\nQR_HMAC_KEY=%s\nPRIVATE_CONTENT_DIR=/var/lib/showstake-testnet/private\n' "$api" "$qr"
printf "ACCESS_FACTORY_CODE_HASHES=testnet:ss-fac-c1113232934.testnet=ENvY3jqpnMWnmQEBRjcvQkuJvELYMLkkqTC9wRBPjZ9J\nACCESS_FACTORY_PROFILES='%s'\n" "$profile"
printf 'RPC_TESTNET_URL=https://near-testnet.drpc.org\n'
} > /etc/showstake-testnet/api.env
worker_profile='{"network":"testnet","canonicalFt":"mockusdc.testnet","providerAccount":"ss-prov-b1113232402.testnet","providerKind":"MOCK_TESTNET","factoryId":"ss-fac-c1113232934.testnet","factoryCodeHash":"ENvY3jqpnMWnmQEBRjcvQkuJvELYMLkkqTC9wRBPjZ9J","leafHash":"CNuCzGqyU6Ypoz8qFtUvHKBESsEmppu4MW93WiZk6Au7","leafSha":"a90cc890fbda1d8e7166697551693de684a264b1a3bc86ff098f59371033514a","schemaVersion":3,"factoryPolicy":"showstake-factory-atomic-event/3","leafPolicy":"showstake-native-usdc-event/1"}'
{
printf 'DATABASE_URL=postgresql://showstake_worker_login:%s@127.0.0.1:55442/showstake\n' "$worker"
printf "WORKER_MODE=factory\nWORKER_NETWORK=testnet\nWORKER_ENVIRONMENT=testnet\nWORKER_FACTORY_PROFILE='%s'\n" "$worker_profile"
printf 'WORKER_CONSUMER=showstake-testnet-factory\nWORKER_FACTORY_FROM_INDEX=0\nWORKER_MAX_BLOCKS_PER_RUN=1000\nWORKER_WATCH_INTERVAL_MS=5000\n'
printf 'WORKER_RPC_URL=https://near-testnet.drpc.org\nWORKER_FACTORY_CHILD_BLOCKS=32\nWORKER_FACTORY_CHILD_CONCURRENCY=3\n'
} > /etc/showstake-testnet/worker.env
chmod 0600 /etc/showstake-testnet/*.env
unset op api worker qr
printf '%s\n' 'Isolated files initialized; database and services have not been started.'
