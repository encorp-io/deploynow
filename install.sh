#!/usr/bin/env bash
# DeployNow installer
#
#   curl -fsSL https://raw.githubusercontent.com/encorp-io/deploynow/main/install.sh | sudo bash
#
# Installs Docker if it is missing, writes /opt/deploynow/{docker-compose.yml,.env}
# with a random AUTH_SECRET and owner password, starts DeployNow and waits until it
# answers. Run it again to upgrade: it keeps .env and pulls the new image.
#
# Settings (environment variables):
#   DEPLOYNOW_DIR      install folder                       (default /opt/deploynow)
#   DEPLOYNOW_TAG      image tag: 2.0.0, latest or edge      (default latest)
#   ADMIN_EMAIL        owner account on first start         (default admin@example.com)
#   ADMIN_PASSWORD     its password, 12+ characters         (default: random, printed once)
#   DEPLOYNOW_URL      public URL, e.g. https://1.2.3.4:9444 (default: this machine's address)
#   INSTALL_DOCKER     "no" to stop instead of installing Docker
#   DEPLOYNOW_NO_START "1" to write the files without starting
set -euo pipefail

REPO="encorp-io/deploynow"
DIR="${DEPLOYNOW_DIR:-/opt/deploynow}"
TAG="${DEPLOYNOW_TAG:-latest}"
RAW="https://raw.githubusercontent.com/${REPO}"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "DeployNow runs on Linux. On a Mac or Windows, use a Linux VM or server."
if [ "$(id -u)" -ne 0 ]; then
  # Piped into bash there is no file to re-run, so ask for sudo instead
  [ -f "$0" ] && command -v sudo >/dev/null 2>&1 && exec sudo -E bash "$0" "$@"
  die "Run this as root, e.g. curl -fsSL $RAW/main/install.sh | sudo bash"
fi
command -v curl >/dev/null 2>&1 || die "curl is required."

case "$(uname -m)" in
  x86_64|amd64|aarch64|arm64) ;;
  *) die "Unsupported CPU $(uname -m): images are built for amd64 and arm64." ;;
esac

# ── Docker ─────────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  [ "${INSTALL_DOCKER:-yes}" = "no" ] && die "Docker is not installed. Install it (https://docs.docker.com/engine/install/) and run this again."
  say "Installing Docker with get.docker.com"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker >/dev/null 2>&1 || true
fi
docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start it (systemctl start docker) and run this again."
docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is missing. Install docker-compose-plugin and run this again."

# ── Files ──────────────────────────────────────────────────────────────────────
mkdir -p "$DIR"
cd "$DIR"

# The compose file of the release being installed; main for latest/edge
case "$TAG" in
  latest|edge) REF="main" ;;
  v*) REF="$TAG" ;;
  *) REF="v$TAG" ;;
esac
if [ -f docker-compose.yml ]; then
  say "Keeping your docker-compose.yml"
else
  say "Downloading docker-compose.yml ($REF)"
  curl -fsSL "$RAW/$REF/docker-compose.yml" -o docker-compose.yml || die "Couldn't download docker-compose.yml for $REF"
fi

set_env() { # set_env KEY VALUE: add or replace a line in .env
  if grep -q "^$1=" .env 2>/dev/null; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}

FIRST_INSTALL=0
PASSWORD=""
if [ -f .env ]; then
  say "Upgrading the DeployNow in $DIR (keeping .env)"
else
  FIRST_INSTALL=1
  say "Writing $DIR/.env"
  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets."
  PASSWORD="${ADMIN_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)}"
  [ "${#PASSWORD}" -ge 12 ] || die "ADMIN_PASSWORD must be at least 12 characters."
  URL="${DEPLOYNOW_URL:-}"
  if [ -z "$URL" ]; then
    IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
    [ -n "$IP" ] || IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    URL="https://${IP:-localhost}:9444"
  fi
  umask 077
  cat > .env <<EOF
# DeployNow settings. Back this file up: AUTH_SECRET encrypts every stored secret,
# and without it a restored database can't be read.
AUTH_SECRET=$(openssl rand -base64 32)
ADMIN_EMAIL=${ADMIN_EMAIL:-admin@example.com}
ADMIN_PASSWORD=$PASSWORD
NEXTAUTH_URL=$URL
EOF
  umask 022
fi
set_env DEPLOYNOW_TAG "$TAG"
if [ -S /var/run/docker.sock ]; then set_env DOCKER_GID "$(stat -c %g /var/run/docker.sock)"; fi
chmod 600 .env

[ "${DEPLOYNOW_NO_START:-}" = "1" ] && { say "Files written to $DIR; start with: cd $DIR && docker compose up -d"; exit 0; }

# ── Start ──────────────────────────────────────────────────────────────────────
say "Pulling ghcr.io/${REPO}:$TAG"
docker compose pull || die "Couldn't pull the image. While the repository is private, run: docker login ghcr.io"
docker compose up -d

say "Waiting for DeployNow to start"
CID="$(docker compose ps -q | head -n1)"
STATUS=""
for _ in $(seq 1 60); do
  STATUS="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CID" 2>/dev/null || true)"
  [ "$STATUS" = "healthy" ] && break
  [ "$STATUS" = "exited" ] && break
  sleep 3
done
if [ "$STATUS" != "healthy" ]; then
  docker compose logs --tail 40 || true
  die "DeployNow didn't become healthy (status: ${STATUS:-unknown}). The log is above; see docs/install.md#troubleshooting."
fi

URL="$(grep '^NEXTAUTH_URL=' .env | cut -d= -f2-)"
echo
say "DeployNow is running at ${URL:-https://<this-server>:9444}"
if [ "$FIRST_INSTALL" = "1" ]; then
  echo "    Email:    $(grep '^ADMIN_EMAIL=' .env | cut -d= -f2-)"
  echo "    Password: $PASSWORD"
  echo
  echo "    The password is also in $DIR/.env. Change it after signing in, then remove"
  echo "    ADMIN_PASSWORD from .env. Back up .env somewhere safe: it holds AUTH_SECRET."
fi
echo "    The certificate is self-signed until you set a domain under Settings → Domain."
echo "    Open port 9444 (dashboard) and, for agents on other machines, 8444."
