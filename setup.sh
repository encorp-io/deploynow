#!/usr/bin/env bash
# DeployNow setup: one command, a running DeployNow.
#
#   curl -fsSL https://raw.githubusercontent.com/encorp-io/deploynow/main/setup.sh | sudo bash
#
# Linux (any distribution, Docker from get.docker.com, the distro or the Ubuntu snap) and
# macOS (Docker Desktop, OrbStack or Colima). On Windows use setup.ps1 in PowerShell:
#   irm https://raw.githubusercontent.com/encorp-io/deploynow/main/setup.ps1 | iex
#
# Installs Docker if it's missing, asks a few questions (domain, port, admin email and
# password; Enter keeps the default), writes docker-compose.yml and .env to the install
# folder (/opt/deploynow; ~/deploynow on a Mac; /var/snap/docker/common/deploynow with
# snap Docker), starts DeployNow and waits until it answers. Run it again to upgrade: it keeps .env.
#
# Without questions (CI, cloud-init):  ... | sudo bash -s -- --yes --email you@example.com
#
# Options (each also works as an environment variable):
#   --domain NAME     DEPLOYNOW_DOMAIN  serve on https://NAME with Let's Encrypt (DNS must point here)
#   --port N          DEPLOYNOW_PORT    dashboard port                      (default 9444)
#   --email ADDR      ADMIN_EMAIL       owner account                       (default admin@example.com)
#   --password PW     ADMIN_PASSWORD    its password, 12+ characters        (default: generated)
#   --require-2fa     REQUIRE_2FA=true  make admins set up 2FA              (default: optional)
#   --tag TAG         DEPLOYNOW_TAG     2.1.0, latest or edge               (default latest)
#   --dir PATH        DEPLOYNOW_DIR     install folder                      (default: see above)
#   --url URL         DEPLOYNOW_URL     public URL when there's no domain   (default https://<public IP>:<port>)
#   --yes, -y                           don't ask, use the options and defaults
#   --no-start        DEPLOYNOW_NO_START=1  write the files, don't start
#   --no-docker       INSTALL_DOCKER=no     stop instead of installing Docker
set -euo pipefail

REPO="encorp-io/deploynow"
RAW="https://raw.githubusercontent.com/${REPO}"
SETUP_URL="${DEPLOYNOW_SETUP_URL:-$RAW/main/setup.sh}"

if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; C=$'\033[1;34m'; Y=$'\033[1;33m'; R=$'\033[1;31m'; G=$'\033[1;32m'; N=$'\033[0m'; else B='' D='' C='' Y='' R='' G='' N=''; fi
say()  { printf '%s==>%s %s\n' "$C" "$N" "$*"; }
warn() { printf '%swarning:%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

usage() { sed -n '2,28p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null | sed 's/^# \{0,1\}//' || echo "See $SETUP_URL"; exit 0; }

# ── Options ────────────────────────────────────────────────────────────────────
DOMAIN="${DEPLOYNOW_DOMAIN:-}"
PORT="${DEPLOYNOW_PORT:-}"
EMAIL="${ADMIN_EMAIL:-}"
PASSWORD="${ADMIN_PASSWORD:-}"
REQUIRE_2FA="${REQUIRE_2FA:-false}"
TAG="${DEPLOYNOW_TAG:-}"
DIR="${DEPLOYNOW_DIR:-}"
URL="${DEPLOYNOW_URL:-}"
NO_START="${DEPLOYNOW_NO_START:-}"
INSTALL_DOCKER="${INSTALL_DOCKER:-yes}"
ASSUME_YES="${DEPLOYNOW_YES:-}"
ORIG_ARGS=("$@")

need_arg() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) need_arg "$@"; DOMAIN="$2"; shift 2 ;;
    --port) need_arg "$@"; PORT="$2"; shift 2 ;;
    --email) need_arg "$@"; EMAIL="$2"; shift 2 ;;
    --password) need_arg "$@"; PASSWORD="$2"; shift 2 ;;
    --require-2fa) REQUIRE_2FA=true; shift ;;
    --tag) need_arg "$@"; TAG="$2"; shift 2 ;;
    --dir) need_arg "$@"; DIR="$2"; shift 2 ;;
    --url) need_arg "$@"; URL="$2"; shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --no-docker) INSTALL_DOCKER=no; shift ;;
    -h|--help) usage ;;
    *) die "Unknown option $1 (see --help)" ;;
  esac
