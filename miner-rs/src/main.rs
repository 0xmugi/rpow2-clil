// rpow-miner: native SHA-256 trailing-zero-bits PoW miner.
//
// CLI:
//   rpow-miner --prefix <hex> --difficulty <bits>
//              [--workers <N>] [--start-nonce <u64>]
//
// Stdout protocol (one JSON object per line):
//   {"type":"progress","hashes":<u64>,"elapsed_ms":<u64>}
//   {"type":"found","nonce":"<u64>","digest":"<hex>",
//    "trailing_zero_bits":<u32>,"hashes":<u64>,"elapsed_ms":<u64>}
//   {"type":"error","message":"..."}
//
// Exit codes: 0 = solution found, 1 = error, 130 = aborted (SIGINT).

use sha2::{Digest, Sha256};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[inline(always)]
fn trailing_zero_bits(d: &[u8; 32]) -> u32 {
    let mut count: u32 = 0;
    for i in (0..32).rev() {
        let b = d[i];
        if b == 0 {
            count += 8;
            continue;
        }
        return count + b.trailing_zeros();
    }
    count
}

struct Args {
    prefix_hex: String,
    difficulty: u32,
    workers: usize,
    start_nonce: u64,
}

fn parse_args() -> Result<Args, String> {
    let mut prefix_hex: Option<String> = None;
    let mut difficulty: Option<u32> = None;
    let mut workers: usize = 0;
    let mut start_nonce: u64 = 0;

    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--prefix" => {
                prefix_hex =
                    Some(iter.next().ok_or("missing value for --prefix")?);
            }
            "--difficulty" => {
                let v = iter.next().ok_or("missing value for --difficulty")?;
                difficulty = Some(
                    v.parse()
                        .map_err(|e| format!("--difficulty: {e}"))?,
                );
            }
            "--workers" => {
                let v = iter.next().ok_or("missing value for --workers")?;
                workers = v.parse().map_err(|e| format!("--workers: {e}"))?;
            }
            "--start-nonce" => {
                let v = iter
                    .next()
                    .ok_or("missing value for --start-nonce")?;
                start_nonce =
                    v.parse().map_err(|e| format!("--start-nonce: {e}"))?;
            }
            "--help" | "-h" => {
                eprintln!("usage: rpow-miner --prefix <hex> --difficulty <bits> [--workers N] [--start-nonce u64]");
                std::process::exit(0);
            }
            other => return Err(format!("unknown arg: {other}")),
        }
    }
    Ok(Args {
        prefix_hex: prefix_hex.ok_or("--prefix is required")?.to_string(),
        difficulty: difficulty.ok_or("--difficulty is required")?,
        workers,
        start_nonce,
    })
}

fn num_threads(default_workers: usize) -> usize {
    if default_workers > 0 {
        return default_workers;
    }
    thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}

