#!/usr/bin/env bash
# Installs one new reviewed exact-host site. Never overwrites an existing vhost.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo 'Run as root.' >&2; exit 1; }
host="${1:?exact API hostname required}"
[[ "$host" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] && [ "${#host}" -le 253 ] || { echo 'Invalid exact hostname.' >&2; exit 1; }
target=/etc/nginx/sites-available/showstake-api.conf
enabled=/etc/nginx/sites-enabled/showstake-api.conf
for p in "$target" "$enabled"; do [ ! -e "$p" ] && [ ! -L "$p" ] || { echo "Site collision: $p" >&2; exit 1; }; done
[ -r "/etc/letsencrypt/live/$host/fullchain.pem" ] && [ -r "/etc/letsencrypt/live/$host/privkey.pem" ] || { echo 'Certificate unavailable.' >&2; exit 1; }
rendered="$(nginx -T 2>/dev/null)" || { echo 'Existing nginx configuration invalid.' >&2; exit 1; }
[[ "$rendered" != *"$host"* ]] || { echo 'Hostname already appears in existing nginx configuration; inspect manually.' >&2; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
sed "s/REPLACE_API_HOST/$host/g" "$here/nginx.conf.example" > "$target"
ln -s "$target" "$enabled"
if ! nginx -t; then rm -f -- "$enabled" "$target"; echo 'New site rejected; only files created by this run were removed.' >&2; exit 1; fi
systemctl reload nginx
echo 'ShowStake exact-host HTTPS site installed; verify certificate and routing independently.'
