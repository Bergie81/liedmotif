#!/usr/bin/env bash
# Liedmotif installer.
#
#   curl -fsSL https://github.com/bergie81/liedmotif/releases/latest/download/install.sh | bash
#
# Downloads a Liedmotif release into the install directory, writes `.env` with
# freshly generated secrets, pulls the prebuilt images and starts the stack.
# Without --domain it serves the app to this machine's tailnet alone, at its
# `https://<machine>.<tailnet>.ts.net` name: it installs Tailscale and signs in
# when needed. Running it again is the update: it keeps `.env`, moves
# `LIEDMOTIF_VERSION` to the new release, and restarts the stack in a short
# maintenance window. Runs as a normal user and asks `sudo` only for the steps
# that need root.
#
# Flags:
#   --domain <name>   serve this public domain instead (a VPS); Caddy gets its
#                     certificate, and Tailscale is never touched
#   --version <tag>   the release to install (default: the latest release)
#   --dir <path>      install directory (default: /opt/liedmotif)
#
# Environment (for slow machines and tests):
#   LIEDMOTIF_HEALTH_TIMEOUT   seconds to wait for the app to answer (default 300)
#   LIEDMOTIF_HEALTH_INTERVAL  seconds between health checks (default 5)
#   LIEDMOTIF_ETC              where system settings are written (default /etc)
#   LIEDMOTIF_SKIP_DNS_CHECK   1: install --domain without checking that it
#                             points here (a domain behind a proxy, a floating IP)
#   LIEDMOTIF_SOURCE_DIR       a Liedmotif checkout to install instead of a
#                             release: copied in, its images built here, and
#                             GitHub never asked (version `local` without
#                             --version)
#
# Everything sits in functions and `main` runs on the last line, so a download
# cut short never runs half a script.

set -Eeuo pipefail

REPO=bergie81/liedmotif
INSTALLER_URL="https://github.com/$REPO/releases/latest/download/install.sh"
DEFAULT_DIR=/opt/liedmotif
ETC=${LIEDMOTIF_ETC:-/etc}
HEALTH_TIMEOUT=${LIEDMOTIF_HEALTH_TIMEOUT:-300}
HEALTH_INTERVAL=${LIEDMOTIF_HEALTH_INTERVAL:-5}
SKIP_DNS_CHECK=${LIEDMOTIF_SKIP_DNS_CHECK:-}
SOURCE_DIR=${LIEDMOTIF_SOURCE_DIR:-}

TAILSCALE_COMPOSE_FILE=docker-compose.yml:docker-compose.tailscale.yml
TAILNET_ONLY_UNIT=liedmotif-tailnet-only.service
TS_HTTPS_HELP='in the Tailscale admin console, open DNS (https://console.tailscale.com/admin/dns), turn on MagicDNS, then under HTTPS Certificates select Enable HTTPS'

DOMAIN=''
VERSION=''
TAG=''
DIR=$DEFAULT_DIR
# Set when this run finds an existing `.env`: the run is an update.
UPDATE=false
# How the app is served: `tailnet` (this machine's tailnet name and address),
# `domain` (a public name with a Let's Encrypt certificate), or `localhost`
# (Caddy's internal certificate).
MODE=''
# The name the app is served at and, on the tailnet, the address Caddy binds:
# what `.env` holds on an update, what a first install writes into it.
APP_DOMAIN=''
TAILSCALE_IP=''
PREVIOUS_VERSION=''
STEP=''
TMP=''
# The words that run a command with access to Docker: through sudo for a user
# outside the `docker` group. `env` carries a leading VAR=value past sudo,
# which resets the environment.
DOCKER=(env)
# How the Docker commands in hints are spelled for this user.
DOCKER_SHOWN=docker