fn emit_json(line: &str) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{line}");
    let _ = stdout.flush();
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            emit_json(&format!(
                "{{\"type\":\"error\",\"message\":\"{}\"}}",
                e.replace('"', "\\\"")
            ));
            std::process::exit(1);
        }
    };

    let prefix = match hex::decode(&args.prefix_hex) {
        Ok(p) => p,
        Err(e) => {
            emit_json(&format!(
                "{{\"type\":\"error\",\"message\":\"prefix is not valid hex: {}\"}}",
                e
            ));
            std::process::exit(1);
        }
    };

    if args.difficulty == 0 || args.difficulty > 256 {
        emit_json(
            "{\"type\":\"error\",\"message\":\"difficulty must be 1..=256\"}",
        );
        std::process::exit(1);
    }

    let num_workers = num_threads(args.workers).max(1);
    let difficulty = args.difficulty;
    let start_nonce = args.start_nonce;

    let found = Arc::new(AtomicBool::new(false));
    let total_hashes = Arc::new(AtomicU64::new(0));
    let result: Arc<Mutex<Option<(u64, [u8; 32], u32)>>> =
        Arc::new(Mutex::new(None));

    let started = Instant::now();

    // Progress reporter
    {
        let found_r = Arc::clone(&found);
        let total_r = Arc::clone(&total_hashes);
        thread::spawn(move || {
            while !found_r.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(500));
                if found_r.load(Ordering::Relaxed) {
                    break;
                }
                let h = total_r.load(Ordering::Relaxed);
                let ms = started.elapsed().as_millis() as u64;
                emit_json(&format!(
                    "{{\"type\":\"progress\",\"hashes\":{},\"elapsed_ms\":{}}}",
                    h, ms
                ));
            }
        });
    }

    // Mining workers
    let mut handles = Vec::with_capacity(num_workers);
    for wid in 0..num_workers {
        let prefix = prefix.clone();
        let found = Arc::clone(&found);
        let total_hashes = Arc::clone(&total_hashes);
        let result = Arc::clone(&result);
        let stride = num_workers as u64;

        handles.push(thread::spawn(move || {
            let mut buf = vec![0u8; prefix.len() + 8];
            buf[..prefix.len()].copy_from_slice(&prefix);
            let nonce_off = prefix.len();

            let mut nonce = start_nonce.wrapping_add(wid as u64);
            let mut local_hashes: u64 = 0;
            // Flush local counter to global every BATCH hashes.
            const BATCH: u64 = 1 << 16;

            // Required trailing zero bytes; remaining bits.
            let full_zero_bytes = (difficulty / 8) as usize;
            let rem_bits = difficulty - (full_zero_bytes as u32) * 8;
            let rem_mask: u8 = if rem_bits == 0 {
                0
            } else {
                (1u8 << rem_bits) - 1
            };

            // Hot loop
            loop {
                if local_hashes & (BATCH - 1) == 0 {
                    if found.load(Ordering::Relaxed) {
                        break;
                    }
                    if local_hashes != 0 {
                        total_hashes.fetch_add(BATCH, Ordering::Relaxed);
                    }
                }

                buf[nonce_off..nonce_off + 8]
                    .copy_from_slice(&nonce.to_le_bytes());

                let digest_arr: [u8; 32] = Sha256::digest(&buf).into();

                // Fast reject: trailing zero bytes from the end
                let mut ok = true;
                for i in 0..full_zero_bytes {
                    if digest_arr[31 - i] != 0 {
                        ok = false;
                        break;
                    }
                }
                if ok && rem_bits != 0 {
                    if digest_arr[31 - full_zero_bytes] & rem_mask != 0 {
                        ok = false;
                    }
                }
                if ok {
                    let tz = trailing_zero_bits(&digest_arr);
                    if tz >= difficulty {
                        if !found.swap(true, Ordering::SeqCst) {
                            let mut g = result.lock().unwrap();
                            *g = Some((nonce, digest_arr, tz));
                        }
                        break;
                    }
                }

                nonce = nonce.wrapping_add(stride);
                local_hashes = local_hashes.wrapping_add(1);
            }

            // flush leftover
            total_hashes.fetch_add(local_hashes & (BATCH - 1), Ordering::Relaxed);
        }));
    }

    for h in handles {
        let _ = h.join();
    }

    let elapsed_ms = started.elapsed().as_millis() as u64;
    let total = total_hashes.load(Ordering::Relaxed);

    let r = result.lock().unwrap().take();
    match r {
        Some((nonce, digest, tz)) => {
            let mut hex_buf = String::with_capacity(64);
            for b in digest.iter() {
                use std::fmt::Write;
                let _ = write!(&mut hex_buf, "{:02x}", b);
            }
            emit_json(&format!(
                "{{\"type\":\"found\",\"nonce\":\"{}\",\"digest\":\"{}\",\"trailing_zero_bits\":{},\"hashes\":{},\"elapsed_ms\":{}}}",
                nonce, hex_buf, tz, total, elapsed_ms
            ));
        }
        None => {
            emit_json(&format!(
                "{{\"type\":\"aborted\",\"hashes\":{},\"elapsed_ms\":{}}}",
                total, elapsed_ms
            ));
            std::process::exit(130);
        }
    }
}
