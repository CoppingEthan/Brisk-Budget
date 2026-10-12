#!/bin/bash
# brisk-deploy-protocol: 2
#
# Brisk Budget - one-line installer and updater for Ubuntu / Debian
#
#   Install or update:      curl -fsSL https://raw.githubusercontent.com/CoppingEthan/Brisk-Budget/main/deploy.sh | sudo bash
#   Turn on auto-updates:   curl -fsSL https://raw.githubusercontent.com/CoppingEthan/Brisk-Budget/main/deploy.sh | sudo bash -s -- --auto-update
#   Turn off auto-updates:  ... | sudo bash -s -- --no-auto-update
#   Use another branch:     ... | sudo bash -s -- <branch>
#
# Updating keeps your data. Before anything changes, the app is stopped and its data folder is
# backed up. If anything goes wrong, the previous version and its data are put back.
#
# Settings such as PORT, HOST, TZ or BRISK_ALLOWED_HOSTS go in /etc/default/brisk-budget (one
# NAME=value per line). Updates never change that file.

# -E: the rollback trap also fires inside functions
set -Eeuo pipefail
umask 022

# Git and npm keep their settings in HOME. Under sudo -E or systemd it can be someone else's
# folder or missing, so always use root's.
export HOME=/root

APP_NAME="brisk-budget"
APP_DIR="/opt/brisk-budget"
APP_USER="brisk-budget"
REPO_URL="${BRISK_REPO_URL:-https://github.com/CoppingEthan/Brisk-Budget.git}"   # override to install from a fork
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
UPDATE_SERVICE="/etc/systemd/system/${APP_NAME}-update.service"
UPDATE_TIMER="/etc/systemd/system/${APP_NAME}-update.timer"
ENV_FILE="/etc/default/${APP_NAME}"
STATE_DIR="/var/lib/${APP_NAME}"
UPDATER="/usr/local/lib/${APP_NAME}/deploy.sh"   # the copy the nightly update runs
LOCK_FILE="/run/${APP_NAME}-deploy.lock"
MIN_NODE=20
INSTALL_NODE=24
KEEP_PRE_UPDATE=5
MIN_FREE_MB=300

BRANCH=""
BRANCH_GIVEN=false
AUTO_UPDATE=""          # "on", "off" or "" (leave as it is)
UNATTENDED=false        # set by the nightly timer
CONTINUE=false          # second half of an update, run from the freshly downloaded script
PREV_COMMIT=""
TARGET_COMMIT=""
PRE_UPDATE_BACKUP=""

need_value() { if [ -z "${2:-}" ] || [[ "$2" == --* ]]; then echo "$1 needs a value" >&2; exit 2; fi; }
while [ $# -gt 0 ]; do
  case "$1" in
    --auto-update) AUTO_UPDATE="on" ;;
    --no-auto-update) AUTO_UPDATE="off" ;;
    --unattended) UNATTENDED=true ;;
    --branch) need_value "$1" "${2:-}"; BRANCH="$2"; BRANCH_GIVEN=true; shift ;;
    --continue) CONTINUE=true ;;
    --prev) need_value "$1" "${2:-}"; PREV_COMMIT="$2"; shift ;;
    --target) need_value "$1" "${2:-}"; TARGET_COMMIT="$2"; shift ;;
    --backup) need_value "$1" "${2:-}"; PRE_UPDATE_BACKUP="$2"; shift ;;
    --*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) BRANCH="$1"; BRANCH_GIVEN=true ;;
  esac
  shift
done

if [ -t 1 ]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; BLUE=''; NC=''
fi
info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail() { echo -e "${RED}[ERROR]${NC} $1" >&2; }
step() { echo -e "${BLUE}[STEP]${NC} $1"; }

if [ "$(id -u)" -ne 0 ]; then
  fail "Please run as root, for example:"
  echo "  curl -fsSL https://raw.githubusercontent.com/CoppingEthan/Brisk-Budget/main/deploy.sh | sudo bash"
  exit 1