say() { printf '%s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }

step() {
  STEP=$1
  say "==> $1"
}

# Stops the install, naming the step it stopped in and the next thing to try.
fail() {
  printf '\nError during "%s": %s\n' "$STEP" "$1" >&2
  [ -n "${2:-}" ] && printf 'Try: %s\n' "$2" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage: install.sh [--domain <name>] [--version <tag>] [--dir <path>]

  (no --domain)     serve Liedmotif to your tailnet at this machine's *.ts.net name
  --domain <name>   serve this public domain instead, e.g. music.example.com
  --version <tag>   the release to install (default: the latest release)
  --dir <path>      install directory (default: $DEFAULT_DIR)
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --domain | --version | --dir)
        [ $# -ge 2 ] || { usage >&2; exit 2; }
        case $1 in
          --domain) DOMAIN=$2 ;;
          --version) VERSION=$2 ;;
          --dir) DIR=$2 ;;
        esac
        shift 2
        ;;
      -h | --help) usage; exit 0 ;;
      *) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
  done
  # Absolute, so the update command printed at the end names this folder from
  # whatever directory it is run in later.
  case $DIR in /*) ;; *) DIR=$PWD/${DIR#./} ;; esac
  case $DOMAIN in
    '') ;;
    *[!A-Za-z0-9.-]* | .* | *.)
      local bare=${DOMAIN#*://}
      bare=${bare%%/*}
      printf 'The domain must be a bare name, like: --domain %s\n' "${bare:-music.example.com}" >&2
      exit 2
      ;;
  esac
  if [ -n "$SOURCE_DIR" ]; then
    [ -f "$SOURCE_DIR/docker-compose.yml" ] || {
      printf 'LIEDMOTIF_SOURCE_DIR must be a Liedmotif checkout; %s has no docker-compose.yml.\n' "$SOURCE_DIR" >&2
      exit 2
    }
    SOURCE_DIR=$(cd "$SOURCE_DIR" && pwd)
    # A copy into a directory inside the checkout would carry every earlier
    # install along, one level deeper on each run.
    local dest=$DIR
    case $dest in /*) ;; *) dest=$PWD/$dest ;; esac
    case ${dest%/}/ in
      "$SOURCE_DIR"/?*)
        printf 'The install directory %s is inside the checkout %s; choose one outside it, or the checkout itself.\n' "$DIR" "$SOURCE_DIR" >&2
        exit 2
        ;;
    esac
  fi
}

# Root runs everything directly; anyone else goes through sudo for root steps.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "this step needs root, and sudo is not installed." "run the same command again as root."
  fi
}

# --- secrets ---------------------------------------------------------------

random_base64() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }
random_hex() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }

# Sets KEY=value in an env file: replaces the last active line (the one Compose
# reads), else the commented `#KEY=` placeholder, else appends. The value travels
# through the environment, never argv, so `ps` cannot show a secret.
set_env() {
  local file=$1 key=$2 value=$3 match='' tmp
  if grep -q "^$key=" "$file"; then
    match="$key="
  elif grep -q "^#$key=" "$file"; then
    match="#$key="
  fi
  tmp=$(mktemp "$file.XXXXXX")
  MATCH=$match LINE="$key=$value" awk '
    BEGIN { match_ = ENVIRON["MATCH"]; line = ENVIRON["LINE"] }
    NR == FNR { if (match_ != "" && index($0, match_) == 1) last = FNR; next }
    FNR == last { print line; next }
    { print }
    END { if (match_ == "") print line }
  ' "$file" "$file" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

# The last value set for a key, read the way Compose reads it: a hand edit may
# quote it, follow it with a ` # comment`, or save the file with Windows line
# endings.
env_value() {
  sed -n "s/^$2=//p" "$1" | tail -n 1 | tr -d '\r' |
    sed -e "s/^'\([^']*\)'.*/\1/" -e t -e 's/^"\([^"]*\)".*/\1/' -e t \
      -e 's/[[:space:]][[:space:]]*#.*//' -e 's/[[:space:]]*$//'
}

# --- steps -----------------------------------------------------------------

# The images exist for amd64 and arm64 only. `getconf` catches 32-bit Raspberry
# Pi OS, whose 64-bit kernel makes `uname -m` say aarch64.
preflight() {
  step "Checking this machine"
  local arch bits
  arch=$(uname -m)
  bits=$(getconf LONG_BIT 2>/dev/null || echo 64)
  case "$arch/$bits" in
    x86_64/64 | aarch64/64) ;;
    *)
      fail "Liedmotif needs a 64-bit system (x86_64 or aarch64); this one is $arch with a $bits-bit userland." \
        "on a Raspberry Pi, flash Raspberry Pi OS (64-bit) with Raspberry Pi Imager and run this command again. On a PC, install a 64-bit Debian or Ubuntu."
      ;;
  esac
  check_memory
}

# A 4 GB board reports about 3.7 GiB, so the line sits below that.
check_memory() {
  local mib
  mib=$(free -m 2>/dev/null | awk '/^Mem:/ { print $2 }') || return 0
  [ -n "$mib" ] || return 0
  if [ "$mib" -lt 3500 ]; then
    warn "this machine has $(awk -v m="$mib" 'BEGIN { printf "%.1f", m / 1024 }') GB of RAM." \
      "Liedmotif wants 4 GB or more; with less it may run slowly or stop under load."
  fi
}

# Postgres and the music library write all day: an ordinary microSD card wears
# out and can corrupt on a power cut.
# Runs once Docker is reachable, so a user outside the `docker` group still
# gets Docker's data root checked.
check_storage() {
  local path source docker_root
  docker_root=$("${DOCKER[@]}" docker info --format '{{.DockerRootDir}}' 2>/dev/null) || docker_root=''
  for path in / "$docker_root"; do
    source=$(findmnt -n -o SOURCE --target "$path" 2>/dev/null) || continue
    case $source in
      *mmcblk*)
        warn "Liedmotif's data would sit on a microSD card ($source). SD cards wear out and can" \
          "lose data on a power cut. An SSD is recommended; a High Endurance microSD card works."
        return
        ;;
    esac
  done
}

