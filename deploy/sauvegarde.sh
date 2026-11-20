#!/bin/sh
# Sauvegarde quotidienne (heure BACKUP_HOUR, UTC) : base PostgreSQL (format custom, restaurable
# avec pg_restore) et médias (archive tar), BACKUP_KEEP_DAYS jours gardés dans /backups.
# Lancer une sauvegarde tout de suite : docker compose -f compose.prod.yaml exec backup sh /usr/local/bin/sauvegarde.sh now
set -eu

run_backup() {
  stamp=$(date -u +%Y%m%d-%H%M%S)
  pg_dump --format=custom --no-owner --file="/backups/base-$stamp.dump"
  tar -czf "/backups/medias-$stamp.tar.gz" -C /data media
  find /backups -type f -mtime "+${BACKUP_KEEP_DAYS:-14}" -delete
  echo "{\"event\":\"sauvegarde\",\"at\":\"$stamp\",\"base\":\"base-$stamp.dump\",\"medias\":\"medias-$stamp.tar.gz\"}"
}

if [ "${1:-}" = "now" ]; then
  run_backup
  exit 0
fi

while true; do
  if [ "$(date -u +%H)" = "$(printf '%02d' "${BACKUP_HOUR:-3}")" ]; then
    run_backup || echo '{"event":"sauvegarde_en_echec"}'
    sleep 3600
  fi
  sleep 300
done