fi

# One install or update at a time (a manual run and the nightly one could otherwise overlap).
# The lock is held through the hand-over to the new script below.
if [ "$CONTINUE" = false ]; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    fail "Another Brisk Budget install or update is running. Try again when it has finished."
    exit 1
  fi
fi

# The install folder belongs to the app user; tell git (running as root) to trust it
if command -v git >/dev/null 2>&1 && ! git config --global --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR"; then
  git config --global --add safe.directory "$APP_DIR" || true
fi

# ----- Settings an existing install was set up with -----

# The value a setting has for the running service: /etc/default/brisk-budget wins over the
# service file and any drop-ins (systemctl edit), which is how systemd itself reads them
setting() {
  local name="$1" value=""
  if systemctl cat "$APP_NAME" >/dev/null 2>&1; then
    value="$(systemctl show -p Environment --value "$APP_NAME" 2>/dev/null | tr ' ' '\n' | sed -n "s/^${name}=//p" | tail -n1)"
  fi
  if [ -f "$ENV_FILE" ]; then
    local fromfile
    fromfile="$(sed -n "s/^[[:space:]]*${name}[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | tail -n1)"
    fromfile="${fromfile%\"}"; fromfile="${fromfile#\"}"
    [ -n "$fromfile" ] && value="$fromfile"
  fi
  echo "$value"
}

# Keep using the branch an existing install was set up with
current_branch() { git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true; }
if [ -z "$BRANCH" ]; then
  BRANCH="$(current_branch)"
  { [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; } && BRANCH="main"
fi

if [ -n "${PORT:-}" ]; then
  APP_PORT="$PORT"
else
  APP_PORT="$(setting PORT)"
  [ -z "$APP_PORT" ] && APP_PORT=3000
fi
if ! [[ "$APP_PORT" =~ ^[0-9]+$ ]] || [ "$APP_PORT" -lt 1 ] || [ "$APP_PORT" -gt 65535 ]; then
  fail "PORT must be a number from 1 to 65535 (got \"${APP_PORT}\")"
  exit 1
fi

# The address to check the app on: its own, if it only listens on one
HEALTH_HOST="127.0.0.1"
LISTEN_HOST="$(setting HOST)"
case "$LISTEN_HOST" in
  ""|0.0.0.0|::|"[::]") ;;
  *:*) HEALTH_HOST="[${LISTEN_HOST#[}"; HEALTH_HOST="${HEALTH_HOST%]}]" ;;
  *) HEALTH_HOST="$LISTEN_HOST" ;;
esac
app_url() { echo "http://${HEALTH_HOST}:${APP_PORT}$1"; }

# Where the data really lives (the data folder can be a link or a mount, or moved with
# BRISK_DATA_DIR / BRISK_BACKUPS_DIR)
DATA_DIR="$(setting BRISK_DATA_DIR)"; [ -z "$DATA_DIR" ] && DATA_DIR="$APP_DIR/data"
BACKUPS_DIR="$(setting BRISK_BACKUPS_DIR)"; [ -z "$BACKUPS_DIR" ] && BACKUPS_DIR="$APP_DIR/backups"
real_path() { readlink -f "$1" 2>/dev/null || echo "$1"; }

# Brisk Budget is up and is the version just installed (not something else on the same port).
# It must also still be running a few seconds later, which catches crash loops.
health_check() {
  local want="$1" tries=0 body
  while [ $tries -lt 60 ]; do
    body="$(curl -fsS --max-time 2 "$(app_url /api/health)" 2>/dev/null || true)"
    if [[ "$body" == *'"ok":true'* ]] && { [ -z "$want" ] || [[ "$body" == *"\"version\":\"${want}\""* ]]; }; then
      sleep 3
      if systemctl is-active --quiet "$APP_NAME" && curl -fsS --max-time 2 "$(app_url /api/health)" >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 1
    tries=$((tries + 1))
  done
  return 1
}

