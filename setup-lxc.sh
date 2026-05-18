#!/bin/bash
# =========================================================================
# UniFi Network Health Analyzer - Proxmox / Debian Installer + Updater
# =========================================================================
# Installer:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/damessner/unifi-health-check/main/setup-lxc.sh)"
# Updater:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/damessner/unifi-health-check/main/setup-lxc.sh)" -- --update-only
# =========================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

DEFAULT_HOST_PORT='38443'
PROJECT_DIR='/opt/unifi-health-check'
ENV_FILE="$PROJECT_DIR/.env"
MODE='install'
FORCE_NON_INTERACTIVE='false'
CUSTOM_HOST_PORT=''

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --update-only)
      MODE='update'
      ;;
    --non-interactive)
      FORCE_NON_INTERACTIVE='true'
      ;;
    --host-port)
      shift
      CUSTOM_HOST_PORT="$1"
      ;;
    *)
      log_warning "Ignoring unknown argument: $1"
      ;;
  esac
  shift
done

clear
printf "%b\n" "${CYAN}${BOLD}================================================================="
printf "%b\n" "   UniFi Network Health Analyzer - Proxmox Installer & Updater   "
printf "%b\n" "=================================================================${NC}"

if [ "$(id -u)" -ne 0 ]; then
  log_error 'This script must be run as root (or via sudo).'
  exit 1
fi

NON_INTERACTIVE='false'
if [ ! -t 0 ] || [ "$DEBIAN_FRONTEND" = 'noninteractive' ] || [ "$FORCE_NON_INTERACTIVE" = 'true' ]; then
  NON_INTERACTIVE='true'
  log_info 'Running in non-interactive mode. Saved configuration or defaults will be used.'
fi

if ! command -v curl >/dev/null 2>&1; then
  log_info 'curl is missing. Installing curl...'
  apt-get update -y && apt-get install -y curl
fi

log_info 'Verifying Docker installation...'
if command -v docker >/dev/null 2>&1; then
  log_success "Docker is already installed ($(docker --version | awk '{print $3}' | tr -d ','))"
else
  log_info 'Docker is not installed. Beginning official Docker installation...'
  apt-get update -y
  apt-get install -y ca-certificates gnupg git
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
  systemctl enable --now docker
  log_success 'Docker installed and enabled successfully.'
fi

log_info 'Verifying Docker Compose V2 status...'
if docker compose version >/dev/null 2>&1; then
  log_success "Docker Compose V2 is active ($(docker compose version | awk '{print $4}'))"
else
  log_warning 'Docker Compose subcommand not found. Installing docker-compose-plugin...'
  apt-get update -y
  apt-get install -y docker-compose-plugin
  log_success 'Docker Compose V2 installed successfully.'
fi

if ! docker info >/dev/null 2>&1; then
  log_error "Docker is installed but the service is not running or accessible."
  log_error "If running in a Proxmox LXC container, make sure 'Nesting' is enabled."
  log_error "Fix: Proxmox -> Container -> Options -> Features -> Edit -> Tick Nesting."
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  log_info 'Git is missing. Installing git...'
  apt-get update -y
  apt-get install -y git
fi

log_info "Preparing repository in $PROJECT_DIR..."
if [ -d "$PROJECT_DIR/.git" ]; then
  cd "$PROJECT_DIR"
  git pull --ff-only || log_warning 'Failed to pull the latest code. Continuing with the existing checkout.'
else
  rm -rf "$PROJECT_DIR"
  git clone https://github.com/damessner/unifi-health-check.git "$PROJECT_DIR"
  cd "$PROJECT_DIR"
fi

prompt_var() {
  local prompt="$1"
  local default="$2"
  local var_name="$3"
  local value

  if [ "$NON_INTERACTIVE" = 'true' ]; then
    declare -g "$var_name"="$default"
    return
  fi

  printf "%b" "${BOLD}${CYAN}$prompt${NC} [Default: ${GREEN}$default${NC}]: "
  read -r value
  if [ -z "$value" ]; then
    declare -g "$var_name"="$default"
  else
    declare -g "$var_name"="$value"
  fi
}

write_env_file() {
  cat > "$ENV_FILE" <<ENVEOF
# Generated on $(date)
UNIFI_HOST=$CONF_HOST
UNIFI_PORT=$CONF_PORT
UNIFI_USER=$CONF_USER
UNIFI_PASS=$CONF_PASS
UNIFI_SITE=$CONF_SITE
UNIFI_TIMEOUT_MS=10000
PORT=3000
CACHE_EXPIRY_SEC=15
HISTORY_MAX_SAMPLES=288
HOST_PORT=$CONF_HOST_PORT
ENVEOF
}

