'use strict';

// Spawn the native (Rust) rpow-miner binary and stream JSON results.
// The binary is expected at miner-rs/target/release/rpow-miner(.exe).

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const BIN_NAME = process.platform === 'win32' ? 'rpow-miner.exe' : 'rpow-miner';
const DEFAULT_PATHS = [
  process.env.RPOW_MINER_BIN, // explicit override
  path.join(ROOT, 'miner-rs', 'target', 'release', BIN_NAME),
  path.join(ROOT, 'bin', BIN_NAME),
  path.join(ROOT, BIN_NAME),
];

function findBinary() {
  for (const p of DEFAULT_PATHS) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function isAvailable() {
  return findBinary() !== null;
}

// Solve a challenge using the native miner. Same interface as
// lib/miner.js#solveChallenge so callers can swap implementations.
function solveChallengeNative(challenge, opts = {}) {
  const bin = opts.binary || findBinary();
  if (!bin) {
    return Promise.reject(
      new Error(
        `native miner binary not found. Tried: ${DEFAULT_PATHS.filter(Boolean).join(', ')}`,
      ),
    );
  }

  const workers = opts.workers || 0; // 0 = auto (CPU)
  const startNonce = opts.startNonce || 0;
  const onProgress = opts.onProgress;

  return new Promise((resolve, reject) => {
    const args = [
      '--prefix',
      challenge.nonce_prefix,
      '--difficulty',
      String(challenge.difficulty_bits),
      '--workers',
      String(workers),
      '--start-nonce',
      String(startNonce),
    ];

    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let resolved = false;
    const stderrChunks = [];
    child.stderr.on('data', (b) => stderrChunks.push(b));

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // ignore non-JSON lines
      }
      if (msg.type === 'progress') {
        if (onProgress) {
          onProgress({
            total_hashes: BigInt(msg.hashes || 0),
            elapsed_ms: msg.elapsed_ms || 0,
          });
        }
      } else if (msg.type === 'found') {
        resolved = true;
        rl.close();
        resolve({
          solution_nonce: String(msg.nonce),
          digest_hex: msg.digest,
          trailing_zero_bits: msg.trailing_zero_bits,
          hashes: BigInt(msg.hashes || 0),
          elapsed_ms: msg.elapsed_ms || 0,
          backend: 'native',
        });
        // process should exit on its own
      } else if (msg.type === 'error') {
        resolved = true;
        rl.close();
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(new Error(`native miner error: ${msg.message}`));
      }
    });

    child.on('error', (e) => {
      if (resolved) return;
      reject(new Error(`failed to spawn native miner: ${e.message}`));
    });

    child.on('exit', (code, signal) => {
      if (resolved) return;
      const stderr = Buffer.concat(stderrChunks).toString();
      if (signal) {
        reject(new Error(`native miner killed by signal ${signal}`));
      } else if (code !== 0) {
        reject(
          new Error(
            `native miner exited with code ${code}${stderr ? `: ${stderr}` : ''}`,
          ),
        );
      } else {
        // 0 exit but no "found" message – treat as anomaly.
        reject(new Error('native miner exited cleanly without producing a solution'));
      }
    });

    // Allow caller to cancel.
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      });
    }
  });
}

module.exports = { solveChallengeNative, isAvailable, findBinary };
