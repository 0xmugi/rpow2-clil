#!/usr/bin/env bash
# install-service.sh — install rpow2-cli as a systemd service.
# Run after setup-vps.sh and after you have logged in (session.json exists).
set -euo pipefail

log()  { printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

if ! command -v systemctl >/dev/null 2>&1; then
  die "systemctl not found; this OS doesn't use systemd. Use 'nohup node rpow.js mine &' instead."
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "node not found in PATH; run setup-vps.sh first"

if [ ! -f "$SCRIPT_DIR/session.json" ]; then
  warn "session.json not found in $SCRIPT_DIR"
  warn "the service will start but won't mine until you 'node rpow.js login' first."
fi

SVC_NAME="${RPOW_SVC_NAME:-rpow}"
SVC_PATH="/etc/systemd/system/$SVC_NAME.service"
WORKERS="${RPOW_WORKERS:-0}"  # 0 = auto

WORKER_ARG=""
if [ "$WORKERS" != "0" ]; then
  WORKER_ARG=" --workers=$WORKERS"
fi

log "installing $SVC_PATH"
$SUDO tee "$SVC_PATH" > /dev/null <<EOF
[Unit]
Description=rpow2 CLI miner ($SVC_NAME)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$NODE_BIN $SCRIPT_DIR/rpow.js mine$WORKER_ARG
Restart=on-failure
RestartSec=15
# Lower CPU priority a bit so the box stays responsive (optional).
Nice=10
StandardOutput=append:$SCRIPT_DIR/miner.log
StandardError=append:$SCRIPT_DIR/miner.log

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SVC_NAME"
$SUDO systemctl restart "$SVC_NAME"

sleep 2
$SUDO systemctl --no-pager status "$SVC_NAME" || true

cat <<EOF

[+] service '$SVC_NAME' is now running.

  Useful commands:
    sudo systemctl status $SVC_NAME        # service status
    sudo systemctl restart $SVC_NAME       # restart
    sudo systemctl stop $SVC_NAME          # stop
    sudo systemctl disable --now $SVC_NAME # stop and don't start at boot
    journalctl -u $SVC_NAME -f             # follow live logs
    tail -f $SCRIPT_DIR/miner.log          # follow mining log

  To uninstall later:
    sudo systemctl disable --now $SVC_NAME
    sudo rm $SVC_PATH
    sudo systemctl daemon-reload
EOF
