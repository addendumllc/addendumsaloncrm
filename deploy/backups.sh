#!/usr/bin/env bash
# Nightly backups on the server (installed on setup and again on every deploy, so changes here take effect):
#   3:15  the database  -> backups/addendum-YYYY-MM-DD.sql.gz (14 days kept)
#   3:30  the photos    -> backups/media, a full copy of addendum-crm/media (temporary download ZIPs left out).
#         A photo deleted in the CRM leaves the copy too, but is first moved to backups/media-deleted/<date> and kept
#         there 30 days, so a mistaken delete can still be recovered.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$APP_DIR/backups/media" "$APP_DIR/backups/media-deleted" "$APP_DIR/media"
command -v rsync >/dev/null || { apt-get update -qq && apt-get install -y -qq rsync; }
cat > /etc/cron.d/addendum-backup <<CRON
15 3 * * * root cd $APP_DIR && docker compose exec -T db pg_dump -U addendum addendum | gzip > backups/addendum-\$(date +\%F).sql.gz && find backups -maxdepth 1 -name '*.sql.gz' -mtime +14 -delete
30 3 * * * root cd $APP_DIR && rsync -a --delete --exclude /exports/ --backup --backup-dir=$APP_DIR/backups/media-deleted/\$(date +\%F) media/ backups/media/ && find backups/media-deleted -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
CRON
echo "==> Nightly backups: database 3:15 (14 days), photos 3:30 into $APP_DIR/backups/media (deleted photos kept 30 days)"