# This machine's public address as the internet sees it, or nothing. An outside
# service answers, because a VPS behind NAT does not know its own.
public_ip() {
  local ip
  ip=$(curl -fsS --max-time 10 "$1" 2>/dev/null) || return 0
  case $ip in
    '' | *[!0-9A-Fa-f.:]*) ;;
    *) printf '%s' "$ip" ;;
  esac
}

# The addresses a name's A and AAAA records hold, one per line, as public DNS
# answers them, which is what Let's Encrypt asks. Over HTTPS, because this
# machine's own resolver hides AAAA records on a server without IPv6 and can
# answer from /etc/hosts, where cloud-init lists the server's own name. Only A
# (type 1) and AAAA (type 28) answers count: a CNAME's answer names a host, not
# an address. Fails when a lookup does.
resolve_domain() {
  local type
  for type in A AAAA; do
    curl -fsS --max-time 10 -H 'accept: application/dns-json' \
      "https://cloudflare-dns.com/dns-query?name=$1&type=$type" 2>/dev/null || exit
  done | tr '{' '\n' | sed -nE '/"type":(1|28)[,}]/ s/.*"data":"([^"]*)".*/\1/p' | sort -u
}

# Let's Encrypt allows only a few failed validations an hour, and each one asks
# whatever address the domain's records name. So a first install stops here,
# before Caddy ever asks, while a record is missing or points elsewhere (an old
# server, the domain provider's parking page). An update skips it: its domain
# already has a certificate, which Caddy renews on its own.
check_dns() {
  [ "$UPDATE" = false ] && [ "$MODE" = domain ] || return 0
  if [ "$SKIP_DNS_CHECK" = 1 ]; then
    step "Skipping the DNS check for $APP_DOMAIN (LIEDMOTIF_SKIP_DNS_CHECK=1)"
    return 0
  fi
  step "Checking that $APP_DOMAIN points at this server"
  local ip4 ip6='' records addr elsewhere='' value
  ip4=$(public_ip https://ipv4.icanhazip.com)
  records=$(resolve_domain "$APP_DOMAIN") || {
    warn "could not look up the DNS records for $APP_DOMAIN, so whether it points here goes unchecked."
    return 0
  }
  value=${ip4:-"this server's public IP address"}
  [ -n "$records" ] ||
    fail "$APP_DOMAIN has no DNS record yet, so Caddy cannot get its certificate." \
      "add this DNS record at your domain provider: type A, name @ (or the subdomain), value $value. Changes can take minutes to hours. Run the same command again when done."
  if [ -z "$ip4" ]; then
    warn "could not look up this server's public IP address, so whether $APP_DOMAIN points here goes unchecked."
    return 0
  fi
  case $records in *:*) ip6=$(public_ip https://ipv6.icanhazip.com) ;; esac
  for addr in $records; do
    [ "$addr" = "$ip4" ] || [ "$addr" = "$ip6" ] || elsewhere="$elsewhere${elsewhere:+, }$addr"
  done
  [ -z "$elsewhere" ] ||
    fail "$APP_DOMAIN points at $elsewhere, but this server's address is $ip4${ip6:+ and $ip6}." \
      "at your domain provider, set the A record for $APP_DOMAIN to $ip4 and delete every other A or AAAA record for it. Changes can take minutes to hours. Run the same command again when done."
}

ensure_docker() {
  step "Checking Docker"
  if docker compose version >/dev/null 2>&1; then
    say "Docker is already installed; leaving it as it is."
  else
    say "Installing Docker with Docker's official script (https://get.docker.com)"
    curl -fsSL -o "$TMP/get-docker.sh" https://get.docker.com ||
      fail "could not download Docker's install script." \
        "check that this machine can reach get.docker.com, then run the same command again."
    as_root sh "$TMP/get-docker.sh" </dev/null ||
      fail "Docker's install script failed (its output is above)." \
        "fix what it names, or install Docker by hand (https://docs.docker.com/engine/install/), then run the same command again."
    docker compose version >/dev/null 2>&1 ||
      fail "Docker is installed but 'docker compose' still does not work." \
        "install Docker's Compose plugin (https://docs.docker.com/compose/install/linux/), then run the same command again."
  fi
  # A user outside the `docker` group reaches the daemon through sudo.
  if docker info >/dev/null 2>&1; then
    DOCKER=(env)
  elif as_root docker info >/dev/null 2>&1; then
    DOCKER=(as_root env)
    DOCKER_SHOWN='sudo docker'
  else
    fail "Docker is installed but not running." "start it with 'sudo systemctl start docker', then run the same command again."
  fi
}

# Every install runs as one Compose project: `liedmotif` (docker-compose.yml),
# unless its `.env` sets COMPOSE_PROJECT_NAME. Containers of that project started
# from another folder, stopped ones included, are a running install: a start
# from here would replace them and meet their database with a new password. So
# the install stops before it changes anything. Folders compare by inode, so a
# symlink to the install folder is the same install.
check_other_install() {
  step "Checking for another Liedmotif install on this machine"
  local project='' containers folder other='' unknown=false
  [ ! -f "$DIR/.env" ] || project=$(env_value "$DIR/.env" COMPOSE_PROJECT_NAME)
  project=${project:-liedmotif}
  containers=$("${DOCKER[@]}" docker ps -a --filter "label=com.docker.compose.project=$project" \
    --format '{{.ID}} {{.Label "com.docker.compose.project.working_dir"}}' </dev/null)
  [ -n "$containers" ] || return 0
  while IFS=' ' read -r _ folder; do
    [ -n "$folder" ] && [ "$folder" -ef "$DIR" ] && continue
    if [ -n "$folder" ] && [ -d "$folder" ] && [ -r "$folder" ]; then
      other=$folder
    else
      unknown=true
    fi
  done <<<"$containers"
  [ -z "$other" ] ||
    fail "Liedmotif is already installed on this machine, in $other. Nothing was changed." \
      "to update it, run the same command with --dir $(printf '%q' "$other")."
  [ "$unknown" = false ] ||
    fail "Liedmotif is already installed on this machine (Compose project $project), but the folder it runs from cannot be found. Nothing was changed." \
      "'$DOCKER_SHOWN compose ls -a' lists it with its folder; to update it, run the same command with --dir <that folder>."
}

# Debian-family systems install their security updates on their own once
# unattended-upgrades is on, with the distribution's default choice of updates.
# A setting already in place, on or off, is the owner's and stays, and nothing
# else in the system changes.
ensure_security_updates() {
  [ -f "$ETC/debian_version" ] || return 0
  grep -rqs '^[[:space:]]*APT::Periodic::Unattended-Upgrade' "$ETC/apt/apt.conf" "$ETC/apt/apt.conf.d" &&
    return 0
  step "Turning on automatic security updates (unattended-upgrades)"
  {
    as_root apt-get -qq -o DPkg::Lock::Timeout=120 update &&
      as_root env DEBIAN_FRONTEND=noninteractive apt-get -qq -y -o DPkg::Lock::Timeout=120 install unattended-upgrades
  } </dev/null >/dev/null ||
    fail "could not install unattended-upgrades (apt's output is above)." \
      "fix what apt names, then run the same command again."
  printf '%s\n' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' |
    write_system_file "$ETC/apt/apt.conf.d/20auto-upgrades"
}

resolve_version() {
  local url
  if [ -n "$VERSION" ]; then
    TAG="v${VERSION#v}"
  else
    url=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") ||
      fail "could not look up the latest Liedmotif release." \
        "check that this machine can reach github.com, then run the same command again."
    case $url in
      */releases/tag/*) TAG=${url##*/} ;;
      *) fail "no published Liedmotif release was found." "name one with --version <tag>." ;;
    esac
  fi
  VERSION=${TAG#v}
}