done

# ── Checks ─────────────────────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Linux|Darwin) ;;
  MINGW*|MSYS*|CYGWIN*) die "On Windows, run this in PowerShell instead: irm $RAW/main/setup.ps1 | iex" ;;
  *) die "DeployNow installs on Linux, macOS and Windows; $OS isn't supported." ;;
esac
command -v curl >/dev/null 2>&1 || die "curl is required (apt install curl)."

# Fetch this script again when it was piped into bash and has to restart itself
self_copy() {
  if [ -f "${BASH_SOURCE[0]:-}" ]; then echo "${BASH_SOURCE[0]}"; return; fi
  local tmp; tmp="$(mktemp)"
  curl -fsSL "$SETUP_URL" -o "$tmp" || die "Couldn't download $SETUP_URL"
  chmod 644 "$tmp"; echo "$tmp"
}

if [ "$OS" = "Darwin" ]; then
  # Docker Desktop, OrbStack and Colima belong to your user: no root needed, and files
  # written as root would get in the way. sudo bash still works and drops back to you.
  if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
    script="$(self_copy)"
    exec sudo -E -u "$SUDO_USER" -H bash "$script" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
  fi
elif [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "Run this as root: curl -fsSL $SETUP_URL | sudo bash"
  say "DeployNow needs root to install Docker and write its folder; asking sudo"
  script="$(self_copy)"
  exec sudo -E bash "$script" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
fi

case "$(uname -m)" in
  x86_64|amd64|aarch64|arm64) ;;
  *) die "Unsupported CPU $(uname -m): images are built for amd64 and arm64." ;;
esac

