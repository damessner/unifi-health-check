#!/bin/bash
# =========================================================================
# UniFi Network Health Analyzer - Debian LXC Auto-Installer & Docker Host
# =========================================================================
# This script automates the installation of Docker, Git, configurations,
# and starts the service container on a unique port (2943) inside Debian LXC.
#
# One-liner execution:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/damessner/unifi-health-check/main/setup-lxc.sh)"
# =========================================================================

# Colors for modern terminal logs
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}
log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}
log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}
log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Exit immediately if a command exits with a non-zero status
set -e

# Clear screen and draw a beautiful banner
clear
echo -e "${CYAN}${BOLD}"
echo "================================================================="
echo "   UniFi Network Health Analyzer - Debian LXC Docker Installer   "
echo "================================================================="
echo -e "${NC}"

# 1. Root privilege check
if [ "$(id -u)" -ne 0 ]; then
    log_error "This script must be run as root (or via sudo)."
    exit 1
fi

# 2. Check interactive environment
NON_INTERACTIVE=false
if [ ! -t 0 ] || [ "$DEBIAN_FRONTEND" = "noninteractive" ]; then
    NON_INTERACTIVE=true
    log_info "Running in non-interactive mode. Default values will be applied automatically."
fi

# 3. Check and Install Prerequisite: Curl
if ! command -v curl >/dev/null 2>&1; then
    log_info "curl is missing. Installing curl..."
    apt-get update -y && apt-get install -y curl
fi

# 4. Check and Install Docker & Docker Compose
log_info "Verifying Docker installation..."
DOCKER_INSTALLED=false

if command -v docker >/dev/null 2>&1; then
    DOCKER_INSTALLED=true
    log_success "Docker is already installed ($(docker --version | awk '{print $3}' | tr -d ','))"
else
    log_info "Docker is not installed. Beginning official Docker installation..."
    # Update packages and install prereqs
    apt-get update -y
    apt-get install -y ca-certificates gnupg git
    
    # Run official Docker installation script
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
    
    # Enable and start docker daemon
    systemctl enable --now docker
    log_success "Docker installed and enabled successfully."
fi

# Check Docker Compose status
log_info "Verifying Docker Compose V2 status..."
if docker compose version >/dev/null 2>&1; then
    log_success "Docker Compose V2 is active ($(docker compose version | awk '{print $4}'))"
else
    log_warning "Docker Compose subcommand not found. Installing docker-compose-plugin..."
    apt-get update -y
    apt-get install -y docker-compose-plugin
    log_success "Docker Compose V2 installed successfully."
fi

# 5. Check if Docker daemon is responsive (crucial check inside Proxmox LXCs)
if ! docker info >/dev/null 2>&1; then
    log_error "Docker is installed but the service is not running or accessible."
    log_error "If running in a Proxmox LXC container, make sure that 'Nesting' is enabled!"
    log_error "To fix: Go to Proxmox -> Container -> Options -> Features -> Edit -> Tick Nesting."
    exit 1
fi

# 6. Check and Install Git
if ! command -v git >/dev/null 2>&1; then
    log_info "Git is missing. Installing git..."
    apt-get update -y
    apt-get install -y git
fi

# 7. Clone Repository to /opt
PROJECT_DIR="/opt/unifi-health-check"
log_info "Setting up repository directory..."

if [ -d "$PROJECT_DIR" ]; then
    log_info "Directory $PROJECT_DIR already exists. Pulling latest code..."
    cd "$PROJECT_DIR"
    git pull || log_warning "Failed to pull updates. Proceeding with existing code."
else
    log_info "Cloning UniFi Network Health Check into $PROJECT_DIR..."
    git clone https://github.com/damessner/unifi-health-check.git "$PROJECT_DIR"
    cd "$PROJECT_DIR"
fi

# 8. Configure Environment variables
ENV_FILE="$PROJECT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
    log_success "An existing configuration file (.env) was found."
    log_info "To reconfigure, delete $ENV_FILE and run this script again."