if [ -f "$ENV_FILE" ]; then
  log_success 'Existing configuration (.env) found.'
  if [ -n "$CUSTOM_HOST_PORT" ]; then
    if grep -q '^HOST_PORT=' "$ENV_FILE"; then
      sed -i "s/^HOST_PORT=.*/HOST_PORT=$CUSTOM_HOST_PORT/" "$ENV_FILE"
    else
      echo "HOST_PORT=$CUSTOM_HOST_PORT" >> "$ENV_FILE"
    fi
    log_success "Updated HOST_PORT to $CUSTOM_HOST_PORT"
  fi
elif [ "$MODE" = 'update' ]; then
  log_warning 'No existing .env file was found during update mode. Falling back to install workflow.'
  MODE='install'
fi

if [ ! -f "$ENV_FILE" ]; then
  log_info 'Configuring application variables...'
  printf "\n%b\n" "${BOLD}${MAGENTA}--- Configuration Wizard ---${NC}"
  printf "%b\n\n" 'Press [Enter] to keep the default values.'

  prompt_var 'UniFi Controller Host/IP' '172.16.0.200' 'CONF_HOST'
  prompt_var 'UniFi Controller Port   ' '8443' 'CONF_PORT'
  prompt_var 'UniFi Username          ' 'observer' 'CONF_USER'
  prompt_var 'UniFi Password          ' 'change-me' 'CONF_PASS'
  prompt_var 'UniFi Site Name         ' 'default' 'CONF_SITE'
  prompt_var 'Dashboard External Port ' "${CUSTOM_HOST_PORT:-$DEFAULT_HOST_PORT}" 'CONF_HOST_PORT'

  printf "%b\n\n" "${BOLD}${MAGENTA}----------------------------${NC}"
  write_env_file
  log_success 'Environment config (.env) successfully generated.'
fi

if grep -q '^UNIFI_PASS=change-me$' "$ENV_FILE"; then
  log_warning 'UNIFI_PASS is still set to the placeholder value change-me. Update /opt/unifi-health-check/.env before relying on production telemetry.'
fi

PORT_CONFIGURED=$(grep '^HOST_PORT=' "$ENV_FILE" | tail -n 1 | cut -d'=' -f2)
if [ -z "$PORT_CONFIGURED" ]; then
  PORT_CONFIGURED="$DEFAULT_HOST_PORT"
  echo "HOST_PORT=$PORT_CONFIGURED" >> "$ENV_FILE"
fi

log_info "Launching UniFi Health Check in $MODE mode on host port $PORT_CONFIGURED..."
docker compose pull || true
docker compose up -d --build

IP_ADDRESS=$(hostname -I | awk '{print $1}')
if [ -z "$IP_ADDRESS" ]; then
  IP_ADDRESS='localhost'
fi

clear
printf "%b\n" "${GREEN}${BOLD}================================================================="
printf "%b\n" "   🎉 UniFi Network Health Analyzer is successfully deployed! 🎉"
printf "%b\n" "=================================================================${NC}"
printf "%b\n" "Mode: ${BOLD}${MODE}${NC}"
printf "%b\n" "Dashboard port: ${BOLD}${PORT_CONFIGURED}${NC}"
printf "\n%b\n" 'Access the dashboard from your browser:'
printf "%b\n" "   👉  ${BOLD}${CYAN}http://${IP_ADDRESS}:${PORT_CONFIGURED}${NC}"
printf "%b\n" "   👉  ${BOLD}${CYAN}http://localhost:${PORT_CONFIGURED}${NC}"
printf "%b\n" '-----------------------------------------------------------------'
printf "%b\n" "${BOLD}Copy/paste commands for Proxmox shell:${NC}"
printf "%b\n" "  Installer: ${CYAN}bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/damessner/unifi-health-check/main/setup-lxc.sh)\"${NC}"
printf "%b\n" "  Updater:   ${CYAN}bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/damessner/unifi-health-check/main/setup-lxc.sh)\" -- --update-only${NC}"
printf "\n%b\n" "${BOLD}Useful Commands (run inside $PROJECT_DIR):${NC}"
printf "%b\n" "  - View live application logs:  ${CYAN}docker compose logs -f${NC}"
printf "%b\n" "  - Restart the container:      ${CYAN}docker compose restart${NC}"
printf "%b\n" "  - Stop the dashboard service: ${CYAN}docker compose down${NC}"
printf "%b\n" "  - Update to the latest version: ${CYAN}bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/damessner/unifi-health-check/main/setup-lxc.sh)\" -- --update-only${NC}"
printf "%b\n\n" '================================================================='
