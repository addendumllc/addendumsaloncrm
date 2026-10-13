#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 VPS for the CRM. Run on the server, from the app folder:
#   sudo bash deploy/server-setup.sh
# Installs Docker, opens only SSH + web ports, adds swap (builds need memory) and nightly database backups.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Installing Docker"
apt-get update
apt-get install -y docker.io docker-compose-v2 ufw
systemctl enable --now docker

echo "==> Firewall: SSH, HTTP, HTTPS only"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

if ! swapon --show | grep -q /swapfile; then
  echo "==> Adding 2 GB swap"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Nightly database backup at 3:15, kept 14 days, in $APP_DIR/backups"
mkdir -p "$APP_DIR/backups"
cat > /etc/cron.d/addendum-backup <<EOF
15 3 * * * root cd $APP_DIR && docker compose exec -T db pg_dump -U addendum addendum | gzip > backups/addendum-\$(date +\%F).sql.gz && find backups -name '*.sql.gz' -mtime +14 -delete
EOF

echo "Done. Start the CRM with: sudo docker compose up -d --build"