prepare_dir() {
  mkdir -p "$DIR" 2>/dev/null || as_root mkdir -p "$DIR"
  [ -w "$DIR" ] || as_root chown "$(id -u):$(id -g)" "$DIR"
}

download_release() {
  step "Looking up the Liedmotif release"
  resolve_version
  step "Downloading Liedmotif $VERSION into $DIR"
  prepare_dir
  curl -fsSL -o "$TMP/release.tar.gz" "https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz" ||
    fail "could not download Liedmotif $TAG." \
      "check that $TAG is listed at https://github.com/$REPO/releases, then run the same command again."
  tar -xzf "$TMP/release.tar.gz" --strip-components=1 -C "$DIR" ||
    fail "could not unpack the release into $DIR." "check the free disk space (df -h), then run the same command again."
}

# The files a release tarball holds, from a working copy: never its git data,
# dependencies, build output, local data, or secrets such as `.env`, so the
# install's own `.env` stays as it is.
copy_checkout() {
  VERSION=${VERSION:-local}
  VERSION=${VERSION#v}
  if [ "$SOURCE_DIR" -ef "$DIR" ]; then
    step "Installing Liedmotif from the checkout in $DIR"
    return 0
  fi
  step "Copying Liedmotif from $SOURCE_DIR into $DIR"
  prepare_dir
  (cd "$SOURCE_DIR" && find . \( \
    -path ./.git -o -path ./data -o -path ./.mcp.json \
    -o -name node_modules -o -name .next -o -name dist -o -name out \
    -o -name coverage -o -name playwright-report -o -name test-results -o -name '*.tsbuildinfo' \
    -o -name .env -o -name '.env.*' ! -name .env.example \
    \) -prune -o ! -type d -print) |
    tar -C "$SOURCE_DIR" -cf - -T - | tar -C "$DIR" -xf - ||
    fail "could not copy $SOURCE_DIR into $DIR." "check the free disk space (df -h), then run the same command again."
}

# A first install serves --domain, or this machine's tailnet name without one
# (set once Tailscale answers). An update keeps what its `.env` serves.
choose_mode() {
  local env="$DIR/.env"
  if [ -f "$env" ]; then
    UPDATE=true
    APP_DOMAIN=$(env_value "$env" APP_DOMAIN)
    TAILSCALE_IP=$(env_value "$env" TAILSCALE_IP)
    PREVIOUS_VERSION=$(env_value "$env" LIEDMOTIF_VERSION)
    case $(env_value "$env" COMPOSE_FILE) in
      *docker-compose.tailscale.yml*) MODE=tailnet ;;
    esac
    [ -z "$DOMAIN" ] || [ "$DOMAIN" = "$APP_DOMAIN" ] ||
      warn "keeping APP_DOMAIN=$APP_DOMAIN from $env; --domain $DOMAIN changes nothing on an update." \
        "To move to another domain, edit APP_DOMAIN and APP_PUBLIC_URL in $env, and from --domain localhost also set CADDY_HTTP_PORT=80 and CADDY_HTTPS_PORT=443."
  else
    APP_DOMAIN=$DOMAIN
    [ -n "$DOMAIN" ] || MODE=tailnet
  fi
  case $MODE:$APP_DOMAIN in
    tailnet:*) ;;
    *:localhost) MODE=localhost ;;
    *) MODE=domain ;;
  esac
}

