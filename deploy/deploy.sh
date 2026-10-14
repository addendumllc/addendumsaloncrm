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
# The database on the server needs its password (letters and numbers only: it goes inside the database address).
if ! grep -Eq '^POSTGRES_PASSWORD=[A-Za-z0-9]{16,}$' .env; then
  echo "Add a line to .env:  POSTGRES_PASSWORD=<16+ letters and numbers>   (make one with: openssl rand -hex 24)" >&2
  exit 1
fi

# One SSH connection for every step, so the server password is asked for once (not per step).
CTRL_DIR="$(mktemp -d)"
SSH_OPTS="-o ControlMaster=auto -o ControlPath=$CTRL_DIR/cm -o ControlPersist=20m"
cleanup() { ssh $SSH_OPTS -O exit "$TARGET" 2>/dev/null || true; rm -rf "$CTRL_DIR"; }
trap cleanup EXIT

echo "==> Connecting to $TARGET (enter the server password if asked — nothing shows while you type)"
# Some server images come without rsync (the copy tool); install it if needed. sudo may ask for the same password.
ssh $SSH_OPTS -t "$TARGET" 'command -v rsync >/dev/null || { echo "Installing rsync on the server…"; sudo apt-get update -qq && sudo apt-get install -y -qq rsync; }'

echo "==> Copying the CRM to the server"
rsync -az --delete -e "ssh $SSH_OPTS" \
  --exclude node_modules --exclude dist --exclude data --exclude backups \
  --exclude .git --exclude .DS_Store --exclude '*.log' \
  ./ "$TARGET:addendum-crm/"

echo "==> Starting it (the first run installs Docker and takes 5–10 minutes)"
# First run on a fresh server: install Docker, firewall, swap and backups.
ssh $SSH_OPTS -t "$TARGET" 'cd addendum-crm && (command -v docker >/dev/null || sudo bash deploy/server-setup.sh) && sudo docker compose up -d --build && sudo docker image prune -f'
echo "Deployed. Check https://addendumsalon.info/api/health"
