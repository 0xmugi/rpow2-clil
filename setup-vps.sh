#!/usr/bin/env bash
# setup-vps.sh — one-shot installer for rpow2-cli on a Linux VPS.
#
# Run this twice:
#   1) First run (fresh VPS): installs Node + Rust, builds native miner,
#      then prints scp instructions and exits when no profiles are present.
#   2) Second run (after you scp profiles/*.json + bot.json from laptop):
#      installs systemd services (rpow-miner, rpow-bot) and helper commands.
#
# Idempotent — safe to re-run any time you add a profile or pull new code.
#
# Usage (from repo root):
#   bash setup-vps.sh
#
# Optional env overrides:
#   PROFILES=cecen,namc        explicit profile list (default: auto-detect)
#   WORKERS=2                  workers per profile (default: cores/profiles)
#   WITH_BOT=true|false        bot service (default: auto-detect bot.json)
#   SVC_PREFIX=rpow            systemd unit name prefix (default: rpow)
#   SKIP_SERVICES=true         stop after build, don't touch systemd
#   RPOW_BACKEND=native|node   force backend in service (default: native)

set -euo pipefail

log()  { printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- privilege ----------
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "not root and sudo missing"
  SUDO="sudo"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---------- detect package manager ----------
if command -v apt-get >/dev/null 2>&1; then PM="apt"
elif command -v dnf >/dev/null 2>&1; then PM="dnf"
elif command -v yum >/dev/null 2>&1; then PM="yum"
elif command -v pacman >/dev/null 2>&1; then PM="pacman"
else die "unsupported distro: install Node 18+, Rust, gcc/make manually"
fi
log "package manager: $PM"

# ---------- Node.js 22 ----------
need_node=1
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$major" -ge 18 ]; then
    log "node $(node -v) already installed"
    need_node=0
  else
    warn "node $(node -v) is too old, upgrading"
  fi
fi

if [ "$need_node" -eq 1 ]; then
  log "installing Node.js 22 via NodeSource"
  case "$PM" in
    apt)
      $SUDO apt-get update -y -qq
      $SUDO apt-get install -y -qq curl ca-certificates gnupg
      curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
      $SUDO apt-get install -y -qq nodejs ;;
    dnf|yum)
      curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO -E bash -
      $SUDO $PM install -y nodejs ;;
    pacman)
      $SUDO pacman -Sy --noconfirm nodejs npm ;;
  esac
fi

# ---------- build essentials ----------
log "ensuring build tools"
case "$PM" in
  apt)     $SUDO apt-get install -y -qq build-essential git curl pkg-config ;;
  dnf|yum) $SUDO $PM install -y gcc gcc-c++ make git curl pkgconfig ;;
  pacman)  $SUDO pacman -S --noconfirm --needed base-devel git curl ;;
esac

# ---------- Rust ----------
if ! command -v cargo >/dev/null 2>&1; then
  log "installing Rust toolchain"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable
fi
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.cargo/bin:$PATH"

# ---------- build native miner ----------
[ -d miner-rs ] || die "miner-rs/ not found; run from repo root"
log "building native miner (release, ~30s first time)"
( cd miner-rs && cargo build --release --quiet )
NATIVE_BIN="$SCRIPT_DIR/miner-rs/target/release/rpow-miner"
[ -x "$NATIVE_BIN" ] || die "build finished but binary missing at $NATIVE_BIN"
log "native miner: $NATIVE_BIN"

# ---------- create dirs ----------
mkdir -p profiles logs
chmod 700 profiles 2>/dev/null || true

# ---------- skip-services flag ----------
if [ "${SKIP_SERVICES:-false}" = "true" ]; then
  log "SKIP_SERVICES=true — stopping after build."
  exit 0
fi