# `tailscale status --json` on one line, for the lookups below.
tailscale_status() { tailscale status --json </dev/null | tr -d ' \t\n'; }

# docker-compose.tailscale.yml replaces Caddy's published ports with `!override`;
# an older Compose cannot, and the ports must never stay open on every interface.
check_compose_version() {
  local have
  have=$(docker compose version --short 2>/dev/null) || have=''
  have=${have#v}
  [ -n "$have" ] && [ "$(printf '%s\n' 2.24.4 "$have" | sort -V | head -n 1)" = 2.24.4 ] ||
    fail "Liedmotif on a tailnet needs Docker Compose 2.24.4 or newer; this machine has ${have:-an unknown version}." \
      "update Docker (https://docs.docker.com/engine/install/), then run the same command again."
}

ensure_tailscale() {
  [ "$MODE" = tailnet ] || return 0
  step "Checking Tailscale"
  local status name ip
  check_compose_version
  if tailscale version >/dev/null 2>&1; then
    say "Tailscale is already installed; leaving it as it is."
  else
    say "Installing Tailscale with Tailscale's official script (https://tailscale.com/install.sh)"
    curl -fsSL -o "$TMP/install-tailscale.sh" https://tailscale.com/install.sh ||
      fail "could not download Tailscale's install script." \
        "check that this machine can reach tailscale.com, then run the same command again."
    as_root sh "$TMP/install-tailscale.sh" </dev/null ||
      fail "Tailscale's install script failed (its output is above)." \
        "fix what it names, or install Tailscale by hand (https://tailscale.com/download/linux), then run the same command again."
  fi
  status=$(tailscale_status) ||
    fail "Tailscale is installed but not running." \
      "start it with 'sudo systemctl enable --now tailscaled', then run the same command again."
  case $status in
    *'"BackendState":"Running"'*) ;;
    *)
      say "This machine is not signed in to Tailscale yet. Open the link below on any"
      say "device and sign in; the installer waits until you have."
      as_root tailscale up </dev/null ||
        fail "could not sign this machine in to Tailscale." \
          "fix what Tailscale names above, then run the same command again."
      status=$(tailscale_status)
      ;;
  esac
  # The first `DNSName` inside `Self`, which lists no nested object before it.
  name=$(printf '%s' "$status" | sed -n 's/.*"Self":{[^{}]*"DNSName":"\([^"]*\)".*/\1/p')
  name=${name%.}
  ip=$(tailscale ip -4 </dev/null | head -n 1)
  [ -n "$name" ] && [ -n "$ip" ] ||
    fail "could not read this machine's Tailscale name and address." \
      "check that 'tailscale status' lists this machine with a name, then run the same command again."
  # Caddy gets the certificate from tailscaled, which offers one only for the
  # names it lists here, and only with HTTPS turned on for the tailnet.
  case $(printf '%s' "$status" | sed -n 's/.*"CertDomains":\[\([^]]*\)\].*/\1/p') in
    *"\"$name\""*) ;;
    *)
      fail "this tailnet has HTTPS certificates turned off, so there is no certificate for $name." \
        "$TS_HTTPS_HELP. Then run the same command again."
      ;;
  esac
  [ "$UPDATE" = false ] || check_tailnet_unchanged "$name" "$ip"
  APP_DOMAIN=$name
  TAILSCALE_IP=$ip
  ensure_tailscale_updates
  prepare_tailnet_host
}

# tailscaled is a home box's only network edge, so it updates itself, through
# the package manager it was installed with. Docker updates by hand only: an
# upgrade restarts every container, which would stop the music at a random time.
ensure_tailscale_updates() {
  step "Turning on Tailscale's automatic updates"
  as_root tailscale set --auto-update </dev/null ||
    warn "could not turn on Tailscale's automatic updates (its message is above);" \
      "'sudo apt update && sudo apt upgrade' updates it by hand."
}

