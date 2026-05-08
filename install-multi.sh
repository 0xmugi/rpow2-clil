#!/usr/bin/env bash
# install-multi.sh — install rpow2-cli as systemd services for
#   - multi-account mining (mine-all)
#   - Telegram bot (optional, if bot.json exists)
#
# Run AFTER:
#   1. bash setup-vps.sh       (Node + Rust + build native miner)
#   2. scp profiles/*.json     (from your laptop)
#   3. scp bot.json            (from your laptop, if running bot here)
#
# Then:
#   bash install-multi.sh
#
# Env overrides:
#   PROFILES=cecen,namc        explicit profile list (default: auto-detect from profiles/*.json)
#   WORKERS=2                  workers per profile (default: auto = max(1, cores/profiles))
#   WITH_BOT=true|false        install bot service (default: true if bot.json exists)
#   SVC_PREFIX=rpow            systemd unit name prefix (default: rpow)
#
# Idempotent — safe to re-run after copying new profiles or pulling new code.

set -euo pipefail

log()  { printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

command -v systemctl >/dev/null 2>&1 || die "systemctl not found; this OS doesn't use systemd"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "not root and sudo missing"
  SUDO="sudo"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "node not found in PATH; run setup-vps.sh first"

# ---------- detect profiles ----------
if [ -z "${PROFILES:-}" ]; then
  if compgen -G "profiles/*.json" > /dev/null; then
    PROFILES=$(ls profiles/*.json 2>/dev/null \
      | xargs -n1 basename \
      | sed 's/\.json$//' \
      | tr '\n' ',' | sed 's/,$//')
  fi
fi

if [ -z "${PROFILES:-}" ]; then
  warn "no profiles found in $SCRIPT_DIR/profiles/"
  warn "copy them from your laptop first, then re-run this script:"
  echo
  echo "  scp profiles/*.json $USER@<this-vps-ip>:$SCRIPT_DIR/profiles/"
  echo
  die "aborting until profiles are present"
fi

NUM_PROFILES=$(echo "$PROFILES" | tr ',' '\n' | grep -cv '^$')
[ "$NUM_PROFILES" -lt 1 ] && NUM_PROFILES=1

# ---------- auto-tune workers ----------
CORES=$(nproc)
if [ -z "${WORKERS:-}" ]; then
  WORKERS=$(( CORES / NUM_PROFILES ))
  [ "$WORKERS" -lt 1 ] && WORKERS=1
fi

# ---------- detect backend ----------
NATIVE_BIN="$SCRIPT_DIR/miner-rs/target/release/rpow-miner"
if [ -x "$NATIVE_BIN" ]; then
  BACKEND="native"
else
  BACKEND="node"
  warn "native miner binary not found at $NATIVE_BIN"
  warn "  run setup-vps.sh first to build it; falling back to slower node backend"
fi

# ---------- detect bot ----------
WITH_BOT_DEFAULT="false"
[ -f "$SCRIPT_DIR/bot.json" ] && WITH_BOT_DEFAULT="true"
WITH_BOT="${WITH_BOT:-$WITH_BOT_DEFAULT}"

SVC_PREFIX="${SVC_PREFIX:-rpow}"
MINER_SVC="$SVC_PREFIX-miner"
BOT_SVC="$SVC_PREFIX-bot"

log "cores=$CORES profiles=[$PROFILES] workers/profile=$WORKERS backend=$BACKEND bot=$WITH_BOT"

# ---------- write miner service ----------
log "writing /etc/systemd/system/$MINER_SVC.service"
$SUDO tee "/etc/systemd/system/$MINER_SVC.service" > /dev/null <<EOF
[Unit]
Description=rpow2 multi-account miner [$PROFILES]
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$NODE_BIN $SCRIPT_DIR/rpow.js mine-all --profiles=$PROFILES --workers=$WORKERS --backend=$BACKEND
Restart=always
RestartSec=15
Nice=10
LimitNOFILE=65536
StandardOutput=append:$SCRIPT_DIR/miner.log
StandardError=append:$SCRIPT_DIR/miner.log

[Install]
WantedBy=multi-user.target
EOF

# ---------- write bot service ----------
if [ "$WITH_BOT" = "true" ]; then
  log "writing /etc/systemd/system/$BOT_SVC.service"
  $SUDO tee "/etc/systemd/system/$BOT_SVC.service" > /dev/null <<EOF
[Unit]
Description=rpow2 Telegram bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$NODE_BIN $SCRIPT_DIR/rpow.js bot
Restart=always
RestartSec=15
StandardOutput=append:$SCRIPT_DIR/bot.log
StandardError=append:$SCRIPT_DIR/bot.log

[Install]
WantedBy=multi-user.target
EOF
fi

$SUDO systemctl daemon-reload

# ---------- helper commands ----------
if [ "$WITH_BOT" = "true" ]; then
  ALL_SVCS="$MINER_SVC $BOT_SVC"
else
  ALL_SVCS="$MINER_SVC"
fi

log "installing helper commands to /usr/local/bin"

$SUDO tee /usr/local/bin/rpow-start > /dev/null <<EOF
#!/usr/bin/env bash
sudo systemctl start $ALL_SVCS
sleep 1
sudo systemctl --no-pager status $ALL_SVCS | head -40
EOF

$SUDO tee /usr/local/bin/rpow-stop > /dev/null <<EOF
#!/usr/bin/env bash
sudo systemctl stop $ALL_SVCS
EOF

$SUDO tee /usr/local/bin/rpow-restart > /dev/null <<EOF
#!/usr/bin/env bash
sudo systemctl restart $ALL_SVCS
sleep 1
sudo systemctl --no-pager status $ALL_SVCS | head -40
EOF

$SUDO tee /usr/local/bin/rpow-status > /dev/null <<EOF
#!/usr/bin/env bash
sudo systemctl --no-pager status $ALL_SVCS | head -60
EOF

$SUDO tee /usr/local/bin/rpow-logs > /dev/null <<'HELPER_EOF'
#!/usr/bin/env bash
case "${1:-miner}" in
  miner)   tail -f __SCRIPT_DIR__/miner.log ;;
  bot)     tail -f __SCRIPT_DIR__/bot.log ;;
  journal) sudo journalctl -u __MINER_SVC__ -f ;;
  *)       echo "usage: rpow-logs [miner|bot|journal]" ;;
esac
HELPER_EOF
$SUDO sed -i "s|__SCRIPT_DIR__|$SCRIPT_DIR|g; s|__MINER_SVC__|$MINER_SVC|g" /usr/local/bin/rpow-logs

$SUDO tee /usr/local/bin/rpow-update > /dev/null <<EOF
#!/usr/bin/env bash
set -e
cd $SCRIPT_DIR
sudo systemctl stop $ALL_SVCS
git pull --ff-only
( cd miner-rs && cargo build --release ) || true
sudo systemctl start $ALL_SVCS
sleep 1
sudo systemctl --no-pager status $ALL_SVCS | head -40
EOF

$SUDO chmod +x /usr/local/bin/rpow-start \
                /usr/local/bin/rpow-stop \
                /usr/local/bin/rpow-restart \
                /usr/local/bin/rpow-status \
                /usr/local/bin/rpow-logs \
                /usr/local/bin/rpow-update

# ---------- enable on boot ----------
$SUDO systemctl enable "$MINER_SVC" >/dev/null 2>&1 || true
[ "$WITH_BOT" = "true" ] && $SUDO systemctl enable "$BOT_SVC" >/dev/null 2>&1 || true

# ---------- swap (recommended on 1GB RAM plans) ----------
SWAP_MB=$(free -m | awk '/^Swap:/ {print $2}')
RAM_MB=$(free -m | awk '/^Mem:/ {print $2}')
if [ "$SWAP_MB" -lt 1024 ] && [ "$RAM_MB" -lt 2048 ]; then
  log "creating 2GB swap (low-RAM VPS detected)"
  $SUDO fallocate -l 2G /swapfile 2>/dev/null \
    || $SUDO dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  $SUDO chmod 600 /swapfile
  $SUDO mkswap /swapfile >/dev/null
  $SUDO swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
fi

# ---------- summary ----------
cat <<EOF

================================================================
  ✅ rpow2 services installed and enabled at boot.

  Services:
    $MINER_SVC          mining $NUM_PROFILES profile(s) [$PROFILES]
                        workers/profile=$WORKERS backend=$BACKEND
EOF
[ "$WITH_BOT" = "true" ] && echo "    $BOT_SVC            Telegram bot (reads ./bot.json)"
cat <<EOF

  Quick commands (no sudo needed inside helpers):
    rpow-start          start mining (and bot)
    rpow-stop           stop everything
    rpow-restart        restart everything
    rpow-status         service status snapshot
    rpow-logs miner     follow miner.log
    rpow-logs bot       follow bot.log
    rpow-logs journal   follow systemd journal
    rpow-update         git pull + rebuild + restart

  Start now:
    rpow-start

================================================================
EOF
