#!/usr/bin/env bash
# Copies every transformation photo from the server to this computer (only new ones after the first time):
#   bash deploy/download-photos.sh <user>@<server IP> [folder]      (default folder: ~/Addendum Transformation Photos)
# Nothing on this computer is ever deleted by it, so it also works as a second backup kept off the server.
# Files are named by their contents (the CRM's storage); for folders by stylist and service with readable names, use
# Transformations -> Download All in the CRM.
set -euo pipefail
TARGET="${1:?usage: bash deploy/download-photos.sh user@server-ip [folder]}"
DEST="${2:-$HOME/Addendum Transformation Photos}"
mkdir -p "$DEST"
rsync -az --exclude /exports/ "$TARGET:addendum-crm/media/" "$DEST/"
echo "Photos are in: $DEST"
