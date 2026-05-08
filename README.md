# rpow2-cli

Headless command-line miner for [rpow2.com](https://rpow2.com), a tribute
implementation of Hal Finney's RPOW.

It does exactly what the web app does, but from a terminal:

1. Request a magic-link login by email.
2. Verify the link to obtain a session cookie.
3. Loop forever:
   - `POST /challenge` to get `{ challenge_id, nonce_prefix, difficulty_bits }`.
   - SHA-256 mine `prefix || nonce_le_8` until the digest has
     `>= difficulty_bits` **trailing** zero bits, using N CPU threads.
   - `POST /mint { challenge_id, solution_nonce }` to claim 1 RPOW.

Two miner backends ship in the box and the CLI auto-picks the best:

| Backend | Hashrate (8 threads) | Build | Speed vs Node |
|---|---|---|---|
| **`native`** (Rust, `miner-rs/`) | ~70 MH/s peak | needs Rust toolchain (one-off) | ~22x |
| **`node`** (built-in fallback) | ~3 MH/s | none | 1x |

Node.js >= 18 is required (Node 22 recommended). The Rust backend uses the
pure-Rust `sha2` crate with runtime SHA-NI / AVX2 detection, so the binary is
portable across any x86_64 machine.

## Quick start

```bash
# 1. login (interactive)
node rpow.js login gilangcahyadi00@gmail.com
# … check your inbox, paste the magic link when asked …

# 2. start mining (Ctrl+C to stop)
node rpow.js mine

# or in one shot (logs in if needed, then mines):
node rpow.js
```

Other commands:

```bash
node rpow.js status                  # account + public ledger
node rpow.js activity                # recent transfers
node rpow.js mine --workers=8        # tune parallelism (default = CPU - 1)
node rpow.js mine --max=10           # stop after 10 tokens
node rpow.js mine --backend=native   # force backend (default: auto)
node rpow.js logout                  # clear local session
node rpow.js help
```

The session cookie is stored in `./session.json` (chmod 600). To use a
different file, set `RPOW_SESSION_FILE=/path/to/session.json`.

## Multiple accounts (profiles)

Each profile is a separate session file under `./profiles/NAME.json`.

```bash
# 1. login each account into its own profile
node rpow.js login alice@example.com --profile=alice
node rpow.js login bob@example.com   --profile=bob
node rpow.js login carol@example.com --profile=carol

# 2. inspect
node rpow.js profiles                       # list profile files
node rpow.js status --profile=alice         # one profile
node rpow.js status-all                     # every profile + grand total

# 3. mine all profiles in parallel from one terminal
node rpow.js mine-all                        # auto-discovers ./profiles/*.json
node rpow.js mine-all --profiles=alice,bob   # subset
node rpow.js mine-all --workers=4            # workers per child (default = CPU/N)

# 4. mine just one profile
node rpow.js mine --profile=alice
```

`mine-all` spawns one `node rpow.js mine --profile=NAME` child per account
and prefixes each output line with the profile name. Children auto-restart
on failure. `Ctrl+C` stops all of them.

CPU split: by default workers per child = `(CPU-1) / N`. Adjust with
`--workers` if you want to over- or under-provision.

## Telegram bot (status from your phone)

`node rpow.js bot` runs a long-polling bot that lets you check balances
across all profiles from Telegram.

Setup:

1. Create a bot with [@BotFather](https://t.me/BotFather) → get the token.
2. Put the token in `./bot.json` (gitignored):

   ```json
   {
     "telegram_token": "1234567890:AA...",
     "allowed_chat_ids": []
   }
   ```

   Or set `TELEGRAM_BOT_TOKEN` in the environment.
3. Run `node rpow.js bot`. The first time, send `/whoami` from your
   Telegram chat to get your numeric chat ID, then add it to
   `allowed_chat_ids` so nobody else can query your balances.
4. Available commands:
   - `/status` (or `/me`, `/balance`) — balances for every profile + total
   - `/profiles` — list of configured profiles
   - `/ledger` — public ledger snapshot (difficulty, supply)
   - `/whoami` — show your chat id (for setup)
   - `/help`

## Building the native miner

```bash
# install Rust (Linux/macOS)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
source $HOME/.cargo/env

# build (one-time, ~30s)
cd miner-rs
cargo build --release
cd ..

# verify
node rpow.js mine --max=1   # should log "backend=native (.../rpow-miner)"
```

For Windows use `https://win.rustup.rs/x86_64`. To force the Node backend
(no Rust needed), pass `--backend=node` or set `RPOW_BACKEND=node`.

## Running on a VPS — copy/paste guide

Tested on Ubuntu 22.04 / 24.04, Debian 12, AlmaLinux 9. Should work on any
modern systemd distro.

### Step 1 — Install everything (one paste)

SSH into your VPS, then paste this **whole block**:

```bash
sudo apt-get update -y && sudo apt-get install -y git curl
git clone https://github.com/0xmugi/rpow2-clil.git ~/rpow
cd ~/rpow
bash setup-vps.sh
source ~/.cargo/env   # so `cargo` is in PATH for this shell
```

What `setup-vps.sh` does for you:
- installs **Node.js 22** (skips if already installed)
- installs **Rust** toolchain (rustup → `~/.cargo`)
- installs build tools (gcc/make)
- builds the **native miner** (`miner-rs/target/release/rpow-miner`)

Re-running the script is safe — it skips what's already installed.

For non-Debian distros (RHEL/AlmaLinux/Rocky, Arch) the script auto-detects
your package manager. If your VPS is something exotic, just install Node 18+
and Rust manually then run `cd miner-rs && cargo build --release`.

### Step 2 — Get a session

You need a `session.json` in `~/rpow/`. Pick **one** of these:

**Option A — login on the VPS** (you need email access on phone/laptop):

```bash
cd ~/rpow
node rpow.js login your@email.com
# Open the email on your phone, copy the magic link, paste it into the SSH
# terminal when asked. Done.
```

**Option B — copy the session from your local machine** (much easier when you
have several VPS):

On your **laptop** (where you already ran `node rpow.js login` and have a
working `session.json`):

```bash
# replace USER and VPS_IP
scp session.json USER@VPS_IP:~/rpow/session.json
```

Then on the VPS:

```bash
cd ~/rpow
node rpow.js status   # should show your email + balance
```

### Step 3 — Quick mining test

```bash
cd ~/rpow
node rpow.js mine --max=2
```

You should see `backend=native` in the first log line, then 2 tokens minted
in a few seconds. If you see `backend=node`, the Rust binary wasn't built —
re-run `bash setup-vps.sh`.

### Step 4 — Multi-account mining + Telegram bot (recommended)

If you already have several profiles set up on your laptop (e.g.
`profiles/cecen.json`, `profiles/namc.json`) and a `bot.json` with your
Telegram token, migrating to a new VPS is two scp commands plus one script.

**On your LAPTOP (PowerShell or bash)** — copy what you already have:

```bash
# replace VPS_IP and the user (root for most HostBrr/Hetzner-style VPS)
scp profiles/*.json root@VPS_IP:~/rpow/profiles/
scp bot.json        root@VPS_IP:~/rpow/
```

**On the VPS** — install both services with one script:

```bash
cd ~/rpow
bash install-multi.sh
rpow-start
```

`install-multi.sh` will:

- Auto-detect every `profiles/*.json` you copied and mine all of them
  in parallel (`mine-all --profiles=...`).
- Install a `rpow-miner.service` systemd unit (mining loop).
- Install a `rpow-bot.service` if `bot.json` is present (Telegram bot).
- Auto-tune `--workers=N` so each profile gets `cores / num_profiles`.
- Add convenience helpers to `/usr/local/bin`:
  `rpow-start`, `rpow-stop`, `rpow-restart`, `rpow-status`,
  `rpow-logs [miner|bot|journal]`, `rpow-update`.
- Create a 2GB swap file on low-RAM (<2GB) plans.

It is idempotent — re-run it any time you add/remove a profile, or pass
overrides:

```bash
PROFILES=cecen,namc WORKERS=2 WITH_BOT=false bash install-multi.sh
```

> **Migration tip:** before running `rpow-start` on the new VPS, make sure
> your old VPS / laptop is **not** mining the same profiles, otherwise both
> will keep invalidating each other's challenges and the API may rate-limit
> you. Stop the old service first:
> `sudo systemctl stop rpow` (old VPS) or kill the local `node rpow.js mine`.

### Step 4-alt — Single-account systemd service (legacy)

If you only mine one account on the VPS, the simpler flow is:

```bash
cd ~/rpow
bash install-service.sh
```

That installs and starts a service called `rpow`. To check on it:

```bash
sudo systemctl status rpow      # is it running?
journalctl -u rpow -f           # live logs
tail -f ~/rpow/miner.log        # mining log
sudo systemctl restart rpow     # restart it
sudo systemctl stop rpow        # stop it
sudo systemctl disable --now rpow   # stop + don't start at boot
```

To uninstall the service entirely:

```bash
sudo systemctl disable --now rpow
sudo rm /etc/systemd/system/rpow.service
sudo systemctl daemon-reload
```

### Step 5 — Updating the miner later

Multi-account setup (Step 4):

```bash
rpow-update     # git pull + rebuild + restart all services
```

Single-account legacy setup:

```bash
cd ~/rpow
git pull
( cd miner-rs && cargo build --release )
sudo systemctl restart rpow
```

### Alternatives to systemd (any distro)

```bash
# nohup — survives SSH disconnect
nohup node rpow.js mine > miner.log 2>&1 &
tail -f miner.log
disown  # so it keeps running even after your shell logs out
```

```bash
# screen — re-attachable session
screen -S rpow
node rpow.js mine
# detach: Ctrl+A then D
# reattach: screen -r rpow
```

```bash
# pm2 — Node-aware process manager
npm i -g pm2
pm2 start rpow.js --name rpow -- mine
pm2 save
pm2 startup     # follow the printed sudo command for boot persistence
```

### Common VPS pitfalls

- **"I closed SSH and the miner stopped"** — use systemd (Step 4),
  `nohup ... &` + `disown`, or `screen`. A plain `node rpow.js mine` dies
  with the SSH session.
- **`backend=node` even after building** — make sure `cargo build --release`
  ran in `miner-rs/`. Verify the binary exists:
  ```bash
  ls -lh ~/rpow/miner-rs/target/release/rpow-miner
  ```
- **`session expired` errors** — magic-link sessions don't last forever.
  Re-run `node rpow.js login your@email.com` (or scp a fresh
  `session.json` from your laptop).
- **Low hashrate on a tiny VPS** — 1 vCPU = 1 core, expect ~10–15 MH/s with
  the native backend. Bigger CPUs scale linearly until thermal/power limits.

## Performance

Measured on a 6P+8E core laptop CPU at d=25 (~33 M hashes / token avg):

| Backend | Workers | Hashrate (peak) | Time / token |
|---------|---------|-----------------|--------------|
| `node`  | 8       | ~3.2 MH/s       | ~10–20 s     |
| `native` | 4      | ~50 MH/s        | ~0.7 s       |
| `native` | 6      | **~70 MH/s**    | **~0.5 s**   |
| `native` | 8      | ~70 MH/s        | ~0.5 s       |

Sustained throughput on laptops is ~30–50% lower due to thermal throttling.
Difficulty bumps by 1 bit every 1 M coins minted (epoch boundary), which
doubles the expected hashes per token.

If you want to go faster, run multiple VPS instances – each session is
independent.

## Layout

```
rpow.js                # CLI entrypoint (login / mine / status / activity / logout)
miner-worker.js        # Node SHA-256 PoW worker (fallback backend)
lib/
  api.js               # API client + cookie jar + magic-link follower
  session.js           # session.json read/write
  miner.js             # backend dispatcher (native | node)
  miner-native.js      # spawn the Rust binary, parse JSON stream
  ui.js                # terminal formatting helpers
miner-rs/
  Cargo.toml
  src/main.rs          # native miner: parallel SHA-256 search
bench.js               # local correctness + perf benchmark (no network)
```

## Disclaimer

rpow2 is a hobby project; tokens have no monetary value. Be a good
citizen – do not abuse the mint endpoint or run unreasonable parallelism
against the same account.