else
    log_info "Configuring application variables..."
    
    # Setup helper for prompts
    prompt_var() {
        local prompt="$1"
        local default="$2"
        local var_name="$3"
        local val
        
        if [ "$NON_INTERACTIVE" = "true" ]; then
            declare -g "$var_name"="$default"
            return
        fi
        
        echo -ne "${BOLD}${CYAN}$prompt${NC} [Default: ${GREEN}$default${NC}]: "
        read -r val
        if [ -z "$val" ]; then
            declare -g "$var_name"="$default"
        else
            declare -g "$var_name"="$val"
        fi
    }
    
    echo -e "\n${BOLD}${MAGENTA}--- Configuration Wizard ---${NC}"
    echo -e "Press [Enter] to keep the default values.\n"
    
    prompt_var "UniFi Controller Host/IP" "unifi-controller.local" "CONF_HOST"
    prompt_var "UniFi Controller Port   " "8443" "CONF_PORT"
    prompt_var "UniFi Username          " "observer" "CONF_USER"
    prompt_var "UniFi Password          " "" "CONF_PASS"
    prompt_var "UniFi Site Name         " "default" "CONF_SITE"
    prompt_var "Dashboard External Port " "2943" "CONF_HOST_PORT"
    
    echo -e "${BOLD}${MAGENTA}----------------------------${NC}\n"
    
    # Generate the .env file
    cat <<EOF > "$ENV_FILE"
# Generated on $(date)
UNIFI_HOST=$CONF_HOST
UNIFI_PORT=$CONF_PORT
UNIFI_USER=$CONF_USER
UNIFI_PASS=$CONF_PASS
UNIFI_SITE=$CONF_SITE
PORT=3445
CACHE_EXPIRY_SEC=15
HOST_PORT=$CONF_HOST_PORT
API_TOKEN=
UNIFI_ALLOW_SELF_SIGNED=false
EOF
    
    log_success "Environment config (.env) successfully generated!"
fi

# 9. Build and Launch using Docker Compose
log_info "Building and launching UniFi Health Check via Docker Compose..."
docker compose pull || true # Pull base images if possible
docker compose up -d --build

# 10. Fetch LXC Container IP
IP_ADDRESS=$(hostname -I | awk '{print $1}')
if [ -z "$IP_ADDRESS" ]; then
    IP_ADDRESS="localhost"
fi

# Retrieve Host Port
PORT_CONFIGURED=$(grep '^HOST_PORT=' "$ENV_FILE" | cut -d'=' -f2 || echo "2943")
if [ -z "$PORT_CONFIGURED" ]; then
    PORT_CONFIGURED="2943"
fi

# Clear screen for final result presentation
clear
echo -e "${GREEN}${BOLD}"
echo "================================================================="
echo "   🎉 UniFi Network Health Analyzer is successfully deployed! 🎉"
echo "================================================================="
echo -e "${NC}"
echo -e "The application is running inside a Docker container on port ${BOLD}${PORT_CONFIGURED}${NC}."
echo -e "\nAccess the dashboard from your browser:"
echo -e "   👉  ${BOLD}${CYAN}http://${IP_ADDRESS}:${PORT_CONFIGURED}${NC}"
echo -e "   👉  ${BOLD}${CYAN}http://localhost:${PORT_CONFIGURED}${NC}"
echo -e "\n-----------------------------------------------------------------"
echo -e "${BOLD}Useful Commands (run inside $PROJECT_DIR):${NC}"
echo -e "  - View live application logs:  ${CYAN}docker compose logs -f${NC}"
echo -e "  - Restart the container:      ${CYAN}docker compose restart${NC}"
echo -e "  - Stop the dashboard service: ${CYAN}docker compose down${NC}"
echo -e "  - Update to the latest version: ${CYAN}git pull && docker compose up -d --build${NC}"
echo "================================================================="
echo ""
