'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');
const native = require('./miner-native');
const gpu = require('./miner-gpu');

const WORKER_FILE = path.join(__dirname, '..', 'miner-worker.js');

function defaultWorkers() {
  // Leave one core for the main thread / network.
  const n = (os.availableParallelism && os.availableParallelism()) || os.cpus().length || 2;
  return Math.max(1, n - 1);
}

function activeBackend() {
  const env = process.env.RPOW_BACKEND;
  if (env === 'node' || env === 'native' || env === 'gpu') return env;
  // Auto-pick: never default to GPU (it may not be built); prefer native
  // over node-workers when the Rust binary is present.
  return native.isAvailable() ? 'native' : 'node';
}

// Mine a single challenge using the configured backend. Can be forced via
// opts.backend or $RPOW_BACKEND=gpu|native|node.
function solveChallenge(challenge, opts = {}) {
  const backend = opts.backend || activeBackend();
  if (backend === 'gpu') {
    return gpu
      .solveChallengeGpu(challenge, opts)
      .then((res) => ({ ...res, backend: 'gpu' }));
  }
  if (backend === 'native') {
    return native
      .solveChallengeNative(challenge, opts)
      .then((res) => ({ ...res, backend: 'native' }));
  }
  return solveChallengeNode(challenge, opts).then((res) => ({
    ...res,
    backend: 'node',
  }));
}

// Mine a single challenge using N parallel Node worker threads.
// Returns { solution_nonce, hashes, elapsed_ms, digest_hex, trailing_zero_bits }
function solveChallengeNode(challenge, opts = {}) {
  const numWorkers = Math.max(1, opts.workers || defaultWorkers());
  const startNonce = opts.startNonce || 0n;
  const onProgress = opts.onProgress;

  return new Promise((resolve, reject) => {
    const workers = [];
    let totalHashes = 0n;
    const perWorker = new Array(numWorkers).fill(0n);
    const startedAt = Date.now();
    let settled = false;

    const finish = (action, result) => {
      if (settled) return;
      settled = true;
      for (const w of workers) {
        try {
          w.postMessage({ type: 'abort' });
        } catch {
          /* ignore */
        }
      }
      // Give workers a tiny grace period to exit cleanly, then terminate.
      setTimeout(() => {
        for (const w of workers) {
          w.terminate().catch(() => {});
        }
      }, 50);
      if (action === 'resolve') resolve(result);
      else reject(result);
    };

    for (let i = 0; i < numWorkers; i++) {
      const worker = new Worker(WORKER_FILE, {
        workerData: {
          nonce_prefix: challenge.nonce_prefix,
          difficulty_bits: challenge.difficulty_bits,
          worker_id: i,
          num_workers: numWorkers,
          start_nonce: startNonce.toString(),
        },
      });
      workers.push(worker);

      worker.on('message', (msg) => {
        if (!msg) return;
        if (msg.type === 'progress') {
          const h = BigInt(msg.hashes);
          totalHashes += h - perWorker[i];
          perWorker[i] = h;
          if (onProgress) {
            onProgress({
              total_hashes: totalHashes,
              elapsed_ms: Date.now() - startedAt,
            });
          }
        } else if (msg.type === 'found') {
          const h = BigInt(msg.hashes);
          totalHashes += h - perWorker[i];
          finish('resolve', {
            solution_nonce: msg.solution_nonce,
            digest_hex: msg.digest_hex,
            trailing_zero_bits: msg.trailing_zero_bits,
            hashes: totalHashes,
            elapsed_ms: Date.now() - startedAt,
            workers: numWorkers,
          });
        } else if (msg.type === 'aborted') {
          // ignore
        }
      });

      worker.on('error', (e) => {
        finish('reject', e);
      });
      worker.on('exit', (code) => {
        if (!settled && code !== 0) {
          finish(
            'reject',
            new Error(`miner worker exited with code ${code}`),
          );
        }
      });
    }
  });
}

module.exports = {
  solveChallenge,
  defaultWorkers,
  activeBackend,
  isNativeAvailable: native.isAvailable,
  nativeBinaryPath: native.findBinary,
  isGpuAvailable: gpu.isAvailable,
  gpuBinaryPath: gpu.findBinary,
};