# Any answer at all: versions before v0.2 have no /api/health
answers() {
  local tries=0 code
  while [ $tries -lt 40 ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$(app_url /)" 2>/dev/null || true)"
    if [ -n "$code" ] && [ "$code" != "000" ]; then return 0; fi
    sleep 1
    tries=$((tries + 1))
  done
  return 1
}

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

install_node() {
  curl -fsSL "https://deb.nodesource.com/setup_${INSTALL_NODE}.x" | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs </dev/null
}

npm_install() {
  if [ -f package-lock.json ]; then
    npm ci --omit=dev --no-audit --no-fund --update-notifier=false --loglevel=error </dev/null
  else
    npm install --omit=dev --no-audit --no-fund --update-notifier=false --loglevel=error </dev/null
  fi
}

# Put the previous version and its data back. Runs every step even if one fails, and always
# ends by starting the app.
rollback() {
  set +e
  trap - ERR
  journalctl -u "$APP_NAME" -n 30 --no-pager 2>/dev/null
  if [ -z "$PREV_COMMIT" ]; then
    fail "Brisk Budget couldn't be installed. Check the messages above, then run the command again."
    exit 1
  fi
  mkdir -p "$STATE_DIR"
  [ -n "$TARGET_COMMIT" ] && echo "$TARGET_COMMIT" > "$STATE_DIR/failed-commit"
  warn "Putting the previous version back..."
  systemctl stop "$APP_NAME" 2>/dev/null
  cd "$APP_DIR" || exit 1
  git -C "$APP_DIR" reset --quiet --hard "$PREV_COMMIT" || fail "Couldn't put the previous code back"
  if [ -n "$PRE_UPDATE_BACKUP" ] && [ -f "$PRE_UPDATE_BACKUP" ]; then
    local data tmp
    data="$(real_path "$DATA_DIR")"
    tmp="$(mktemp -d "${data%/}.rollback-XXXXXX")"
    # Empty the folder and refill it, rather than replace it, so a linked or mounted folder works
    if tar -xzf "$PRE_UPDATE_BACKUP" -C "$tmp"; then
      find "$data" -mindepth 1 -delete
      cp -a "$tmp"/. "$data"/ && info "Data restored from ${PRE_UPDATE_BACKUP}"
    else
      fail "Couldn't read ${PRE_UPDATE_BACKUP}; the data folder was left as it is"
    fi
    rm -rf "$tmp"
  fi
  if [ -f "${SERVICE_FILE}.prev" ]; then
    mv -f "${SERVICE_FILE}.prev" "$SERVICE_FILE"
    systemctl daemon-reload
  fi
  npm_install || warn "Couldn't reinstall the previous version's dependencies"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  systemctl start "$APP_NAME"
  if answers; then
    warn "The previous version is running again. Your data is as it was before the update."
  else
    fail "The previous version didn't start either. Check: journalctl -u ${APP_NAME}"
  fi
  exit 1
}

# ---------------------------------------------------------------------------
# Part 1: get the code (skipped when the new script continues an update)
# ---------------------------------------------------------------------------
if [ "$CONTINUE" = false ]; then
  echo ""
  echo "============================================"
  echo -e "${GREEN}Brisk Budget installer${NC}"
  echo "============================================"

  step "Checking system packages..."
  missing=()
  for tool in git curl tar flock; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    missing=("${missing[@]/flock/util-linux}")
    info "Installing: ${missing[*]}"
    apt-get update -qq </dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" ca-certificates </dev/null
  fi

  if ! command -v node >/dev/null 2>&1 || [ "$(node_major)" -lt "$MIN_NODE" ]; then
    if command -v node >/dev/null 2>&1; then
      warn "Node.js $(node --version) is too old (Brisk Budget needs ${MIN_NODE} or newer). Installing Node.js ${INSTALL_NODE}..."
    else
      info "Installing Node.js ${INSTALL_NODE}..."
    fi
    install_node
  else
    info "Node.js $(node --version) found"
  fi
  if ! command -v npm >/dev/null 2>&1; then
    info "Installing npm..."
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq npm </dev/null
  fi

  if ! id "$APP_USER" >/dev/null 2>&1; then
    info "Creating system user ${APP_USER}"
    useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
  fi

  if [ -d "$APP_DIR/.git" ]; then
    # A branch that has since been removed from GitHub falls back to main
    if ! git -C "$APP_DIR" ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
      if [ "$BRANCH_GIVEN" = true ]; then
        fail "There's no branch called \"${BRANCH}\"."
        exit 1
      fi
      warn "The branch \"${BRANCH}\" no longer exists, so this install now follows main."
      BRANCH="main"
    fi
    info "Branch: ${BRANCH}"

    step "Checking for updates..."
    git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
    PREV_COMMIT="$(git -C "$APP_DIR" rev-parse HEAD)"
    TARGET_COMMIT="$(git -C "$APP_DIR" rev-parse "origin/${BRANCH}")"
    LAST_GOOD="$(cat "$STATE_DIR/deployed-commit" 2>/dev/null || true)"
    [ -z "$LAST_GOOD" ] && LAST_GOOD="$PREV_COMMIT"
    if [ "$UNATTENDED" = true ]; then
      if [ "$TARGET_COMMIT" = "$LAST_GOOD" ] && [ "$TARGET_COMMIT" = "$PREV_COMMIT" ]; then
        info "Already up to date ($(git -C "$APP_DIR" log -1 --format=%h))"
        exit 0
      fi
      if [ "$TARGET_COMMIT" = "$(cat "$STATE_DIR/failed-commit" 2>/dev/null || true)" ]; then
        info "Skipping $(git -C "$APP_DIR" log -1 --format=%h "$TARGET_COMMIT"): it didn't start last time. Waiting for a newer version."
        exit 0
      fi
    fi

    # The new version's script finishes the update, so it has to understand how this one hands over
    if ! git -C "$APP_DIR" show "${TARGET_COMMIT}:deploy.sh" 2>/dev/null | grep -q '^# brisk-deploy-protocol:'; then
      fail "That version is older than the one installed and can't be installed over it this way."
      exit 1
    fi

    free_mb="$(df -Pm "$APP_DIR" | awk 'NR==2 {print $4}')"
    if [ -n "$free_mb" ] && [ "$free_mb" -lt "$MIN_FREE_MB" ]; then
      fail "Only ${free_mb} MB of disk space is free; updating needs at least ${MIN_FREE_MB} MB. Nothing was changed."
      exit 1
    fi

    # From here on, anything going wrong puts the previous version back
    trap rollback ERR

    step "Stopping Brisk Budget for the update..."
    systemctl stop "$APP_NAME" 2>/dev/null || true

    # Back up the data folder exactly as it is, before any code changes
    data_real="$(real_path "$DATA_DIR")"
    if [ -d "$data_real" ] && [ -n "$(ls -A "$data_real" 2>/dev/null)" ]; then
      backups_real="$(real_path "$BACKUPS_DIR")"
      mkdir -p "$backups_real"
      PRE_UPDATE_BACKUP="${backups_real}/pre-update-$(date -u +%Y-%m-%dT%H-%M-%S).tar.gz"
      (umask 077 && tar -czf "$PRE_UPDATE_BACKUP" -C "$data_real" .)
      info "Data backed up to ${PRE_UPDATE_BACKUP}"
      find "$backups_real" -maxdepth 1 -name 'pre-update-*.tar.gz' -printf '%T@ %p\0' 2>/dev/null \
        | sort -z -rn | tail -z -n +$((KEEP_PRE_UPDATE + 1)) | cut -z -d' ' -f2- | xargs -0 -r rm -f
    fi
    [ -f "$SERVICE_FILE" ] && cp -f "$SERVICE_FILE" "${SERVICE_FILE}.prev"

    step "Updating code..."
    # The data and backups folders are never part of the code, even when they're links
    for path in /data /backups; do
      grep -qxF "$path" "$APP_DIR/.git/info/exclude" 2>/dev/null || echo "$path" >> "$APP_DIR/.git/info/exclude"
    done
    if [ -n "$(git -C "$APP_DIR" status --porcelain 2>/dev/null)" ]; then
      git -C "$APP_DIR" stash push --include-untracked --quiet -m "Put aside by the Brisk Budget updater $(date -u +%Y-%m-%dT%H:%M:%SZ)" || true
      warn "Changes made by hand to the app's files were put aside (see: git -C ${APP_DIR} stash list)"
    fi
    git -C "$APP_DIR" checkout --quiet -f -B "$BRANCH" "origin/${BRANCH}"
    git -C "$APP_DIR" reset --quiet --hard "$TARGET_COMMIT"
    info "Code updated: $(git -C "$APP_DIR" log -1 --format='%h %s')"
    trap - ERR
  else
    info "Branch: ${BRANCH}"
    if systemctl is-active --quiet "$APP_NAME" 2>/dev/null; then :; elif answers_now="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$(app_url /)" 2>/dev/null || true)" && [ -n "$answers_now" ] && [ "$answers_now" != "000" ]; then
      fail "Something else is already using port ${APP_PORT}. Choose another, for example: curl -fsSL ... | sudo PORT=8080 bash"
      exit 1
    fi
    step "Downloading Brisk Budget..."
    if [ -e "$APP_DIR" ]; then
      fail "$APP_DIR exists but isn't a Brisk Budget install. Move it out of the way and try again."
      exit 1
    fi
    git clone --quiet -b "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi

  # Finish with the script that just arrived, so update logic is always the newest version
  args=(--continue --branch "$BRANCH")
  case "$AUTO_UPDATE" in
    on) args+=(--auto-update) ;;
    off) args+=(--no-auto-update) ;;
  esac
  [ "$UNATTENDED" = true ] && args+=(--unattended)
  [ -n "$PREV_COMMIT" ] && args+=(--prev "$PREV_COMMIT")
  [ -n "$TARGET_COMMIT" ] && args+=(--target "$TARGET_COMMIT")
  [ -n "$PRE_UPDATE_BACKUP" ] && args+=(--backup "$PRE_UPDATE_BACKUP")
  PORT="$APP_PORT" exec bash "$APP_DIR/deploy.sh" "${args[@]}"
