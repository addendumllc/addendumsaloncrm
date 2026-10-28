#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 VPS for the CRM. Run on the server, from the app folder:
#   sudo bash deploy/server-setup.sh
# Installs Docker, opens only SSH + web ports, adds swap (builds need memory) and nightly backups (deploy/backups.sh).
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

bash "$APP_DIR/deploy/backups.sh"

echo "Done. Start the CRM with: sudo docker compose up -d --build"
