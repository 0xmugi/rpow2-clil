#!/usr/bin/env bash
# setup-vps.sh — one-shot installer for rpow2-cli on a fresh Linux VPS.
# Installs: Node.js 22, Rust toolchain, build tools.
# Builds:   the native miner binary (miner-rs/target/release/rpow-miner).
#
# Idempotent — safe to re-run.
#
# Usage:
#   bash setup-vps.sh
set -euo pipefail

log()  { printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# ----- detect package manager -----------------------------------------------
if command -v apt-get >/dev/null 2>&1; then
  PM="apt"
elif command -v dnf >/dev/null 2>&1; then
  PM="dnf"
elif command -v yum >/dev/null 2>&1; then
  PM="yum"
elif command -v pacman >/dev/null 2>&1; then
  PM="pacman"
else
  die "unsupported distro: install Node >=20, Rust, gcc/make manually"
fi
log "package manager: $PM"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    die "not root and sudo is not installed"
  fi
fi

# ----- install Node.js 22 ---------------------------------------------------
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
      $SUDO apt-get update -y
      $SUDO apt-get install -y curl ca-certificates gnupg
      curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
      $SUDO apt-get install -y nodejs
      ;;
    dnf|yum)
      curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO -E bash -
      $SUDO $PM install -y nodejs
      ;;
    pacman)
      $SUDO pacman -Sy --noconfirm nodejs npm
      ;;
  esac
fi
log "node: $(node -v)"

# ----- install build tools (gcc/make/git) -----------------------------------
log "installing build essentials"
case "$PM" in
  apt)    $SUDO apt-get install -y build-essential git curl pkg-config ;;
  dnf|yum) $SUDO $PM install -y gcc gcc-c++ make git curl pkgconfig ;;
  pacman) $SUDO pacman -S --noconfirm --needed base-devel git curl ;;
esac

# ----- install Rust ---------------------------------------------------------
if ! command -v cargo >/dev/null 2>&1; then
  log "installing Rust via rustup"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable
  # shellcheck disable=SC1090
  . "$HOME/.cargo/env"
else
  log "rust $(cargo --version | awk '{print $2}') already installed"
  # ensure PATH for this shell
  if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi
fi
log "cargo: $(cargo --version)"

# ----- build the native miner -----------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d "miner-rs" ]; then
  die "miner-rs/ not found. Run this script from the rpow2-cli repo root."
fi

log "building native miner (~30s on first run)"
( cd miner-rs && cargo build --release )

BIN="$SCRIPT_DIR/miner-rs/target/release/rpow-miner"
if [ ! -x "$BIN" ]; then
  die "build finished but binary not found at $BIN"
fi
log "native miner ready: $BIN"

# ----- print next steps -----------------------------------------------------
cat <<EOF

================================================================
  rpow2-cli is ready.

  Next steps:

  1. Login (one of these):

     a) From this VPS (need email access on your phone/laptop):
        node rpow.js login your@email.com
        # then paste the magic link from the email

     b) Or upload session.json from a machine where you already
        logged in (much easier if you run multiple VPS):
        scp session.json $USER@<this-vps-ip>:$SCRIPT_DIR/

  2. Quick mining test:
        node rpow.js mine --max=2

  3. Run continuously in the background:
        nohup node rpow.js mine > miner.log 2>&1 &
        tail -f miner.log

  4. Or as a systemd service (recommended for 24/7 mining):
        bash $SCRIPT_DIR/install-service.sh
================================================================
EOF