fi

# ---------------------------------------------------------------------------
# Part 2: install, configure and start (always run from the new script)
# ---------------------------------------------------------------------------
trap rollback ERR
cd "$APP_DIR"
mkdir -p "$APP_DIR/data" "$APP_DIR/backups" "$STATE_DIR"

step "Installing dependencies..."
npm_install

# The service runs as its own user, which can't use a Node.js installed under someone's home
# folder (nvm, for example)
NODE_BIN="$(command -v node)"
if ! runuser -u "$APP_USER" -- "$NODE_BIN" -v >/dev/null 2>&1 || [[ "$NODE_BIN" == /root/* || "$NODE_BIN" == /home/* ]]; then
  warn "The service can't use Node.js at ${NODE_BIN}, so Node.js ${INSTALL_NODE} is being installed for it..."
  install_node
  NODE_BIN="/usr/bin/node"
fi

# Settings added by hand to the service file in earlier versions move to the settings file,
# which updates never touch
if [ ! -f "$ENV_FILE" ]; then
  {
    echo "# Brisk Budget settings, one NAME=value per line. Restart after changing:"
    echo "#   sudo systemctl restart ${APP_NAME}"
    echo "# For example: BRISK_ALLOWED_HOSTS=budget.example.com"
    if [ -f "$SERVICE_FILE" ]; then
      # Environment="NAME=a b" becomes NAME="a b"
      grep -E '^Environment=' "$SERVICE_FILE" | sed -E 's/^Environment=//; s/^"([A-Za-z_][A-Za-z0-9_]*)=(.*)"$/\1="\2"/' \
        | grep -vE '^(NODE_ENV|PORT|HOME)=' || true
    fi
  } > "$ENV_FILE"
  chmod 640 "$ENV_FILE"
fi

DATA_REAL="$(real_path "$DATA_DIR")"
BACKUPS_REAL="$(real_path "$BACKUPS_DIR")"
mkdir -p "$DATA_REAL" "$BACKUPS_REAL"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_REAL" "$BACKUPS_REAL"
# Money data and the sign-in secret are for the app's eyes only
chmod 700 "$DATA_REAL" "$BACKUPS_REAL"
chmod -R go-rwx "$DATA_REAL" "$BACKUPS_REAL"

LOW_PORT=""
[ "$APP_PORT" -lt 1024 ] && LOW_PORT="AmbientCapabilities=CAP_NET_BIND_SERVICE"

step "Configuring the service..."
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Brisk Budget - personal finance tracker
Documentation=https://github.com/CoppingEthan/Brisk-Budget
After=network.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} server/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${APP_NAME}
Environment=NODE_ENV=production
Environment=PORT=${APP_PORT}
# Your own settings (PORT, HOST, TZ, BRISK_ALLOWED_HOSTS...) go here; updates never change it
EnvironmentFile=-${ENV_FILE}
${LOW_PORT}

# Hardening: the app can only write to its data and backups folders, and its files are private
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=${APP_DIR}/data ${APP_DIR}/backups ${DATA_REAL} ${BACKUPS_REAL}

[Install]
WantedBy=multi-user.target
EOF

# The nightly update runs its own copy of this script, so it keeps working even if an update
# has to be rolled back to an older version
install -D -m 755 "$APP_DIR/deploy.sh" "$UPDATER"
[ -z "$AUTO_UPDATE" ] && [ -f "$UPDATE_TIMER" ] && AUTO_UPDATE="on"   # refresh existing auto-update units
if [ "$AUTO_UPDATE" = "on" ]; then
  cat > "$UPDATE_SERVICE" <<EOF
[Unit]
Description=Update Brisk Budget to the newest version
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=HOME=/root
ExecStart=/bin/bash ${UPDATER} --unattended
EOF
  cat > "$UPDATE_TIMER" <<EOF
[Unit]
Description=Check for Brisk Budget updates every night

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
elif [ "$AUTO_UPDATE" = "off" ]; then
  systemctl disable --now "${APP_NAME}-update.timer" >/dev/null 2>&1 || true
  rm -f "$UPDATE_SERVICE" "$UPDATE_TIMER"
fi

systemctl daemon-reload
systemctl enable "$APP_NAME" --quiet
if [ "$AUTO_UPDATE" = "on" ]; then
  systemctl enable --now "${APP_NAME}-update.timer" --quiet
fi

step "Starting Brisk Budget..."
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo "")"
systemctl restart "$APP_NAME"

if ! health_check "$VERSION"; then
  fail "Brisk Budget didn't start properly."
  rollback
fi
trap - ERR

git -C "$APP_DIR" rev-parse HEAD > "$STATE_DIR/deployed-commit"
rm -f "$STATE_DIR/failed-commit" "${SERVICE_FILE}.prev"

echo ""
echo "============================================"
echo -e "${GREEN}Brisk Budget v${VERSION:-?} is running${NC}"
echo "============================================"
echo ""
echo "Open:            http://localhost:${APP_PORT}  (or this server's address on your network)"
echo "Settings:        ${ENV_FILE}"
echo "Logs:            journalctl -u ${APP_NAME} -f"
echo "Restart:         systemctl restart ${APP_NAME}"
if [ -f "$UPDATE_TIMER" ]; then
  echo "Auto-updates:    on, nightly (turn off with: ... | sudo bash -s -- --no-auto-update)"
else
  echo "Auto-updates:    off (turn on with: ... | sudo bash -s -- --auto-update)"
fi
echo ""
echo "To update later, run the same command again:"
echo "  curl -fsSL https://raw.githubusercontent.com/CoppingEthan/Brisk-Budget/main/deploy.sh | sudo bash"
echo ""