# An update never rewrites `.env`, and Caddy serves and binds what it names: a
# machine renamed or re-added on the tailnet stops here, before the app does.
check_tailnet_unchanged() {
  local name=$1 ip=$2 env="$DIR/.env"
  [ "$name" = "$APP_DOMAIN" ] && [ "$ip" = "$TAILSCALE_IP" ] ||
    fail "this machine is $name ($ip) on the tailnet now, but $env serves $APP_DOMAIN ($TAILSCALE_IP). Nothing was stopped." \
      "set APP_DOMAIN=$name, APP_PUBLIC_URL=https://$name and TAILSCALE_IP=$ip in $env, then run the same command again."
}

# Writes stdin to a root-owned system file.
write_system_file() {
  as_root mkdir -p "$(dirname "$1")"
  as_root tee "$1" >/dev/null
}

# Caddy publishes 80 and 443 on the Tailscale address alone
# (docker-compose.tailscale.yml). Three host settings keep it up, and reachable
# through Tailscale only, after a reboot or a Tailscale upgrade with nobody at
# the keyboard:
# - At boot Docker restarts Caddy, often before tailscaled has its address:
#   tailscaled reports ready before it reaches the tailnet, and after a power
#   cut the router can come back long after this machine. Docker never retries
#   a refused bind, so Caddy would stay down. `ip_nonlocal_bind` lets the bind
#   succeed early; traffic flows once the address is up.
# - Caddy asks tailscaled for the certificate on every new TLS connection,
#   over the socket in /run/tailscale that its container mounts. systemd
#   deletes and recreates that directory on every tailscaled restart, which
#   would leave Caddy holding the deleted, empty one.
# - Docker forwards a published port for every packet addressed to it, on
#   whatever interface it arrives, so a home-network device that routes the
#   Tailscale address to this machine would reach Caddy. A unit drops those
#   packets in the raw table, before Docker starts. IPv4 only: nothing is
#   published on the IPv6 Tailscale address.
prepare_tailnet_host() {
  step "Setting up this machine to serve Liedmotif on your tailnet only"
  local sysctl_conf="$ETC/sysctl.d/99-liedmotif-tailscale.conf"
  printf '%s\n' \
    '# Liedmotif binds the Tailscale address, which tailscaled may assign only' \
    '# after Docker has started (docker-compose.tailscale.yml).' \
    'net.ipv4.ip_nonlocal_bind = 1' | write_system_file "$sysctl_conf"
  as_root sysctl -q -p "$sysctl_conf" >/dev/null
  printf '%s\n' \
    "# Liedmotif's Caddy container mounts /run/tailscale (docker-compose.tailscale.yml)." \
    '[Service]' \
    'RuntimeDirectoryPreserve=yes' | write_system_file "$ETC/systemd/system/tailscaled.service.d/liedmotif.conf"
  # Each rule goes in first, so the two exceptions, added after the drop, sit
  # above it. `lo` carries this machine's own connections to the address.
  # Docker sends the host's own connection to a published port (the health
  # check's) to the container, which answers over the Compose network's bridge.
  {
    printf '%s\n' \
      '# Written by the Liedmotif installer (docker/install.sh): the Tailscale address' \
      '# answers only what comes through Tailscale (docker-compose.tailscale.yml).' \
      '[Unit]' \
      'Description=Liedmotif: the Tailscale address answers through Tailscale only' \
      'Before=docker.service' \
      '' \
      '[Service]' \
      'Type=oneshot' \
      'RemainAfterExit=yes'
    tailnet_only_rule '! -i tailscale0 -j DROP'
    tailnet_only_rule '-i br-+ -j ACCEPT'
    tailnet_only_rule '-i lo -j ACCEPT'
    printf '%s\n' '' '[Install]' 'WantedBy=docker.service'
  } | write_system_file "$ETC/systemd/system/$TAILNET_ONLY_UNIT"
  as_root systemctl daemon-reload
  { as_root systemctl enable "$TAILNET_ONLY_UNIT" && as_root systemctl restart "$TAILNET_ONLY_UNIT"; } ||
    fail "could not turn on the rule that keeps Liedmotif on your tailnet only." \
      "look at 'sudo systemctl status $TAILNET_ONLY_UNIT', fix what it names, then run the same command again."
}

# An ExecStart line that adds one raw-table rule for the Tailscale address,
# unless it is already there.
tailnet_only_rule() {
  local rule="PREROUTING -d $TAILSCALE_IP $1"
  printf "ExecStart=/bin/sh -c 'iptables -w -t raw -C %s 2>/dev/null || iptables -w -t raw -I %s'\n" "$rule" "$rule"
}

