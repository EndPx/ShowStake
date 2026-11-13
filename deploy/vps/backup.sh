#!/usr/bin/env bash
# Local root-only backup; never restores or deletes production data.
set -euo pipefail
set +x
umask 077
[ "$(id -u)" -eq 0 ] || exit 1
identity="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}' showstake-postgres18)"
[ "$identity" = 'showstake-prod|postgres' ] || { echo 'Backup container identity mismatch'; exit 1; }
install -d -m0700 /var/backups/showstake
[ "$(readlink -f /var/backups/showstake)" = /var/backups/showstake ] || exit 1
available_kib="$(df -Pk /var/backups/showstake | awk 'NR==2 {print $4}')"
[ "$available_kib" -ge 2097152 ] || { echo 'Backup requires at least 2GiB free; no managed files were removed'; exit 1; }
run="$(mktemp -d "/var/backups/showstake/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
docker exec showstake-postgres18 sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_dump -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$run/database.dump"
docker exec -i showstake-postgres18 pg_restore --list < "$run/database.dump" > "$run/archive.list"
tar -C /var/lib/showstake/private -czf "$run/private-content.tar.gz" .
sha256sum "$run/database.dump" "$run/private-content.tar.gz" > "$run/sha256.txt"
printf 'SHOWSTAKE_BACKUP_VERIFIED %s\n' "$(basename "$run")"
