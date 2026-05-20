#!/bin/bash
# =========================================================================
# UniFi Network Health Analyzer - Proxmox VE Host LXC Creator
# =========================================================================
# This script is designed to run directly on the Proxmox VE Host Shell.
# It automatically provisions a lightweight, unprivileged Debian LXC container,
# configures keyctl/nesting (Docker requirements), boots it, and deploys
# the UniFi Network Health Analyzer automatically with no passwords or logins.
#
# One-liner execution:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/damessner/unifi-health-check/main/proxmox-install.sh)"
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
echo "   UniFi Network Health Analyzer - Proxmox LXC Auto-Provisioner  "
echo "================================================================="
echo -e "${NC}"

# 1. Proxmox VE & Root privilege check
if [ "$(id -u)" -ne 0 ]; then
    log_error "This installer must be run as root on the Proxmox VE host."
    exit 1
fi

if [ ! -d "/etc/pve" ]; then
    log_error "Proxmox VE configuration directory not found. Are you running this on Proxmox?"
    exit 1
fi

# 2. Automatically detect next VMID
log_info "Detecting next available Container ID (VMID)..."
NEXT_VMID=$(pvesh get /cluster/nextid 2>/dev/null | tr -d '"' || true)

if [ -z "$NEXT_VMID" ] || ! [[ "$NEXT_VMID" =~ ^[0-9]+$ ]]; then
    NEXT_VMID=100
fi

# Scan upwards to ensure the assigned VMID is not already in use by pct or qm
while pct status "$NEXT_VMID" >/dev/null 2>&1 || qm status "$NEXT_VMID" >/dev/null 2>&1; do
    NEXT_VMID=$((NEXT_VMID + 1))
done
log_success "Assigned Container ID: ${BOLD}${NEXT_VMID}${NC}"

