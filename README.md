# rpow2-cli

Headless command-line miner for [rpow2.com](https://rpow2.com), a tribute
implementation of Hal Finney's RPOW.

It does exactly what the web app does, but from a terminal:

1. Request a magic-link login by email.
2. Verify the link to obtain a session cookie.
3. Loop forever:
   - `POST /challenge` to get `{ challenge_id, nonce_prefix, difficulty_bits }`.
   - SHA-256 mine `prefix || nonce_le_8` until the digest has
     `>= difficulty_bits` **trailing** zero bits, using N CPU worker threads.
   - `POST /mint { challenge_id, solution_nonce }` to claim 1 RPOW.

No external dependencies – just Node.js >= 18 (Node >= 21 recommended for the
faster `crypto.hash()` API).

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
node rpow.js status            # account + public ledger
node rpow.js activity          # recent transfers
node rpow.js mine --workers=8  # tune parallelism (default = CPU - 1)
node rpow.js mine --max=10     # stop after 10 tokens
node rpow.js logout            # clear local session
node rpow.js help
```

The session cookie is stored in `./session.json` (chmod 600). To use a
different file, set `RPOW_SESSION_FILE=/path/to/session.json`.

## Running on a VPS

Any Linux VPS with Node 18+ works.

```bash
# 1. install Node (Debian/Ubuntu example)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. clone / upload this folder
git clone <repo> rpow && cd rpow

# 3. one-time login (you need email access for the magic link)
node rpow.js login your@email.com
# paste the link from your inbox

# 4. start mining in the background
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

Single-threaded, modern x86 CPU with Node 24:

| Component | Hashrate |
|-----------|----------|
| `crypto.hash('sha256', buf)` | ~1.2 MH/s per worker |
| 4 workers   | ~2 MH/s   |
| 8 workers   | ~3.2 MH/s |

At the current network difficulty of 25 trailing zero bits, expected
≈33 M hashes per token, which is roughly 10 s per coin on an 8-thread CPU.
Difficulty doubles every 1 M coins minted (epoch).

If you want to go faster, run multiple VPS instances – each session is
independent.

## Layout

```
rpow.js              # CLI entrypoint
miner-worker.js      # SHA-256 PoW worker (worker_threads)
lib/
  api.js             # API client + cookie jar + magic-link follower
  session.js         # session.json read/write
  miner.js           # parent-side mining coordinator
  ui.js              # terminal formatting helpers
bench.js             # local correctness + perf benchmark (no network)
```

## Disclaimer

rpow2 is a hobby project; tokens have no monetary value. Be a good
citizen – do not abuse the mint endpoint or run unreasonable parallelism
against the same account.
