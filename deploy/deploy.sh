#!/usr/bin/env bash
# Copies the CRM (including .env) from this computer to the VPS and (re)starts it.
#   bash deploy/deploy.sh <user>@<server IP>
# Use it for the first install and for every update. Data is kept.
set -euo pipefail
TARGET="${1:?usage: bash deploy/deploy.sh user@server-ip}"
cd "$(dirname "$0")/.."

if grep -q 'PASTE_' .env; then
  echo "Fill in the PASTE_… values in .env first." >&2
  exit 1
fi
if ! grep -Eq '^ENCRYPTION_KEY=.{32,}' .env; then
  echo "ENCRYPTION_KEY in .env needs 32+ characters (run: openssl rand -base64 48)." >&2
  exit 1
fi

rsync -az --delete \
  --exclude node_modules --exclude dist --exclude data --exclude backups \
  --exclude .git --exclude .DS_Store --exclude '*.log' \
  ./ "$TARGET:addendum-crm/"

# First run on a fresh server: install Docker, firewall, swap and backups.
ssh -t "$TARGET" 'cd addendum-crm && (command -v docker >/dev/null || sudo bash deploy/server-setup.sh) && sudo docker compose up -d --build && sudo docker image prune -f'
echo "Deployed. Check https://addendumsalon.info/api/health"