# 3. Automatically detect Storage
log_info "Scanning Proxmox storage volumes..."
# Find storage supporting templates (vztmpl)
STORAGE_TEMPLATES=$(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1 {print $1}' | head -n1 || true)
# Find storage supporting container filesystems (rootdir)
STORAGE_ROOTFS=$(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 {print $1}' | head -n1 || true)

# Default fallbacks
STORAGE_TEMPLATES=${STORAGE_TEMPLATES:-local}
STORAGE_ROOTFS=${STORAGE_ROOTFS:-local}

log_success "Templates storage: ${BOLD}${STORAGE_TEMPLATES}${NC}"
log_success "Container rootfs storage: ${BOLD}${STORAGE_ROOTFS}${NC}"

# 4. Automatically detect Network Bridge
log_info "Identifying active network bridge..."
BRIDGE_NAME=""
if ip link show dev vmbr0 >/dev/null 2>&1; then
    BRIDGE_NAME="vmbr0"
else
    # Query for any active bridges
    BRIDGE_NAME=$(ip link show | grep -o 'vmbr[0-9]\+' | head -n1 || true)
fi

if [ -z "$BRIDGE_NAME" ]; then
    BRIDGE_NAME="vmbr0"
    log_warning "No network bridge starting with 'vmbr' found. Defaulting to 'vmbr0'."
else
    log_success "Found active network bridge: ${BOLD}${BRIDGE_NAME}${NC}"
fi

# 5. Retrieve latest Debian LXC Template
log_info "Updating Proxmox template catalog..."
pveam update >/dev/null 2>&1 || log_warning "Failed to update Proxmox template index. Using cached values."

log_info "Locating latest Debian 12 LXC template..."
TEMPLATE_FILE=$(pveam available | grep "debian-12-standard" | head -n1 | awk '{print $2}' || true)

if [ -z "$TEMPLATE_FILE" ]; then
    # Explicit fallback if list is unreachable
    TEMPLATE_FILE="debian-12-standard_12.7-1_amd64.tar.zst"
fi

log_info "Checking template presence: $TEMPLATE_FILE..."
if ! pveam list "$STORAGE_TEMPLATES" 2>/dev/null | grep -q "$TEMPLATE_FILE"; then
    log_info "Downloading LXC template to storage: $STORAGE_TEMPLATES..."
    pveam download "$STORAGE_TEMPLATES" "$TEMPLATE_FILE"
else
    log_success "Debian 12 standard template is already downloaded."
fi

# 6. Create the LXC Container
log_info "Creating a lightweight unprivileged Debian 12 LXC container..."
log_info "Container Configuration: Cores=2, RAM=2GB, Storage=8GB, Nesting=enabled, Keyctl=enabled"
GENERATED_ROOT_PASS="$(tr -dc 'A-Za-z0-9!@#%^_+=' </dev/urandom | head -c 24)"
CREDENTIALS_FILE="/root/unifi-health-check-${NEXT_VMID}.credentials"

pct create "$NEXT_VMID" "${STORAGE_TEMPLATES}:vztmpl/${TEMPLATE_FILE}" \
    -cores 2 \
    -memory 2048 \
    -net0 "name=eth0,bridge=${BRIDGE_NAME},ip=dhcp" \
    -features "nesting=1,keyctl=1" \
    -storage "$STORAGE_ROOTFS" \
    -hostname "unifi-health-check" \
    -password "$GENERATED_ROOT_PASS" \
    -onboot 1 \
    -unprivileged 1

log_success "LXC Container ${BOLD}${NEXT_VMID}${NC} created successfully!"
cat > "$CREDENTIALS_FILE" <<EOF
LXC_ID=${NEXT_VMID}
ROOT_PASSWORD=${GENERATED_ROOT_PASS}
EOF
chmod 600 "$CREDENTIALS_FILE"

# 7. Apply LXC security overrides required for nested Docker virtualization
#    Without these, Docker daemon fails inside unprivileged containers on recent
#    Debian/Proxmox hosts due to AppArmor CVE-2025-52881 containerd restrictions.
log_info "Applying AppArmor bypass for nested Docker inside LXC..."
cat >> "/etc/pve/lxc/${NEXT_VMID}.conf" << 'LXCEOF'
lxc.apparmor.profile: unconfined
lxc.mount.entry: /dev/null sys/module/apparmor/parameters/enabled none bind 0 0
LXCEOF

# If Proxmox storage is ZFS-based, also bind /dev/fuse for overlay2 compatibility
if zfs list > /dev/null 2>&1; then
    log_info "ZFS storage detected. Adding /dev/fuse mount for overlay2 compatibility..."
    echo 'lxc.mount.entry: /dev/fuse dev/fuse none bind,create=file 0 0' >> "/etc/pve/lxc/${NEXT_VMID}.conf"
    log_success "ZFS fuse mount entry added."
fi

log_success "LXC security overrides applied successfully."

# 8. Start the container and wait for IP
log_info "Starting LXC container..."
pct start "$NEXT_VMID"

log_info "Waiting for network initialization inside the container..."
sleep 5

CONTAINER_IP=""
for i in {1..15}; do
    CONTAINER_IP=$(pct exec "$NEXT_VMID" -- hostname -I 2>/dev/null | awk '{print $1}' || true)
    if [ -n "$CONTAINER_IP" ] && [[ "$CONTAINER_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        break
    fi
    log_info "Still waiting for DHCP lease (Attempt $i/15)..."
    sleep 2
done

if [ -z "$CONTAINER_IP" ]; then
    log_warning "Could not retrieve container IP automatically. Proceeding anyway."
    CONTAINER_IP="[LXC_IP]"
else
    log_success "Container network is online! IP Address: ${BOLD}${CYAN}${CONTAINER_IP}${NC}"
fi

# 9. Deploy dependencies and application inside LXC
log_info "Executing Docker & Application Auto-Installer inside the container..."
log_info "This will automate the setup of Docker, Docker-compose, pull the code, and launch on port 2943."

# Execute the LXC setup script inside the container using pct exec
# We first ensure curl is installed to prevent bootstrap failures
pct exec "$NEXT_VMID" -- bash -c "DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y curl"
pct exec "$NEXT_VMID" -- bash -c "curl -fsSL https://raw.githubusercontent.com/damessner/unifi-health-check/main/setup-lxc.sh | DEBIAN_FRONTEND=noninteractive bash"

# Retrieve external port configured (default 2943)
PORT_CONFIGURED="2943"

# Clear host screen for final report
clear
echo -e "${GREEN}${BOLD}"
echo "================================================================="
echo "   🎉 Proxmox LXC & UniFi Analyzer Successfully Deployed! 🎉"
echo "================================================================="
echo -e "${NC}"
echo -e "A lightweight and secure Debian LXC container has been"
echo -e "provisioned and configured with nested Docker virtualization."
echo ""
echo -e "Container Details:"
echo -e "  - ${BOLD}LXC ID:${NC}        ${CYAN}${NEXT_VMID}${NC}"
echo -e "  - ${BOLD}Hostname:${NC}      unifi-health-check"
echo -e "  - ${BOLD}Status:${NC}        ${GREEN}Running${NC}"
echo -e "  - ${BOLD}IP Address:${NC}    ${CYAN}${CONTAINER_IP}${NC}"
echo -e "  - ${BOLD}Credentials:${NC}  ${CYAN}${CREDENTIALS_FILE}${NC} (chmod 600)"
echo ""
echo -e "Access the UniFi Health Check Dashboard:"
echo -e "  👉  ${BOLD}${CYAN}http://${CONTAINER_IP}:${PORT_CONFIGURED}${NC}"
echo ""
echo -e "-----------------------------------------------------------------"
echo -e "${BOLD}Management commands on Proxmox host:${NC}"
echo -e "  - Enter container shell:               ${CYAN}pct enter ${NEXT_VMID}${NC}"
echo -e "  - Stop container:                      ${CYAN}pct stop ${NEXT_VMID}${NC}"
echo -e "  - Start container:                     ${CYAN}pct start ${NEXT_VMID}${NC}"
echo -e "  - Reboot container:                    ${CYAN}pct reboot ${NEXT_VMID}${NC}"
echo "================================================================="
echo ""