# Docker from the Ubuntu snap is confined: it only reads its own folders (and home folders),
# so a compose file in /opt is "not found". With the snap, DeployNow lives in the snap's folder.
SNAP_DOCKER=0
SNAP_DIR=/var/snap/docker/common/deploynow
detect_snap() {
  SNAP_DOCKER=0
  # /snap/bin/docker links to /usr/bin/snap, so look at the path, not where it leads
  case "$(command -v docker 2>/dev/null)" in /snap/*) SNAP_DOCKER=1 ;; esac
  if command -v snap >/dev/null 2>&1 && snap list docker >/dev/null 2>&1; then SNAP_DOCKER=1; fi
  return 0
}
[ "$OS" = "Linux" ] && detect_snap

DIR_GIVEN=1
if [ -z "$DIR" ]; then
  DIR_GIVEN=0
  if [ "$OS" = "Darwin" ]; then DIR="$HOME/deploynow"
  elif [ "$SNAP_DOCKER" = 1 ]; then DIR="$SNAP_DIR"
  else DIR=/opt/deploynow; fi
fi

# An install that setup.sh began in /opt/deploynow before it knew about the snap moves over
if [ "$SNAP_DOCKER" = 1 ] && [ "$DIR_GIVEN" = 0 ] && [ -f /opt/deploynow/.env ] && [ ! -f "$DIR/.env" ]; then
  mkdir -p "$DIR"
  for f in .env docker-compose.yml; do if [ -f "/opt/deploynow/$f" ]; then mv "/opt/deploynow/$f" "$DIR/$f"; fi; done
  rmdir /opt/deploynow 2>/dev/null || true
  say "Docker is the snap, which can't read /opt: moved /opt/deploynow to $DIR"
fi

# Questions come from the terminal even when the script itself arrives on stdin
INTERACTIVE=0
if [ -z "$ASSUME_YES" ] && { exec 3</dev/tty; } 2>/dev/null; then INTERACTIVE=1; fi

ask() { # ask VAR "Question" "default"
  local __var="$1" __q="$2" __def="${3:-}" __ans=""
  if [ "$INTERACTIVE" = 1 ]; then
    if [ -n "$__def" ]; then printf '%s?%s %s %s[%s]%s ' "$G" "$N" "$__q" "$D" "$__def" "$N" >/dev/tty
    else printf '%s?%s %s ' "$G" "$N" "$__q" >/dev/tty; fi
    IFS= read -r __ans <&3 || true
  fi
  [ -n "$__ans" ] || __ans="$__def"
  printf -v "$__var" '%s' "$__ans"
}

ask_secret() { # ask_secret VAR "Question"
  local __var="$1" __q="$2" __a="" __b=""
  [ "$INTERACTIVE" = 1 ] || { printf -v "$__var" '%s' ""; return; }
  while :; do
    printf '%s?%s %s %s[Enter = generate one]%s ' "$G" "$N" "$__q" "$D" "$N" >/dev/tty
    IFS= read -rs __a <&3 || true; echo >/dev/tty
    [ -z "$__a" ] && break
    if [ "${#__a}" -lt 12 ]; then echo "  At least 12 characters, please." >/dev/tty; continue; fi
    case "$__a" in *"'"*) echo "  Please leave out the ' character." >/dev/tty; continue ;; esac
    printf '  Repeat it: ' >/dev/tty
    IFS= read -rs __b <&3 || true; echo >/dev/tty
    [ "$__a" = "$__b" ] && break
    echo "  They didn't match. Try again." >/dev/tty
  done
  printf -v "$__var" '%s' "$__a"
}

valid_domain() { [[ "$1" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] && ! [[ "$1" =~ ^[0-9.]+$ ]]; }
valid_email()  { [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; }
real_email()   { valid_email "$1" && ! [[ "$1" =~ @example\.(com|org|net)$ ]]; }
port_busy() {
  if command -v ss >/dev/null 2>&1; then ss -Hltn "sport = :$1" 2>/dev/null | grep -q .
  elif command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v netstat >/dev/null 2>&1; then netstat -an 2>/dev/null | grep -E "[.:]$1 .*LISTEN" | grep -q .
  else return 1; fi
}

public_ip() {
  local ip
  ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  [[ "$ip" =~ ^[0-9.]+$|: ]] || ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  [ -n "$ip" ] || ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  echo "${ip:-localhost}"
}

# ── Install or upgrade? ────────────────────────────────────────────────────────
UPGRADE=0
[ -f "$DIR/.env" ] && UPGRADE=1

echo
printf '%sDeployNow setup%s\n' "$B" "$N"
if [ "$UPGRADE" = 1 ]; then
  say "Found $DIR/.env: upgrading and keeping your settings"
else
  [ "$INTERACTIVE" = 1 ] && printf '%sPress Enter to keep a default.%s\n\n' "$D" "$N"

  # Domain
  while :; do
    ask DOMAIN "Domain for DeployNow, e.g. deploy.example.com (Enter to use the IP)" "$DOMAIN"
    DOMAIN="$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z' | sed -E -e 's#^https?://##' -e 's#/.*$##')"
    [ -z "$DOMAIN" ] && break
    valid_domain "$DOMAIN" && break
    [ "$INTERACTIVE" = 1 ] || die "--domain $DOMAIN isn't a domain name such as deploy.example.com"
    echo "  That isn't a domain name such as deploy.example.com."; DOMAIN=""
  done

  # Port
  while :; do
    ask PORT "Dashboard port" "${PORT:-9444}"
    if [[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] && [ "$PORT" != 80 ] && [ "$PORT" != 443 ] && [ "$PORT" != 8444 ]; then
      if port_busy "$PORT"; then
        [ "$INTERACTIVE" = 1 ] || die "Port $PORT is already in use. Pick another with --port."
        echo "  Port $PORT is already in use. Pick another."; PORT=""; continue
      fi
      break
    fi
    [ "$INTERACTIVE" = 1 ] || die "--port must be a free port number other than 80, 443 and 8444"
    echo "  Use a port number other than 80, 443 and 8444 (those are for your apps and agents)."; PORT=""
  done

  # Admin email (Let's Encrypt needs a real one when there's a domain)
  while :; do
    ask EMAIL "Admin email" "${EMAIL:-$([ -n "$DOMAIN" ] && echo "" || echo admin@example.com)}"
    if [ -n "$DOMAIN" ] && ! real_email "$EMAIL"; then
      [ "$INTERACTIVE" = 1 ] || die "With --domain, pass a real --email: Let's Encrypt sends certificate notices to it."
      echo "  With a domain, use a real address: Let's Encrypt sends certificate notices to it."; EMAIL=""; continue
    fi
    valid_email "$EMAIL" && break
    [ "$INTERACTIVE" = 1 ] || die "--email $EMAIL isn't an email address"
    echo "  That isn't an email address."; EMAIL=""
  done

  # Password
  if [ -z "$PASSWORD" ]; then ask_secret PASSWORD "Admin password (12+ characters)"; fi
  GENERATED=0
  if [ -z "$PASSWORD" ]; then
    command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets (apt install openssl)."
    PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"; GENERATED=1
  fi
  [ "${#PASSWORD}" -ge 12 ] || die "The admin password must be at least 12 characters."
  case "$PASSWORD" in *"'"*|*$'\n'*) die "The admin password can't contain ' or a line break." ;; esac

  if [ -n "$DOMAIN" ]; then
    for p in 80 443; do
      port_busy "$p" && warn "Port $p is already in use. The domain needs ports 80 and 443 for Traefik; DeployNow stays reachable on port $PORT meanwhile."
    done
  fi
fi

# ── Docker ─────────────────────────────────────────────────────────────────────
DOCKER_LOG="${TMPDIR:-/tmp}/deploynow-docker-install.log"
start_service() { # start_service NAME: systemd, OpenRC or SysV
  systemctl enable --now "$1" >/dev/null 2>&1 \
    || { rc-update add "$1" default >/dev/null 2>&1; rc-service "$1" start >/dev/null 2>&1; } \
    || service "$1" start >/dev/null 2>&1 || true
}

# Distributions get.docker.com doesn't cover use their own packages
install_docker_pkg() {
  if command -v apk >/dev/null 2>&1; then apk add --no-cache docker docker-cli-compose
  elif command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm --needed docker docker-compose
  elif command -v zypper >/dev/null 2>&1; then zypper -n install docker docker-compose
  elif command -v dnf >/dev/null 2>&1; then
    # Rocky, Alma, Oracle: Docker's own RHEL packages; Amazon Linux: its docker package
    if grep -qi amzn /etc/os-release 2>/dev/null; then dnf -y install docker
    else dnf -y install dnf-plugins-core && dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo \
      && dnf -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin; fi
  elif command -v yum >/dev/null 2>&1; then yum -y install docker
  else return 1; fi
}

# Compose v2 as a Docker CLI plugin, from Docker's releases, when the distro doesn't ship it
install_compose_plugin() {
  local arch dest=/usr/local/lib/docker/cli-plugins
  case "$(uname -m)" in x86_64|amd64) arch=x86_64 ;; *) arch=aarch64 ;; esac
  mkdir -p "$dest"
  curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$arch" -o "$dest/docker-compose" \
    && chmod +x "$dest/docker-compose"
}

mac_start_docker() { # start whichever Docker the Mac has, then wait for it
  if docker info >/dev/null 2>&1; then return 0; fi
  if [ -d /Applications/OrbStack.app ]; then say "Starting OrbStack"; open -ga OrbStack || true
  elif command -v colima >/dev/null 2>&1; then say "Starting Colima"; colima start >/dev/null 2>&1 || true
  elif [ -d /Applications/Docker.app ]; then say "Starting Docker Desktop"; open -ga Docker || true
  fi
  for _ in $(seq 1 90); do docker info >/dev/null 2>&1 && return 0; sleep 2; done
  return 1
}

if [ "$OS" = "Darwin" ]; then
  if ! command -v docker >/dev/null 2>&1 && [ ! -d /Applications/Docker.app ] && [ ! -d /Applications/OrbStack.app ]; then
    [ "$INSTALL_DOCKER" = "no" ] && die "Docker is not installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) or OrbStack and run this again."
    command -v brew >/dev/null 2>&1 || die "Docker is not installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop/), OrbStack (https://orbstack.dev) or Colima, start it, and run this again."
    say "Installing Docker Desktop with Homebrew"
    brew install --cask docker-desktop || brew install --cask docker \
      || die "Docker Desktop didn't install. Install it from https://www.docker.com/products/docker-desktop/ and run this again."
  fi
  # The docker command ships inside the app until Docker Desktop links it on its first start
  if [ -x /Applications/Docker.app/Contents/Resources/bin/docker ]; then PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"; fi
  if [ -d "$HOME/.orbstack/bin" ]; then PATH="$PATH:$HOME/.orbstack/bin"; fi
  mac_start_docker || die "Docker isn't running. Start Docker Desktop (or OrbStack or Colima), wait until it's running, and run this again."
else
  if ! command -v docker >/dev/null 2>&1; then
    [ "$INSTALL_DOCKER" = "no" ] && die "Docker is not installed. Install it (https://docs.docker.com/engine/install/) and run this again."
    say "Installing Docker, this takes a minute"
    if ! curl -fsSL https://get.docker.com | sh >"$DOCKER_LOG" 2>&1; then
      say "get.docker.com doesn't cover this system; installing Docker from its packages"
      install_docker_pkg >>"$DOCKER_LOG" 2>&1 \
        || { tail -n 20 "$DOCKER_LOG" >&2; die "Docker didn't install. The log is in $DOCKER_LOG; install Docker (https://docs.docker.com/engine/install/) and run this again."; }
    fi
    hash -r
    start_service docker
  fi
  for _ in 1 2 3 4 5; do docker info >/dev/null 2>&1 && break; sleep 2; done
  if ! docker info >/dev/null 2>&1; then
    start_service docker
    for _ in 1 2 3 4 5 6 7 8 9 10; do docker info >/dev/null 2>&1 && break; sleep 2; done
  fi
  docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start it (systemctl start docker, or snap start docker) and run this again."
  if ! docker compose version >/dev/null 2>&1; then
    say "Adding the Docker Compose plugin"
    install_compose_plugin >>"$DOCKER_LOG" 2>&1 || true
  fi
fi
docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is missing. Install it (docker-compose-plugin) and run this again."

# Every Compose call names the project folder and file, whatever the working directory
dc() { docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" "$@"; }

# ── Files ──────────────────────────────────────────────────────────────────────
mkdir -p "$DIR"
cd "$DIR"
DIR="$(pwd -P)"

TAG="${TAG:-$(grep -s '^DEPLOYNOW_TAG=' .env | cut -d= -f2- || true)}"
TAG="${TAG:-latest}"
# docker-compose.yml comes from the release being installed, not from whatever main has today
latest_release() {
  local tag
  tag="$(curl -fsSL --max-time 15 -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
    | grep -o '"tag_name": *"[^"]*"' | head -n1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && echo "$tag"
}
case "$TAG" in
  edge) REF="main" ;; # edge is built from main
  latest)
    REF="$(latest_release || true)"
    if [ -z "$REF" ]; then warn "Couldn't look up the newest release; using docker-compose.yml from main."; REF="main"; fi
    ;;
  v*) REF="$TAG" ;;
  *) REF="v$TAG" ;;
esac
[[ "$REF" =~ ^(main|v[0-9A-Za-z.-]+)$ ]] || die "--tag $TAG isn't a release such as 2.1.0, latest or edge"

if [ -f docker-compose.yml ]; then
  say "Keeping your docker-compose.yml"
else
  say "Downloading docker-compose.yml ($REF)"
  curl -fsSL "$RAW/$REF/docker-compose.yml" -o docker-compose.yml || die "Couldn't download docker-compose.yml for $REF"
fi

# Make sure Docker Compose can read the file before writing anything else
if ! dc config --quiet 2>/tmp/deploynow-config.log; then
  cat /tmp/deploynow-config.log >&2
  if [ "$SNAP_DOCKER" = 1 ]; then
    die "Docker is the snap package, which only reads its own folders. Leave out --dir to install into $SNAP_DIR, or use Docker Engine instead of the snap."
  fi
  die "Docker Compose can't read $DIR/docker-compose.yml (the error is above)."
fi

set_env() { # set_env KEY VALUE: add or replace a line in .env
  local tmp; tmp="$(mktemp)"
  grep -v "^$1=" .env > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  cat "$tmp" > .env; rm -f "$tmp"
}

if [ "$UPGRADE" = 0 ]; then
  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets (apt install openssl)."
  # The IP address until the domain answers: DeployNow switches to the domain by itself
  # once its certificate is valid, and the IP keeps working as a fallback
  if [ -z "$URL" ]; then
    # A Mac is a workstation: DeployNow is for this machine, at localhost
    if [ "$OS" = "Darwin" ]; then IP=localhost; else IP="$(public_ip)"; fi
    [[ "$IP" == *:* ]] && IP="[$IP]"
    URL="https://$IP:$PORT"
  fi
  say "Writing $DIR/.env"
  umask 077
  cat > .env <<EOF
# DeployNow settings, written by setup.sh. Back this file up: AUTH_SECRET encrypts
# every stored secret, and without it a restored database can't be read.
AUTH_SECRET=$(openssl rand -base64 32)
ADMIN_EMAIL=$EMAIL
# Only read on the first start: setup.sh removes it once DeployNow is up
ADMIN_PASSWORD='$PASSWORD'
NEXTAUTH_URL=$URL
DEPLOYNOW_PORT=$PORT
# Served through Traefik with a Let's Encrypt certificate once DNS points here
DEPLOYNOW_DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL
# true makes admins and owners set up 2FA or a passkey (also under Settings → Security and sign-in)
REQUIRE_2FA=$REQUIRE_2FA
EOF
  umask 022
  [ -n "$DOMAIN" ] && set_env TLS_HOSTNAME "$DOMAIN"
fi
set_env DEPLOYNOW_TAG "$TAG"
# DOCKER_GID is set after the pull: the socket's group as containers see it
chmod 600 .env
PORT="$(grep '^DEPLOYNOW_PORT=' .env | cut -d= -f2- || true)"; PORT="${PORT:-9444}"
DOMAIN="$(grep '^DEPLOYNOW_DOMAIN=' .env | cut -d= -f2- || true)"

if [ "$NO_START" = "1" ]; then
  if [ -S /var/run/docker.sock ]; then
    GID_IN="$(stat -c %g /var/run/docker.sock 2>/dev/null || stat -f %g /var/run/docker.sock 2>/dev/null || true)"
    if [ -n "$GID_IN" ]; then set_env DOCKER_GID "$GID_IN"; fi
  fi
  say "Files written to $DIR. Start with: cd $DIR && docker compose up -d"
  grep -q '^ADMIN_PASSWORD=' .env && say "After the first start, remove ADMIN_PASSWORD from .env and run docker compose up -d again."
  exit 0
fi

# ── Start ──────────────────────────────────────────────────────────────────────
say "Pulling ghcr.io/${REPO}:$TAG"
if ! dc pull -q 2>/tmp/deploynow-pull.log; then
  if [ "$TAG" = "latest" ] && [ "$REF" = "main" ] && grep -qiE "manifest unknown|manifest for [^ ]+ not found|ghcr\.io/[^ ]+: not found" /tmp/deploynow-pull.log; then
    # Only when GitHub showed no release at all: a :latest image comes with the first release
    warn "There's no stable release yet; using edge (built from main)."
    TAG=edge; set_env DEPLOYNOW_TAG edge
    dc pull -q || die "Couldn't pull the image."
  else
    cat /tmp/deploynow-pull.log >&2
    if grep -qiE "unauthorized|denied|authentication required" /tmp/deploynow-pull.log; then
      die "ghcr.io refused the download of ghcr.io/${REPO}:$TAG. If you use a private copy of the image, run docker login ghcr.io first."
    fi
    die "Couldn't pull ghcr.io/${REPO}:$TAG (the error is above)."
  fi
fi
# The image runs as a non-root user and reaches Docker through the socket's group. Inside
# containers that group can differ from the host's (Docker Desktop, OrbStack, the snap).
GID_IN="$(dc run --rm --no-deps -T --entrypoint stat deployer -c %g /var/run/docker.sock 2>/dev/null | tr -dc '0-9' || true)"
if [ -z "$GID_IN" ] && [ -S /var/run/docker.sock ]; then
  GID_IN="$(stat -c %g /var/run/docker.sock 2>/dev/null || stat -f %g /var/run/docker.sock 2>/dev/null || true)"
fi
if [ -n "$GID_IN" ]; then set_env DOCKER_GID "$GID_IN"; fi
dc up -d --remove-orphans

wait_healthy() {
  local cid status=""
  cid="$(dc ps -q | head -n1)"
  for _ in $(seq 1 60); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)"
    [ "$status" = "healthy" ] && return 0
    [ "$status" = "exited" ] && break
    sleep 2
  done
  dc logs --tail 40 || true
  die "DeployNow didn't become healthy (status: ${status:-unknown}). The log is above; see https://github.com/$REPO/blob/main/docs/install.md#troubleshooting"
}

say "Waiting for DeployNow to start"
wait_healthy

# The owner account exists now. ADMIN_PASSWORD is only read on the first start, and left in
# .env the container would keep it in its environment, where docker inspect shows it.
if grep -q '^ADMIN_PASSWORD=' .env; then
  say "Removing the first-start password from .env"
  tmp="$(mktemp)"; grep -v -e '^ADMIN_PASSWORD=' -e '^# Only read on the first start' .env > "$tmp" || true
  cat "$tmp" > .env; rm -f "$tmp"
  dc up -d --remove-orphans >/dev/null 2>&1 || dc up -d --remove-orphans
  wait_healthy
fi

if [ "$OS" = "Darwin" ]; then IP_URL="https://localhost:$PORT"; else IP_URL="https://$(public_ip):$PORT"; fi
echo
printf '%s✓ DeployNow is running%s\n\n' "$G" "$N"
if [ -n "$DOMAIN" ]; then
  echo "    Open:      https://$DOMAIN"
  echo "               (the certificate arrives within a minute or two once $DOMAIN points"
  echo "               at this server; until then use $IP_URL)"
else
  echo "    Open:      $(grep '^NEXTAUTH_URL=' .env | cut -d= -f2-)"
fi
if [ "$UPGRADE" = 0 ]; then
  echo "    Email:     $EMAIL"
  if [ "${GENERATED:-0}" = 1 ]; then echo "    Password:  $PASSWORD"; else echo "    Password:  the one you typed"; fi
  echo
  echo "    Settings are in $DIR/.env. Back it up: it holds AUTH_SECRET."
  [ -z "$DOMAIN" ] && echo "    The certificate is self-signed; add a domain later under Settings → Domain."
  echo "    Two-factor sign-in is optional; turn it on under Account."
fi
echo "    Open port $PORT (dashboard)$([ -n "$DOMAIN" ] && echo ", 80 and 443 (domain)") and 8444 for agents on other machines."
echo
