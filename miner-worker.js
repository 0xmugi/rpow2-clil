'use strict';

// SHA-256 trailing-zero-bits proof-of-work worker.
// Hash input layout matches the rpow2 web miner:
//   data = nonce_prefix_bytes || nonce_le_8bytes
//   sha256(data) must have >= difficulty_bits *trailing* zero bits.

const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');

// Node 21+ exposes a fast single-shot crypto.hash(). On older Node we fall
// back to createHash() per iteration.
const hasFastHash = typeof crypto.hash === 'function';
const sha256 = hasFastHash
  ? (data) => crypto.hash('sha256', data, 'buffer')
  : (data) => crypto.createHash('sha256').update(data).digest();

const { nonce_prefix, difficulty_bits, worker_id, num_workers, start_nonce } =
  workerData;

if (typeof nonce_prefix !== 'string') {
  throw new Error('nonce_prefix must be a hex string');
}
if (!Number.isInteger(difficulty_bits) || difficulty_bits < 1) {
  throw new Error('difficulty_bits must be a positive integer');
}

const prefix = Buffer.from(nonce_prefix, 'hex');
const buf = Buffer.alloc(prefix.length + 8);
prefix.copy(buf, 0);
const NONCE_OFFSET = prefix.length;

// Two-uint32 nonce counter (lo + hi * 2^32) – avoids BigInt cost.
// Each worker starts at (start_nonce + worker_id) and advances by num_workers.
const stride = num_workers || 1;
const startBig = BigInt(start_nonce || 0) + BigInt(worker_id || 0);
let lo = Number(startBig & 0xffffffffn) >>> 0;
let hi = Number((startBig >> 32n) & 0xffffffffn) >>> 0;

let hashesLo = 0; // total hashes performed (split for >2^32 support)
let hashesHi = 0;
const startedAt = Date.now();
let lastReport = startedAt;

let aborted = false;
parentPort.on('message', (msg) => {
  if (msg && msg.type === 'abort') aborted = true;
});

// Required trailing zero bytes/bits for early termination check.
const fullZeroBytes = Math.floor(difficulty_bits / 8);
const remBits = difficulty_bits - fullZeroBytes * 8;
const remMask = remBits === 0 ? 0 : (1 << remBits) - 1;
const TZ_INDEX = 31 - fullZeroBytes; // SHA256 digest length is 32

function trailingZeroBits(digest) {
  let count = 0;
  for (let i = digest.length - 1; i >= 0; i--) {
    const b = digest[i];
    if (b === 0) {
      count += 8;
      continue;
    }
    let c = 0;
    while ((b & (1 << c)) === 0) c++;
    return count + c;
  }
  return count;
}

function reportFound(digest, tz) {
  const nonceBig =
    BigInt(hi >>> 0) * 0x100000000n + BigInt(lo >>> 0);
  const totalHashes =
    BigInt(hashesHi >>> 0) * 0x100000000n + BigInt(hashesLo >>> 0);
  parentPort.postMessage({
    type: 'found',
    solution_nonce: nonceBig.toString(),
    digest_hex: digest.toString('hex'),
    trailing_zero_bits: tz,
    hashes: totalHashes.toString(),
  });
}

function reportProgress(elapsedMs) {
  const totalHashes =
    BigInt(hashesHi >>> 0) * 0x100000000n + BigInt(hashesLo >>> 0);
  parentPort.postMessage({
    type: 'progress',
    hashes: totalHashes.toString(),
    elapsed_ms: elapsedMs,
  });
}

const REPORT_INTERVAL = 16384; // hashes

while (!aborted) {
  // Write 8-byte LE nonce: lo at offset+0..3, hi at offset+4..7
  buf.writeUInt32LE(lo, NONCE_OFFSET);
  buf.writeUInt32LE(hi, NONCE_OFFSET + 4);

  const digest = sha256(buf);

  // Fast-path: check trailing zero bytes from the end of the digest.
  let ok = true;
  for (let i = 0; i < fullZeroBytes; i++) {
    if (digest[31 - i] !== 0) {
      ok = false;
      break;
    }
  }
  if (ok && remBits !== 0) {
    if ((digest[TZ_INDEX] & remMask) !== 0) ok = false;
  }
  if (ok) {
    const tz = trailingZeroBits(digest);
    if (tz >= difficulty_bits) {
      reportFound(digest, tz);
      return;
    }
  }

  // advance nonce by `stride`
  lo = (lo + stride) >>> 0;
  if (lo < stride) {
    // overflow
    hi = (hi + 1) >>> 0;
  }

  // increment hash counter (also two-uint32)
  hashesLo = (hashesLo + 1) >>> 0;
  if (hashesLo === 0) hashesHi = (hashesHi + 1) >>> 0;

  if ((hashesLo & (REPORT_INTERVAL - 1)) === 0) {
    const now = Date.now();
    if (now - lastReport >= 500) {
      reportProgress(now - startedAt);
      lastReport = now;
    }
  }
}

const totalHashes =
  BigInt(hashesHi >>> 0) * 0x100000000n + BigInt(hashesLo >>> 0);
parentPort.postMessage({
  type: 'aborted',
  hashes: totalHashes.toString(),
});
