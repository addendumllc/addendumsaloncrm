#!/bin/bash
# Double-click to run the Addendum Salon CRM on this Mac. It opens in a new Chrome window.
# Leave this Terminal window open while you work; close it (or press Ctrl+C) to stop the app.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node.js isn't installed yet."
  echo "Install the LTS version from https://nodejs.org, then double-click this file again."
  open "https://nodejs.org/en/download"
  read -r -p "Press Return to close…"
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "This app needs Node.js 20 or newer (you have $(node -v)). Install the LTS version from https://nodejs.org."
  open "https://nodejs.org/en/download"
  read -r -p "Press Return to close…"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run: installing (takes a minute or two)…"
  npm install || { read -r -p "Install failed. Press Return to close…"; exit 1; }
fi

echo ""
echo "Starting Addendum Salon CRM… Chrome will open when it's ready."
npm run dev
