'use strict';

// Quick correctness + performance check for the miner.
// Uses a synthetic challenge at difficulty 20 so it completes in ~1 sec.

const {
  solveChallenge,
  defaultWorkers,
  activeBackend,
} = require('./lib/miner');
const { createHash, randomBytes } = require('crypto');

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

function nonceToLE8(n) {
  const b = Buffer.alloc(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

async function main() {
  const difficulty = Number(process.argv[2] || 22);
  const prefixBytes = randomBytes(16);
  const challenge = {
    challenge_id: 'bench',
    nonce_prefix: prefixBytes.toString('hex'),
    difficulty_bits: difficulty,
  };

  const workers = Number(process.argv[3] || defaultWorkers());
  const backend = process.argv[4] || activeBackend();
  console.log(
    `benchmarking: backend=${backend} difficulty=${difficulty} workers=${workers} prefix=${challenge.nonce_prefix}`,
  );
  const t0 = Date.now();
  const res = await solveChallenge(challenge, {
    workers,
    backend,
    onProgress: ({ total_hashes, elapsed_ms }) => {
      process.stdout.write(
        `\rprogress: hashes=${Number(total_hashes).toLocaleString()} elapsed=${elapsed_ms}ms`,
      );
    },
  });
  process.stdout.write('\n');
  const t1 = Date.now();

  // Verify solution
  const prefix = Buffer.from(challenge.nonce_prefix, 'hex');
  const input = Buffer.concat([prefix, nonceToLE8(res.solution_nonce)]);
  const d = createHash('sha256').update(input).digest();
  const tz = trailingZeroBits(d);
  const ok = tz >= difficulty;
  const rate = Number(res.hashes) / ((t1 - t0) / 1000);

  console.log(
    JSON.stringify(
      {
        solution_nonce: res.solution_nonce,
        digest: d.toString('hex'),
        worker_reported_tz: res.trailing_zero_bits,
        verified_tz: tz,
        target: difficulty,
        verified: ok,
        hashes: res.hashes.toString(),
        elapsed_ms: t1 - t0,
        rate_hashes_per_sec: Math.round(rate),
      },
      null,
      2,
    ),
  );
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
