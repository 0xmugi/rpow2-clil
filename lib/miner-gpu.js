'use strict';

// Spawn the CUDA rpow-miner-gpu binary and stream JSON results.
// The binary is expected at gpu-miner/rpow-miner-gpu(.exe). Mirrors the
// interface of miner-native.js so the orchestrator can swap backends.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const BIN_NAME =
  process.platform === 'win32' ? 'rpow-miner-gpu.exe' : 'rpow-miner-gpu';
const DEFAULT_PATHS = [
  process.env.RPOW_MINER_GPU_BIN, // explicit override
  path.join(ROOT, 'gpu-miner', BIN_NAME),
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

// Solve a challenge using the CUDA GPU miner. Same interface as
// lib/miner.js#solveChallenge and lib/miner-native.js#solveChallengeNative
// so callers can swap implementations transparently.
function solveChallengeGpu(challenge, opts = {}) {
  const bin = opts.binary || findBinary();
  if (!bin) {
    return Promise.reject(
      new Error(
        `GPU miner binary not found. Build it first:\n` +
          `  cd gpu-miner && .\\build.ps1\n` +
          `Tried: ${DEFAULT_PATHS.filter(Boolean).join(', ')}`,
      ),
    );
  }

  const startNonce = opts.startNonce || 0;
  const onProgress = opts.onProgress;

  return new Promise((resolve, reject) => {
    const args = [
      '--prefix',
      challenge.nonce_prefix,
      '--difficulty',
      String(challenge.difficulty_bits),
      '--start-nonce',
      String(startNonce),
    ];
    // Optional tuning knobs -- only set when caller overrides defaults.
    if (opts.device != null) args.push('--device', String(opts.device));
    if (opts.grid) args.push('--grid', String(opts.grid));
    if (opts.block) args.push('--block', String(opts.block));
    if (opts.batch) args.push('--batch', String(opts.batch));

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
          backend: 'gpu',
        });
      } else if (msg.type === 'error') {
        resolved = true;
        rl.close();
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(new Error(`GPU miner error: ${msg.message}`));
      }
    });

    child.on('error', (e) => {
      if (resolved) return;
      reject(new Error(`failed to spawn GPU miner: ${e.message}`));
    });

    child.on('exit', (code, signal) => {
      if (resolved) return;
      const stderr = Buffer.concat(stderrChunks).toString();
      if (signal) {
        reject(new Error(`GPU miner killed by signal ${signal}`));
      } else if (code !== 0) {
        reject(
          new Error(
            `GPU miner exited with code ${code}${stderr ? `: ${stderr}` : ''}`,
          ),
        );
      } else {
        reject(
          new Error('GPU miner exited cleanly without producing a solution'),
        );
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

module.exports = { solveChallengeGpu, isAvailable, findBinary };
