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

## Running on a VPS

Any Linux VPS with Node 18+ works.

```bash
# 1. install Node + Rust (Debian/Ubuntu example)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
source $HOME/.cargo/env

# 2. clone / upload this folder
git clone https://github.com/0xmugi/rpow2-clil.git rpow && cd rpow

# 3. build the native miner (~30s)
( cd miner-rs && cargo build --release )

# 4. one-time login (you need email access for the magic link)
node rpow.js login your@email.com
# paste the link from your inbox

# 5. start mining in the background
nohup node rpow.js mine > miner.log 2>&1 &
tail -f miner.log
```

### As a `systemd` service

`/etc/systemd/system/rpow.service`:

```ini
[Unit]
Description=rpow2 CLI miner
After=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/rpow
ExecStart=/usr/bin/node /home/ubuntu/rpow/rpow.js mine
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rpow
journalctl -u rpow -f
```

### With `pm2`

```bash
npm i -g pm2
pm2 start rpow.js --name rpow -- mine --workers=4
pm2 save
pm2 startup
```

### With `screen` / `tmux`

```bash
screen -S rpow
node rpow.js mine
# Ctrl+A then D to detach; `screen -r rpow` to reattach.
```

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