# An existing `.env` holds keys that cannot be recovered, so it is never
# regenerated: an update moves its `LIEDMOTIF_VERSION` line and nothing else,
# once the new images are in (move_version).
write_env() {
  local env="$DIR/.env" tmp pg_password
  if [ "$UPDATE" = true ]; then
    step "Keeping the existing .env"
    return 0
  fi
  step "Writing .env with fresh secrets"
  tmp=$(mktemp "$env.XXXXXX")
  chmod 600 "$tmp"
  cat "$DIR/.env.example" >"$tmp"
  pg_password=$(random_hex)
  set_env "$tmp" APP_SECRET "$(random_base64)"
  set_env "$tmp" BETTER_AUTH_SECRET "$(random_base64)"
  set_env "$tmp" CREDENTIAL_ENCRYPTION_KEY "$(random_base64)"
  set_env "$tmp" POSTGRES_PASSWORD "$pg_password"
  set_env "$tmp" DOCKER_DATABASE_URL "postgres://liedmotif:$pg_password@postgres:5432/liedmotif"
  set_env "$tmp" SETUP_TOKEN "$(random_hex)"
  set_env "$tmp" BACKUP_ENCRYPTION_PASSPHRASE "$(random_hex)"
  set_env "$tmp" LIEDMOTIF_VERSION "$VERSION"
  if [ "$MODE" = tailnet ]; then
    set_env "$tmp" COMPOSE_FILE "$TAILSCALE_COMPOSE_FILE"
    set_env "$tmp" TAILSCALE_IP "$TAILSCALE_IP"
  fi
  # Caddy answers on this machine alone while its ports are unset, and a real
  # domain is reached from elsewhere.
  if [ "$MODE" = domain ]; then
    set_env "$tmp" CADDY_HTTP_PORT 80
    set_env "$tmp" CADDY_HTTPS_PORT 443
  fi
  set_env "$tmp" APP_DOMAIN "$APP_DOMAIN"
  set_env "$tmp" APP_PUBLIC_URL "https://$APP_DOMAIN"
  # Marks the first install unfinished until the setup link has been shown, so
  # a rerun after a failed first start still prints it.
  : >"$DIR/.first-install"
  mv "$tmp" "$env"
}

# Compose prefers a variable from its environment over `.env`'s, so every call
# runs the version being installed, whichever version `.env` still names.
compose() { (cd "$DIR" && "${DOCKER[@]}" "LIEDMOTIF_VERSION=$VERSION" docker compose "$@"); }

# The images are on disk before an update stops anything or moves `.env`, so a
# failed pull or build leaves the old app playing on the `.env` it runs from,
# and every later call passes `--no-build`. A release pulls its prebuilt
# images: building on a small board is slow and can run out of memory. A
# checkout has none to pull, so it builds its own on every run: the layer cache
# keeps a rerun quick, and a changed checkout gets new images.
start_stack() {
  if [ -z "$SOURCE_DIR" ]; then
    step "Pulling the Liedmotif $VERSION images (this can take a few minutes)"
    compose pull ||
      fail "could not pull the Liedmotif images for $VERSION. Nothing was stopped or started." \
        "check that this machine can reach ghcr.io, then run the same command again."
  else
    step "Building the Liedmotif images from $SOURCE_DIR (the first build can take a long time on a small board)"
    { compose pull --ignore-buildable && compose build; } ||
      fail "could not build the Liedmotif images. Nothing was stopped or started." \
        "fix what the output above names, then run the same command again."
  fi
  if [ "$UPDATE" = true ]; then
    move_version
    migrate_in_maintenance_window
  fi
  step "Starting Liedmotif $VERSION"
  compose up -d --no-build ||
    fail "the stack did not start." "look at '$DOCKER_SHOWN compose logs' in $DIR, then run the same command again."
}

# An update is a short maintenance window, never a rolling `up -d`: some
# migrations are runtime cutovers that must not run while an old web or worker
# is alive (docker/README.md, "Session Cover planner cutover"), and a plain
# `up -d` migrates while they still run. `migrate` runs attached through `up`
# rather than `run`, because `run` builds a missing image. The `up -d` after it
# runs `migrate` once more, a no-op on the current schema, before it starts
# web and worker.
migrate_in_maintenance_window() {
  step "Stopping the app for the update (the worker first finishes its running jobs, up to 3 minutes)"
  { compose stop web caddy && compose stop worker; } ||
    fail "could not stop the running app." \
      "look at '$DOCKER_SHOWN compose ps' in $DIR, then run the same command again."
  step "Updating the database"
  compose up --no-build --exit-code-from migrate migrate ||
    fail "the database update failed. Liedmotif stays stopped, so nothing runs on a half-updated database." \
      "$(migrate_hint)"
}

move_version() {
  [ "$PREVIOUS_VERSION" != "$VERSION" ] || return 0
  # The version the app last ran, for migrate_hint on a rerun, when `.env`
  # already names the new one. An unfinished earlier update's stays: the app
  # has not run since.
  if [ -n "$PREVIOUS_VERSION" ] && [ ! -f "$DIR/.previous-version" ]; then
    printf '%s\n' "$PREVIOUS_VERSION" >"$DIR/.previous-version"
  fi
  step "Moving LIEDMOTIF_VERSION in .env from ${PREVIOUS_VERSION:-unset} to $VERSION"
  set_env "$DIR/.env" LIEDMOTIF_VERSION "$VERSION"
}

