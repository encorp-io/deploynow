#!/usr/bin/env bash
# Renamed to setup.sh. This stays so existing links and scripts keep working: it runs
# setup.sh without questions, with the same environment variables as before.
#
#   curl -fsSL https://raw.githubusercontent.com/encorp-io/deploynow/main/setup.sh | sudo bash
set -euo pipefail
src="${BASH_SOURCE[0]:-}"
if [ -n "$src" ] && [ -f "$src" ] && [ -f "$(dirname "$src")/setup.sh" ]; then
  exec bash "$(dirname "$src")/setup.sh" --yes "$@"
fi
url="${DEPLOYNOW_SETUP_URL:-https://raw.githubusercontent.com/encorp-io/deploynow/main/setup.sh}"
tmp="$(mktemp)"
curl -fsSL "$url" -o "$tmp"
exec bash "$tmp" --yes "$@"