# ---------- detect profiles ----------
if [ -z "${PROFILES:-}" ]; then
  if compgen -G "profiles/*.json" > /dev/null; then
    PROFILES=$(ls profiles/*.json 2>/dev/null \
      | xargs -n1 basename | sed 's/\.json$//' \
      | tr '\n' ',' | sed 's/,$//')
  fi
fi

if [ -z "${PROFILES:-}" ]; then
  cat <<EOF

================================================================
  ✅ Build done.  No profiles detected yet — service install skipped.

  Next, copy your profiles + bot config from your LAPTOP:

      scp profiles/*.json $USER@<this-vps-ip>:$SCRIPT_DIR/profiles/
      scp bot.json        $USER@<this-vps-ip>:$SCRIPT_DIR/

  Then re-run this same script to install systemd services:

      bash $SCRIPT_DIR/setup-vps.sh

================================================================
EOF
  exit 0
fi

# ---------- systemd available? ----------
if ! command -v systemctl >/dev/null 2>&1; then
  warn "systemctl not found; service setup skipped."
  cat <<EOF

  You can still mine manually with:
      node rpow.js mine-all --profiles=$PROFILES --backend=native
EOF
  exit 0
fi

# ---------- compute service config ----------
NUM_PROFILES=$(echo "$PROFILES" | tr ',' '\n' | grep -cv '^$')
[ "$NUM_PROFILES" -lt 1 ] && NUM_PROFILES=1

CORES=$(nproc)
if [ -z "${WORKERS:-}" ]; then
  WORKERS=$(( CORES / NUM_PROFILES ))
  [ "$WORKERS" -lt 1 ] && WORKERS=1
fi

WITH_BOT_DEFAULT="false"
[ -f "$SCRIPT_DIR/bot.json" ] && WITH_BOT_DEFAULT="true"
WITH_BOT="${WITH_BOT:-$WITH_BOT_DEFAULT}"

SVC_PREFIX="${SVC_PREFIX:-rpow}"
MINER_SVC="$SVC_PREFIX-miner"
BOT_SVC="$SVC_PREFIX-bot"

BACKEND="${RPOW_BACKEND:-native}"
NODE_BIN="$(command -v node)"

log "cores=$CORES profiles=[$PROFILES] workers/profile=$WORKERS backend=$BACKEND bot=$WITH_BOT"

# ---------- miner service ----------
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

# ---------- bot service ----------
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

ALL_SVCS="$MINER_SVC"
[ "$WITH_BOT" = "true" ] && ALL_SVCS="$ALL_SVCS $BOT_SVC"

# ---------- helper commands ----------
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

# ---------- swap on tiny VPS ----------
SWAP_MB=$(free -m | awk '/^Swap:/ {print $2}')
RAM_MB=$(free -m | awk '/^Mem:/ {print $2}')
if [ "$SWAP_MB" -lt 1024 ] && [ "$RAM_MB" -lt 2048 ]; then
  log "creating 2GB swap (low-RAM detected: ${RAM_MB} MB)"
  $SUDO fallocate -l 2G /swapfile 2>/dev/null \
    || $SUDO dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  $SUDO chmod 600 /swapfile
  $SUDO mkswap /swapfile >/dev/null
  $SUDO swapon /swapfile
  grep -q '/swapfile' /etc/fstab \
    || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
fi

# ---------- summary ----------
cat <<EOF

================================================================
  ✅ rpow2 ready.

  Services installed (enabled at boot):
    $MINER_SVC          mining $NUM_PROFILES profile(s) [$PROFILES]
                        workers/profile=$WORKERS  backend=$BACKEND
EOF
[ "$WITH_BOT" = "true" ] && echo "    $BOT_SVC            Telegram bot (reads ./bot.json)"
cat <<EOF

  Quick commands:
    rpow-start          start mining (and bot)
    rpow-stop           stop everything
    rpow-restart        restart everything
    rpow-status         status snapshot
    rpow-logs miner     follow miner.log
    rpow-logs bot       follow bot.log
    rpow-logs journal   follow systemd journal
    rpow-update         git pull + rebuild + restart

  Start now:
    rpow-start

================================================================
EOF
