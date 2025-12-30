#!/bin/bash

# Brisk Budget - One-Line Installer/Updater for Ubuntu
#
# Install or update with:
#   curl -fsSL https://raw.githubusercontent.com/CoppingEthan/Brisk-Budget/main/deploy.sh | sudo bash
#
# Or with wget:
#   wget -qO- https://raw.githubusercontent.com/CoppingEthan/Brisk-Budget/main/deploy.sh | sudo bash

set -e

# Configuration
APP_NAME="brisk-budget"
APP_DIR="/opt/brisk-budget"
APP_USER="brisk-budget"
APP_PORT="${PORT:-3000}"
NODE_VERSION="20"
REPO_URL="https://github.com/CoppingEthan/Brisk-Budget.git"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

echo ""
echo "============================================"
echo -e "${GREEN}Brisk Budget Installer${NC}"
echo "============================================"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    log_error "Please run as root:"
    echo "  curl -fsSL https://raw.githubusercontent.com/CoppingEthan/Brisk-Budget/main/deploy.sh | sudo bash"
    exit 1
fi

# Detect if this is an update or fresh install
if [ -d "$APP_DIR/.git" ]; then
    IS_UPDATE=true
    log_info "Existing installation detected - updating..."
else
    IS_UPDATE=false
    log_info "Fresh installation starting..."
fi

# Install dependencies
log_step "Checking system dependencies..."

apt-get update -qq

# Install git if not present
if ! command -v git &> /dev/null; then
    log_info "Installing git..."
    apt-get install -y -qq git
fi

# Install Node.js if not present
if ! command -v node &> /dev/null; then
    log_info "Installing Node.js ${NODE_VERSION}..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y -qq nodejs
else
    log_info "Node.js already installed: $(node --version)"
fi

# Create application user if not exists
if ! id "$APP_USER" &>/dev/null; then
    log_info "Creating application user: ${APP_USER}"
    useradd --system --no-create-home --shell /bin/false "$APP_USER"
fi

# Clone or update repository
log_step "Fetching latest code from GitHub..."

if [ "$IS_UPDATE" = true ]; then
    # Update existing installation
    # Fix ownership issue - add safe directory for git operations
    git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true

    cd "$APP_DIR"

    # Stash any local changes (like data files that shouldn't be there)
    git stash --quiet 2>/dev/null || true

    # Pull latest changes
    git fetch origin
    git reset --hard origin/main

    log_info "Code updated to latest version"
else
    # Fresh install - clone repository
    log_info "Cloning repository..."
    rm -rf "$APP_DIR"
    git clone "$REPO_URL" "$APP_DIR"
    cd "$APP_DIR"
fi

# Create data and backups directories (preserve existing data)
mkdir -p "$APP_DIR/data"
mkdir -p "$APP_DIR/backups"

# Install npm dependencies
log_step "Installing npm dependencies..."
cd "$APP_DIR"
npm install --production --silent

# Set ownership
log_info "Setting file permissions..."
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# Create/update systemd service
log_step "Configuring systemd service..."
cat > /etc/systemd/system/${APP_NAME}.service << EOF
[Unit]
Description=Brisk Budget - Personal Finance Management
Documentation=https://github.com/CoppingEthan/Brisk-Budget
After=network.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=${APP_NAME}
Environment=NODE_ENV=production
Environment=PORT=${APP_PORT}

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}/data ${APP_DIR}/backups
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd and restart service
systemctl daemon-reload
systemctl enable "$APP_NAME" --quiet

if [ "$IS_UPDATE" = true ]; then
    log_info "Restarting service..."
    systemctl restart "$APP_NAME"
else
    log_info "Starting service..."
    systemctl start "$APP_NAME"
fi

# Wait and check status
sleep 2
if systemctl is-active --quiet "$APP_NAME"; then
    log_info "Service running successfully!"
else
    log_error "Service failed to start. Check logs with: journalctl -u ${APP_NAME}"
    exit 1
fi

# Print summary
echo ""
echo "============================================"
if [ "$IS_UPDATE" = true ]; then
    echo -e "${GREEN}Brisk Budget updated successfully!${NC}"
else
    echo -e "${GREEN}Brisk Budget installed successfully!${NC}"
fi
echo "============================================"
echo ""
echo "Application URL: http://localhost:${APP_PORT}"
echo ""
echo "Useful commands:"
echo "  View logs:      journalctl -u ${APP_NAME} -f"
echo "  Restart:        systemctl restart ${APP_NAME}"
echo "  Stop:           systemctl stop ${APP_NAME}"
echo "  Status:         systemctl status ${APP_NAME}"
echo ""
echo "To update in the future, run the same install command:"
echo "  curl -fsSL https://raw.githubusercontent.com/CoppingEthan/Brisk-Budget/main/deploy.sh | sudo bash"
echo ""
