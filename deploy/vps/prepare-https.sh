#!/usr/bin/env bash
# One new exact-host HTTP challenge site; existing application sites stay intact.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || exit 1
host="${1:?exact assigned hostname required}"
[[ "$host" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || exit 1
target=/etc/nginx/sites-available/showstake-acme-bootstrap.conf
enabled=/etc/nginx/sites-enabled/showstake-acme-bootstrap.conf
for p in "$target" "$enabled"; do [ ! -e "$p" ] && [ ! -L "$p" ] || { echo 'Challenge site collision'; exit 1; }; done
install -d -m0755 /var/www/showstake-acme
cat > "$target" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $host;
    location ^~ /.well-known/acme-challenge/ { root /var/www/showstake-acme; }
    location / { return 503; }
}
EOF
ln -s "$target" "$enabled"
if ! nginx -t; then unlink "$enabled"; rm -f -- "$target"; exit 1; fi
systemctl reload nginx
certbot certonly --webroot -w /var/www/showstake-acme -d "$host" --cert-name "$host" --non-interactive --agree-tos --register-unsafely-without-email --deploy-hook 'systemctl reload nginx'
test -s "/etc/letsencrypt/live/$host/fullchain.pem"
# This run owns this exact symlink; nginx still serves its old in-memory site
# until the final, tested HTTPS configuration is installed and reloaded.
test "$(readlink "$enabled")" = "$target"
unlink "$enabled"
bash "$(dirname "$0")/install-nginx-site.sh" "$host"