migrate_hint() {
  local hint="look at '$DOCKER_SHOWN compose logs migrate' in $DIR. If you can fix the cause (a full disk, for example), fix it and run the same command again. If not, restore the last backup from before this update"
  local back=$PREVIOUS_VERSION
  if [ -f "$DIR/.previous-version" ]; then back=$(cat "$DIR/.previous-version"); fi
  [ -z "$back" ] || [ "$back" = "$VERSION" ] ||
    hint="$hint and go back to $back"
  printf '%s: see https://liedmotif.com/docs/updates/#if-an-update-fails.' "$hint"
}

# `localhost` gets its certificate from Caddy's internal CA, which this machine
# does not trust; every other name must present a certificate that verifies.
# On the tailnet, Caddy listens on the Tailscale address alone, so the check
# goes there whatever this machine's own DNS makes of the name.
health_check() {
  local opts=(-fsS -o /dev/null --max-time 10)
  case $MODE in
    localhost) opts+=(--insecure) ;;
    tailnet) opts+=(--resolve "$APP_DOMAIN:443:$TAILSCALE_IP") ;;
  esac
  curl "${opts[@]}" "$1" 2>&1
}

verify() {
  local url="https://$APP_DOMAIN/api/health" deadline last code hint
  step "Waiting for Liedmotif to answer at $url"
  deadline=$((SECONDS + HEALTH_TIMEOUT))
  until last=$(health_check "$url"); do
    code=$?
    if [ "$SECONDS" -ge "$deadline" ]; then
      hint="look at '$DOCKER_SHOWN compose ps' and '$DOCKER_SHOWN compose logs caddy web' in $DIR"
      case $MODE in
        tailnet)
          # curl 35: the TLS handshake failed; 60: the certificate does not verify.
          case $code in
            35 | 60)
              hint="make sure MagicDNS and HTTPS certificates are on: $TS_HTTPS_HELP. If they are, look at '$DOCKER_SHOWN compose logs caddy' in $DIR"
              ;;
          esac
          ;;
        domain)
          hint="make sure the DNS record for $APP_DOMAIN points at this server and ports 80 and 443 are open to the internet (Caddy needs both to get its certificate), and $hint"
          ;;
      esac
      fail "Liedmotif did not answer within $HEALTH_TIMEOUT seconds (last answer: ${last:-none})." \
        "$hint. Then run the same command again."
    fi
    sleep "$HEALTH_INTERVAL"
  done
}

# The command to run again later: this install's flags, minus a pinned version.
rerun_command() {
  local flags=''
  [ "$MODE" = tailnet ] || flags=" --domain $(printf '%q' "$APP_DOMAIN")"
  [ "$DIR" = "$DEFAULT_DIR" ] || flags="$flags --dir $(printf '%q' "$DIR")"
  if [ -n "$SOURCE_DIR" ]; then
    printf 'LIEDMOTIF_SOURCE_DIR=%q bash %q%s' "$SOURCE_DIR" "$SOURCE_DIR/docker/install.sh" "$flags"
  elif [ -n "$flags" ]; then
    printf 'curl -fsSL %s | bash -s --%s' "$INSTALLER_URL" "$flags"
  else
    printf 'curl -fsSL %s | bash' "$INSTALLER_URL"
  fi
}

# An update ends on the version and the URL alone.
finish() {
  say ''
  say "Liedmotif $VERSION is running at https://$APP_DOMAIN"
  rm -f "$DIR/.previous-version"
  [ -f "$DIR/.first-install" ] || return 0
  say ''
  say 'Open this link to create your Admin account:'
  say ''
  say "  https://$APP_DOMAIN/setup?token=$(env_value "$DIR/.env" SETUP_TOKEN)"
  say ''
  if [ "$MODE" = tailnet ]; then
    say 'It opens only on devices in your tailnet. Install Tailscale on your phone'
    say '(https://tailscale.com/download) and sign in to the same tailnet as this machine.'
    say ''
  fi
  say "Copy $DIR/.env somewhere safe, such as a password manager or a USB stick."
  say 'It holds keys that cannot be recovered: without it, your stored provider keys'
  say 'and encrypted backups cannot be read.'
  say ''
  say 'To update later, run the same command again:'
  say ''
  say "  $(rerun_command)"
  rm -f "$DIR/.first-install"
}

main() {
  parse_args "$@"
  # Any other failing command stops the install the same way. Only the main
  # shell reports, so a failure inside `$(...)` is named once.
  trap '[ "$BASH_SUBSHELL" -gt 0 ] || fail "the command above failed." "fix what it names, then run the same command again."' ERR
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/liedmotif-install.XXXXXX")
  trap 'rm -rf "$TMP"' EXIT
  preflight
  choose_mode
  check_dns
  ensure_docker
  check_other_install
  check_storage
  ensure_security_updates
  if [ -n "$SOURCE_DIR" ]; then copy_checkout; else download_release; fi
  ensure_tailscale
  write_env
  start_stack
  verify
  finish
}

# In braces, so a download cut off inside this line runs nothing at all.
{ main "$@"; }
