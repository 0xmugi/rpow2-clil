#!/usr/bin/env node
'use strict';

const readline = require('readline');
const os = require('os');
const session = require('./lib/session');
const { api, ApiError, API_BASE } = require('./lib/api');
const ui = require('./lib/ui');
const {
  solveChallenge,
  defaultWorkers,
  activeBackend,
  nativeBinaryPath,
  gpuBinaryPath,
} = require('./lib/miner');

// ---------- helpers ----------

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        args.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          args.flags[a.slice(2)] = next;
          i++;
        } else {
          args.flags[a.slice(2)] = true;
        }
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function ask(prompt, { mask = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    if (mask) {
      // not strictly needed but keep simple
    }
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function describeError(e) {
  if (e instanceof ApiError) {
    return `${e.code}: ${e.message}`;
  }
  return e && e.message ? e.message : String(e);
}

async function getMe(state, { retries = 4 } = {}) {
  // Transient network/API errors at startup ("fetch failed", HTTP_500) are
  // common from any consumer ISP -> api.rpow2.com. Retry a few times with
  // backoff before giving up so a one-shot blip doesn't kill `node rpow.js
  // mine`. Auth errors are not retried.
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await api.me(state);
    } catch (e) {
      if (
        e instanceof ApiError &&
        (e.status === 401 || e.status === 403 || e.code === 'UNAUTHORIZED')
      ) {
        return null;
      }
      lastErr = e;
      if (attempt < retries) {
        const delay = 500 * (attempt + 1); // 0.5s, 1s, 1.5s, 2s
        ui.warn(
          `getMe failed (${describeError(e)}); retry ${attempt + 1}/${retries} in ${delay}ms`,
        );
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

function printBanner() {
  console.log('+======================================================================+');
  console.log('|                   RPOW2 - Reusable Proofs of Work                    |');
  console.log('|                          headless CLI miner                          |');
  console.log('+======================================================================+');
}

// ---------- commands ----------

async function cmdLogin(args) {
  const profile = args.flags.profile;
  const state = session.load(profile);
  let email = args._[0] || args.flags.email;

  // already logged in?
  if (Object.keys(state.cookies).length > 0) {
    const me = await getMe(state).catch(() => null);
    if (me && me.email) {
      ui.info(
        `already logged in as ${me.email}${profile ? ` (profile: ${profile})` : ''}`,
      );
      ui.info(`session file: ${session.file(state)}`);
      return me;
    }
  }

  if (!email) {
    email = await ask('EMAIL : ');
  }
  if (!email) {
    ui.err('email is required');
    process.exit(2);
  }
  state.email = email;
  session.save(state);

  ui.info(`requesting magic link for ${email} ...`);
  await api.authRequest(email, state);
  ui.info('OK. check your inbox – the link expires in 15 minutes.');
  console.log('');
  console.log('  paste the magic link from the email below (whole URL).');
  console.log('  it usually starts with https://api.rpow2.com/ or https://rpow2.com/');
  console.log('');
  const link = await ask('LINK  : ');
  if (!link) {
    ui.err('no link provided');
    process.exit(2);
  }

  ui.info('verifying link ...');
  await api.followMagicLink(link, state);

  const me = await getMe(state);
  if (!me || !me.email) {
    ui.err('verification did not produce a session – the link may have expired or already been used.');
    process.exit(1);
  }
  state.email = me.email;
  session.save(state);

  ui.info(`logged in as ${me.email}`);
  printAccount(me);
  return me;
}

async function cmdLogout(args) {
  const profile = args && args.flags && args.flags.profile;
  const state = session.load(profile);
  if (Object.keys(state.cookies).length === 0) {
    ui.info(`no active session${profile ? ` for profile ${profile}` : ''}.`);
    return;
  }
  try {
    await api.logout(state);
  } catch (e) {
    ui.warn(`server logout failed: ${describeError(e)}`);
  }
  session.clear(state);
  ui.info(
    `local session cleared${profile ? ` (profile: ${profile})` : ''}.`,
  );
}

async function cmdStatus(args) {
  const profile = args && args.flags && args.flags.profile;
  if (!profile && args && args.flags && args.flags.all) {
    return cmdStatusAll();
  }
  const state = session.load(profile);
  if (Object.keys(state.cookies).length === 0) {
    ui.info(
      `not logged in${profile ? ` (profile: ${profile})` : ''}. run: node rpow.js login${profile ? ` --profile=${profile}` : ''}`,
    );
    return;
  }
  const me = await getMe(state);
  if (!me) {
    ui.warn('session expired. run: node rpow.js login');
    return;
  }
  printAccount(me);

  try {
    const ledger = await api.ledger(state);
    if (ledger) {
      console.log(
        ui.box(
          'PUBLIC LEDGER',
          [
            `TOTAL MINTED        : ${ledger.total_minted}`,
            `TOTAL TRANSFERRED   : ${ledger.total_transferred}`,
            `CIRCULATING SUPPLY  : ${ledger.circulating_supply}`,
            `CURRENT DIFFICULTY  : ${ledger.current_difficulty_bits} trailing zero bits`,
            `USER COUNT          : ${ledger.user_count}`,
          ].join('\n'),
        ),
      );
    }
  } catch (e) {
    ui.warn(`ledger fetch failed: ${describeError(e)}`);
  }
}

async function cmdActivity(args) {
  const profile = args && args.flags && args.flags.profile;
  const state = session.load(profile);
  const me = await getMe(state);
  if (!me) {
    ui.warn('not logged in.');
    return;
  }
  const items = await api.activity(state);
  if (!items || items.length === 0) {
    console.log(ui.box('ACTIVITY', '(no activity yet)'));
    return;
  }
  const lines = items.map((l) => {
    const at = l.at.replace('T', ' ').slice(0, 19);
    const cp = l.counterparty_email || '';
    const type = String(l.type).toUpperCase().padEnd(8);
    const sign = l.type === 'send' ? '-' : '+';
    return `${at}  ${type}  ${(sign + l.amount).padStart(4)}  ${cp}`;
  });
  console.log(ui.box('ACTIVITY', lines.join('\n')));
}

function printAccount(me, profile) {
  console.log(
    ui.box(
      profile ? `ACCOUNT (${profile})` : 'ACCOUNT',
      [
        `> LOGGED IN AS: ${me.email}`,
        `> BALANCE     : ${String(me.balance).padStart(4, '0')} RPOW`,
        `> MINTED      : ${String(me.minted).padStart(4, '0')}`,
        `> SENT        : ${String(me.sent).padStart(4, '0')}`,
        `> RECEIVED    : ${String(me.received).padStart(4, '0')}`,
      ].join('\n'),
    ),
  );
}

async function cmdStatusAll() {
  const profiles = session.list();
  if (profiles.length === 0) {
    ui.info('no profiles found. run: node rpow.js login [email] --profile=NAME');
    return;
  }
  let totalBalance = 0;
  let totalMinted = 0;
  const rows = [];
  for (const p of profiles) {
    const profileArg = p.name === 'default' ? null : p.name;
    const state = session.load(profileArg);
    if (Object.keys(state.cookies).length === 0) {
      rows.push(
        `${p.name.padEnd(14)} (no session)`,
      );
      continue;
    }
    let me;
    try {
      me = await api.me(state);
    } catch (e) {
      rows.push(
        `${p.name.padEnd(14)} ${state.email || '?'}  ERR ${describeError(e)}`,
      );
      continue;
    }
    totalBalance += Number(me.balance) || 0;
    totalMinted += Number(me.minted) || 0;
    rows.push(
      `${p.name.padEnd(14)} ${String(me.email).padEnd(28)}  bal=${String(me.balance).padStart(5)}  minted=${String(me.minted).padStart(5)}`,
    );
  }
  rows.push('');
  rows.push(
    `TOTAL                                          bal=${String(totalBalance).padStart(5)}  minted=${String(totalMinted).padStart(5)}`,
  );
  console.log(ui.box('ALL PROFILES', rows.join('\n')));
}

async function cmdProfiles() {
  const profiles = session.list();
  if (profiles.length === 0) {
    console.log(
      ui.box(
        'PROFILES',
        '(none)\n\nLogin a new profile with:\n  node rpow.js login your@email.com --profile=NAME',
      ),
    );
    return;
  }
  const rows = profiles.map(
    (p) => `${p.name.padEnd(14)} ${p.file}`,
  );
  console.log(ui.box('PROFILES', rows.join('\n')));
}

async function ensureLoggedIn(profile) {
  const state = session.load(profile);
  if (Object.keys(state.cookies).length === 0) {
    ui.info(
      `no session${profile ? ` for profile ${profile}` : ''} – starting login flow.`,
    );
    await cmdLogin({ _: [], flags: { profile } });
    return session.load(profile);
  }
  const me = await getMe(state);
  if (!me) {
    ui.warn(
      `session expired${profile ? ` for profile ${profile}` : ''} – starting login flow.`,
    );
    session.clear(state);
    await cmdLogin({ _: [], flags: { profile } });
    return session.load(profile);
  }
  return state;
}

async function cmdMine(args) {
  const profile = args.flags.profile;
  const state = await ensureLoggedIn(profile);
  // Use the retry-aware getMe here so a one-shot network blip on the very
  // first /me right after login doesn't kill the miner with `fetch failed`.
  const me = await getMe(state);
  if (!me) {
    ui.err('session unexpectedly invalid right after login; aborting.');
    process.exit(1);
  }
  printAccount(me, profile);

  const workers = Math.max(1, Number(args.flags.workers) || defaultWorkers());
  const maxTokens = args.flags.max ? Number(args.flags.max) : Infinity;
  const backend = args.flags.backend || activeBackend();
  const binPath =
    backend === 'native'
      ? nativeBinaryPath()
      : backend === 'gpu'
      ? gpuBinaryPath()
      : null;
  const refreshIntervalMs = Math.max(
    5000,
    Number(args.flags['refresh-ms']) || 60000,
  );
  // Mint pipelining: while a /mint request is in flight (~3s round-trip),
  // we can already start mining the NEXT challenge so the CPU is never idle
  // waiting for the network. Cap the number of concurrent mints to avoid
  // runaway / accidental rate limiting. Default 3 covers mint_time/mine_time
  // ratios up to ~3x. Override with --inflight=N.
  const inFlightCap = Math.max(
    1,
    Number(args.flags.inflight) || (args.flags['no-pipeline'] ? 1 : 3),
  );
  const tag = profile ? `[${profile}] ` : '';

  ui.info(
    `${tag}backend=${backend}${binPath ? ` (${binPath})` : ''} workers=${workers} inflight=${inFlightCap}. press Ctrl+C to stop.`,
  );

  let stop = false;
  const onSig = () => {
    if (stop) {
      ui.warn('force exit.');
      process.exit(130);
    }
    stop = true;
    ui.info('stopping after current attempt (waiting for in-flight mints) ...');
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  let mined = 0; // tokens whose /mint succeeded
  let started = 0; // tokens whose mining started (incl. in-flight + failed)
  let totalHashes = 0n;
  const sessionStart = Date.now();
  let displayBalance = Number(me.balance) || 0;
  let displayMinted = Number(me.minted) || 0;
  let lastMeAt = Date.now();

  // Helper that wraps api.challenge() so a rejection becomes a sentinel
  // value we can inspect after `await`. This lets us prefetch the next
  // challenge concurrently with mining + minting the current one without
  // unhandled rejection warnings.
  const fetchChallenge = () =>
    api.challenge(state).then(
      (c) => ({ ok: true, challenge: c }),
      (e) => ({ ok: false, error: e }),
    );

  // Prefetch the first challenge.
  let pendingChallenge = fetchChallenge();

  // Set of in-flight mint promises. Populated by `fireMint`, cleaned up
  // automatically when each promise settles. We use a Set rather than an
  // array so we can `Promise.race` cheaply and remove by reference.
  const inFlightMints = new Set();

  // Submit a /mint for the just-solved challenge as a background task.
  // The promise itself never rejects: any error is caught + logged, so
  // `Promise.race` / `Promise.all` over the set is always safe.
  //
  // Transient failures ("fetch failed", HTTP_500, etc.) are retried with
  // backoff so a flaky network doesn't cost us tokens we already mined.
  // STALE_CHALLENGE is permanent (challenge gone) so we drop immediately.
  const mintRetries = Math.max(0, Number(args.flags['mint-retries']) || 3);
  const fireMint = (challenge, found) => {
    const cidShort = shorten(challenge.challenge_id);
    const p = (async () => {
      let lastErr;
      for (let attempt = 0; attempt <= mintRetries; attempt++) {
        try {
          const mintRes = await api.mint(
            {
              challenge_id: challenge.challenge_id,
              solution_nonce: found.solution_nonce,
            },
            state,
          );
          mined += 1;
          // Update displayed balance: prefer server-reported value, else
          // increment locally.
          const balanceFromMint = pickNumber(mintRes, [
            'balance',
            'user.balance',
            'account.balance',
          ]);
          const mintedFromMint = pickNumber(mintRes, [
            'minted',
            'user.minted',
            'account.minted',
          ]);
          if (typeof balanceFromMint === 'number') {
            displayBalance = balanceFromMint;
          } else {
            displayBalance += 1;
          }
          if (typeof mintedFromMint === 'number') {
            displayMinted = mintedFromMint;
          } else {
            displayMinted += 1;
          }
          const tokenId = mintRes && mintRes.token && mintRes.token.id;
          ui.info(
            `+ minted ${tokenId ? `token ${shorten(tokenId)} ` : ''}(run: ${mined}, balance: ${displayBalance}, total hashes: ${ui.fmtNum(Number(totalHashes))}, uptime: ${ui.fmtElapsed(Date.now() - sessionStart)})${attempt > 0 ? ` [after ${attempt} retry]` : ''}`,
          );
          return;
        } catch (e) {
          lastErr = e;
          // Permanent: don't retry.
          if (e instanceof ApiError && e.code === 'STALE_CHALLENGE') {
            ui.warn(
              `challenge ${cidShort} expired before submission, dropped`,
            );
            return;
          }
          if (
            e instanceof ApiError &&
            (e.status === 401 || e.code === 'UNAUTHORIZED')
          ) {
            ui.warn(`${tag}session expired during mint; will stop loop.`);
            stop = true;
            session.clear(state);
            return;
          }
          // Transient: backoff + retry.
          if (attempt < mintRetries) {
            const delay = 500 * (attempt + 1);
            ui.warn(
              `mint ${cidShort} failed (${describeError(e)}); retry ${attempt + 1}/${mintRetries} in ${delay}ms`,
            );
            await sleep(delay);
          }
        }
      }
      ui.err(
        `mint ${cidShort} failed after ${mintRetries + 1} attempts: ${describeError(lastErr)}`,
      );
    })();
    inFlightMints.add(p);
    p.finally(() => inFlightMints.delete(p));
    return p;
  };

  while (!stop && started < maxTokens) {
    const got = await pendingChallenge;
    if (!got.ok) {
      const e = got.error;
      if (
        e instanceof ApiError &&
        (e.status === 401 || e.code === 'UNAUTHORIZED')
      ) {
        ui.warn(`${tag}session expired mid-mining; re-login required.`);
        session.clear(state);
        break;
      }
      ui.err(`challenge failed: ${describeError(e)}`);
      await sleep(3000);
      pendingChallenge = fetchChallenge();
      continue;
    }
    const challenge = got.challenge;

    // Kick off prefetch of the NEXT challenge in parallel with mining +
    // minting the current one. By the time we finish minting, the next
    // challenge is usually already in hand, saving one network round-trip
    // per token.
    pendingChallenge = fetchChallenge();

    ui.info(
      `challenge ${challenge.challenge_id} difficulty=${challenge.difficulty_bits} bits prefix=${shorten(
        challenge.nonce_prefix,
      )}`,
    );

    const tickStart = Date.now();
    let lastTick = tickStart;
    let lastHashes = 0n;

    let found;
    try {
      found = await solveChallenge(challenge, {
        workers,
        backend,
        onProgress: ({ total_hashes, elapsed_ms }) => {
          const now = Date.now();
          if (now - lastTick < 1000) return;
          const dt = (now - lastTick) / 1000;
          const dh = Number(total_hashes - lastHashes);
          const rate = dt > 0 ? dh / dt : 0;
          lastTick = now;
          lastHashes = total_hashes;
          ui.statusLine(
            `  hashes=${ui.fmtNum(Number(total_hashes))} rate=${ui.fmtRate(
              rate,
            )} elapsed=${ui.fmtElapsed(elapsed_ms)}`,
          );
        },
      });
    } catch (e) {
      ui.clearLine();
      ui.err(`mining error: ${describeError(e)}`);
      await sleep(2000);
      continue;
    }
    ui.clearLine();

    const rate =
      found.elapsed_ms > 0
        ? Number(found.hashes) / (found.elapsed_ms / 1000)
        : 0;
    ui.info(
      `solved in ${ui.fmtElapsed(found.elapsed_ms)} (${ui.fmtNum(Number(found.hashes))} hashes, ${ui.fmtRate(rate)}, tz=${found.trailing_zero_bits} bits)`,
    );

    started += 1;
    totalHashes += found.hashes;

    // Submit /mint as a background task. The CPU is now free to start
    // mining the next challenge while this mint is in flight (~3s).
    fireMint(challenge, found);

    // Backpressure: cap concurrent mints. If we're over the cap, wait for
    // ANY one to finish before starting the next mining round. Using
    // Promise.race so we resume as soon as one slot frees up, not all.
    if (inFlightMints.size >= inFlightCap) {
      await Promise.race(inFlightMints);
    }

    // Periodically refresh full account from /me (non-blocking).
    if (Date.now() - lastMeAt >= refreshIntervalMs) {
      lastMeAt = Date.now();
      api.me(state).then(
        (fresh) => {
          displayBalance = Number(fresh.balance) || displayBalance;
          displayMinted = Number(fresh.minted) || displayMinted;
          ui.info(
            `  refresh: balance=${fresh.balance} minted=${fresh.minted} sent=${fresh.sent} received=${fresh.received}`,
          );
        },
        () => {
          /* non-fatal */
        },
      );
    }
  }

  // Drain any pending mints before reporting "done".
  if (inFlightMints.size > 0) {
    ui.info(`waiting for ${inFlightMints.size} pending mint(s) to finish ...`);
    await Promise.all(inFlightMints);
  }

  process.off('SIGINT', onSig);
  process.off('SIGTERM', onSig);
  ui.info(
    `done. mined ${mined}/${started} token(s) in ${ui.fmtElapsed(Date.now() - sessionStart)}.`,
  );
}

async function cmdRun(args) {
  // default flow: login if needed, then mine forever.
  printBanner();
  await cmdMine(args);
}

// Multi-worker mining: spawn N concurrent challenge -> solve -> mint chains
// against a SINGLE account. Differs from `mine` (one loop, N inflight mints)
// by also parallelizing /challenge fetches, so the API mint-pipeline can be
// saturated past the single-fetch ceiling. GPU access is serialized via an
// async mutex so we never have two GPU solver subprocesses fighting over the
// device. CPU/native solvers run unconstrained per worker.
async function cmdMineWorkers(args) {
  const profile = args.flags.profile;
  const state = await ensureLoggedIn(profile);
  const me = await getMe(state);
  if (!me) {
    ui.err('session unexpectedly invalid right after login; aborting.');
    process.exit(1);
  }
  printAccount(me, profile);

  const numWorkers = Math.max(
    1,
    Number(args.flags.workers) || (os.cpus().length || 4),
  );
  const maxTokens = args.flags.max ? Number(args.flags.max) : Infinity;
  const backend = args.flags.backend || activeBackend();
  const binPath =
    backend === 'native'
      ? nativeBinaryPath()
      : backend === 'gpu'
      ? gpuBinaryPath()
      : null;
  // How many internal solver threads each worker uses per /challenge.
  // Default 1 so N parallel workers x 1 thread = N CPU cores total.
  const solveWorkers = Math.max(
    1,
    Number(args.flags['solve-workers']) || 1,
  );
  const refreshIntervalMs = Math.max(
    5000,
    Number(args.flags['refresh-ms']) || 60000,
  );
  const statsMs = Math.max(1000, Number(args.flags['stats-ms']) || 30000);
  const mintRetries = Math.max(0, Number(args.flags['mint-retries']) || 3);
  const tag = profile ? `[${profile}] ` : '';

  ui.info(
    `${tag}backend=${backend}${binPath ? ` (${binPath})` : ''} workers=${numWorkers} solve-workers=${solveWorkers}. press Ctrl+C to stop.`,
  );

  // GPU mutex: chain GPU solver invocations so only one runs at a time.
  // CPU/native backends parallelize fine across worker subprocesses.
  let gpuChain = Promise.resolve();
  const acquireGpu = (fn) => {
    const prev = gpuChain;
    let release;
    const wait = new Promise((r) => (release = r));
    gpuChain = wait;
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  };

  let stop = false;
  let totalMints = 0;
  let totalErrors = 0;
  let totalHashes = 0n;
  const sessionStart = Date.now();
  const workerStats = [];
  for (let i = 0; i < numWorkers; i++) {
    workerStats.push({
      id: i + 1,
      mints: 0,
      errors: 0,
      hashes: 0n,
      lastDifficulty: 0,
      lastSolveMs: 0,
    });
  }

  let displayBalance = Number(me.balance) || 0;
  let displayMinted = Number(me.minted) || 0;
  let lastMeAt = Date.now();

  const onSig = () => {
    if (stop) {
      ui.warn('force exit.');
      process.exit(130);
    }
    stop = true;
    ui.info('stopping all workers (waiting for in-flight) ...');
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  const runOne = async (workerId) => {
    const ws = workerStats[workerId - 1];
    while (!stop && totalMints < maxTokens) {
      // ---- /challenge ----
      let challenge;
      try {
        challenge = await api.challenge(state);
      } catch (e) {
        if (
          e instanceof ApiError &&
          (e.status === 401 || e.code === 'UNAUTHORIZED')
        ) {
          ui.err(`[w${workerId}] session expired; stopping all workers.`);
          stop = true;
          session.clear(state);
          return;
        }
        ws.errors += 1;
        totalErrors += 1;
        ui.warn(`[w${workerId}] challenge: ${describeError(e)}`);
        await sleep(500);
        continue;
      }
      if (stop) return;
      ws.lastDifficulty = challenge.difficulty_bits;

      // ---- solve ----
      const solveStart = Date.now();
      let found;
      try {
        const solveOpts = {
          backend,
          binary: binPath,
          workers: solveWorkers,
        };
        found =
          backend === 'gpu'
            ? await acquireGpu(() => solveChallenge(challenge, solveOpts))
            : await solveChallenge(challenge, solveOpts);
      } catch (e) {
        ws.errors += 1;
        totalErrors += 1;
        ui.warn(`[w${workerId}] solve: ${describeError(e)}`);
        await sleep(500);
        continue;
      }
      if (stop) return;
      ws.lastSolveMs = Date.now() - solveStart;
      const hashesBig =
        typeof found.hashes === 'bigint' ? found.hashes : BigInt(found.hashes || 0);
      ws.hashes += hashesBig;
      totalHashes += hashesBig;

      // ---- /mint with retries (transient errors only) ----
      let mintRes = null;
      let mintErr = null;
      for (let attempt = 0; attempt <= mintRetries; attempt++) {
        if (stop) return;
        try {
          mintRes = await api.mint(
            {
              challenge_id: challenge.challenge_id,
              solution_nonce: found.solution_nonce,
            },
            state,
          );
          break;
        } catch (e) {
          mintErr = e;
          if (
            e instanceof ApiError &&
            (e.status === 401 || e.code === 'UNAUTHORIZED')
          ) {
            ui.err(`[w${workerId}] session expired during mint; stopping.`);
            stop = true;
            session.clear(state);
            return;
          }
          // Permanent failures — don't retry.
          if (
            e instanceof ApiError &&
            (e.code === 'STALE_CHALLENGE' ||
              e.code === 'CHALLENGE_NOT_FOUND' ||
              e.code === 'INVALID_SOLUTION')
          ) {
            break;
          }
          if (attempt < mintRetries) {
            await sleep(500 * (attempt + 1));
          }
        }
      }

      if (mintRes) {
        ws.mints += 1;
        totalMints += 1;
        const balFromMint = pickNumber(mintRes, [
          'balance',
          'user.balance',
          'account.balance',
        ]);
        const minFromMint = pickNumber(mintRes, [
          'minted',
          'user.minted',
          'account.minted',
        ]);
        if (typeof balFromMint === 'number') displayBalance = balFromMint;
        else displayBalance += 1;
        if (typeof minFromMint === 'number') displayMinted = minFromMint;
        else displayMinted += 1;
        const tokenId = mintRes && mintRes.token && mintRes.token.id;
        ui.info(
          `+ [w${workerId}] minted${tokenId ? ` ${shorten(tokenId)}` : ''} (diff=${challenge.difficulty_bits} solve=${ws.lastSolveMs}ms #${totalMints} bal=${displayBalance})`,
        );
      } else if (mintErr) {
        ws.errors += 1;
        totalErrors += 1;
        ui.warn(
          `[w${workerId}] mint: ${describeError(mintErr)} (cid=${shorten(challenge.challenge_id)})`,
        );
      }

      // Periodic /me refresh (worker #1 only, best-effort).
      if (workerId === 1 && Date.now() - lastMeAt >= refreshIntervalMs) {
        lastMeAt = Date.now();
        api.me(state).then(
          (fresh) => {
            displayBalance = Number(fresh.balance) || displayBalance;
            displayMinted = Number(fresh.minted) || displayMinted;
          },
          () => {
            /* non-fatal */
          },
        );
      }
    }
  };

  // Periodic stats line. Useful when tokens trickle in slowly.
  const statsTimer = setInterval(() => {
    if (stop) return;
    const elapsedSec = (Date.now() - sessionStart) / 1000;
    const rate =
      elapsedSec > 0 ? (totalMints / elapsedSec) * 60 : 0;
    ui.info(
      `  ${tag}stats: mints=${totalMints} errors=${totalErrors} rate=${rate.toFixed(2)} mints/min hashes=${ui.fmtNum(Number(totalHashes))} bal=${displayBalance} uptime=${ui.fmtElapsed(Date.now() - sessionStart)}`,
    );
  }, statsMs);

  // Spawn workers in parallel, but stagger startup to avoid hammering
  // /challenge with N concurrent requests from cold (rpow2 API rate-limits
  // burst /challenge calls, returning 500/504). Default 750ms between
  // starts; override with --stagger-ms=N or set 0 to disable.
  const staggerMs = Math.max(
    0,
    args.flags['stagger-ms'] === undefined
      ? 750
      : Number(args.flags['stagger-ms']) || 0,
  );
  const promises = [];
  for (let i = 1; i <= numWorkers; i++) {
    if (i > 1 && staggerMs > 0) await sleep(staggerMs);
    if (stop) break;
    promises.push(runOne(i));
  }
  await Promise.all(promises);

  clearInterval(statsTimer);
  process.off('SIGINT', onSig);
  process.off('SIGTERM', onSig);

  const elapsedSec = (Date.now() - sessionStart) / 1000;
  const rate = elapsedSec > 0 ? (totalMints / elapsedSec) * 60 : 0;
  ui.info(
    `done. mined ${totalMints} token(s) in ${ui.fmtElapsed(Date.now() - sessionStart)} (${rate.toFixed(2)} mints/min, ${totalErrors} errors).`,
  );
}

// Spawn a child `node rpow.js mine --profile=NAME` per profile, prefixing
// each line of stdout with the profile name. Restarts a child if it exits
// (unless we're stopping). Default profile list = every profile present in
// session.list(); override with `--profiles=a,b,c`.
async function cmdMineAll(args) {
  const { spawn } = require('child_process');
  let names;
  if (args.flags.profiles) {
    names = String(args.flags.profiles)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    names = session
      .list()
      .map((p) => p.name)
      .filter((n) => n !== 'default');
    if (names.length === 0) {
      const def = session.load();
      if (Object.keys(def.cookies).length > 0) names = ['default'];
    }
  }
  if (names.length === 0) {
    ui.err('no profiles to mine. login first: node rpow.js login your@email.com --profile=NAME');
    process.exit(2);
  }

  // Pick a sensible per-child worker count: split CPUs across children,
  // leaving 1 core free for the orchestrator + network.
  const cpus =
    (require('os').availableParallelism &&
      require('os').availableParallelism()) ||
    require('os').cpus().length ||
    2;
  const totalWorkers = Math.max(1, cpus - 1);
  const perChild = Math.max(
    1,
    Number(args.flags.workers) || Math.floor(totalWorkers / names.length),
  );

  ui.info(
    `mine-all profiles=${names.join(',')} workers/child=${perChild} (cpu=${cpus})`,
  );

  let stopping = false;
  const children = new Map();

  const colors = ['36', '33', '32', '35', '34', '31'];
  const tagFor = (name, idx) => {
    const c = colors[idx % colors.length];
    const lbl = name.padEnd(10).slice(0, 10);
    return process.stdout.isTTY ? `\x1b[${c}m[${lbl}]\x1b[0m` : `[${lbl}]`;
  };

  const spawnOne = (name, idx) => {
    const argv = [
      __filename,
      'mine',
      `--profile=${name}`,
      `--workers=${perChild}`,
    ];
    if (args.flags.max) argv.push(`--max=${args.flags.max}`);
    if (args.flags.backend) argv.push(`--backend=${args.flags.backend}`);
    if (args.flags.inflight) argv.push(`--inflight=${args.flags.inflight}`);
    if (args.flags['mint-retries'])
      argv.push(`--mint-retries=${args.flags['mint-retries']}`);
    if (args.flags['no-pipeline']) argv.push('--no-pipeline');
    if (args.flags['refresh-ms'])
      argv.push(`--refresh-ms=${args.flags['refresh-ms']}`);
    const child = spawn(process.execPath, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    children.set(name, child);
    const tag = tagFor(name, idx);

    const linePrefix = (chunk) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const line of lines) {
        if (line) process.stdout.write(`${tag} ${line}\n`);
      }
    };
    child.stdout.on('data', linePrefix);
    child.stderr.on('data', linePrefix);

    child.on('exit', (code, sig) => {
      children.delete(name);
      const why = sig ? `signal ${sig}` : `code ${code}`;
      if (stopping) {
        process.stdout.write(`${tag} child stopped (${why})\n`);
        maybeFinish();
        return;
      }
      // When --max is set on the orchestrator we forward it to every child
      // and treat a clean exit as "done". Without --max, a clean exit is
      // unexpected (no upper bound, miner shouldn't stop) so we respawn.
      if (args.flags.max && code === 0) {
        process.stdout.write(
          `${tag} child finished (--max=${args.flags.max} reached); not respawning\n`,
        );
        finishedNames.add(name);
        maybeFinish();
        return;
      }
      process.stdout.write(`${tag} child exited (${why}); respawning in 5s\n`);
      setTimeout(() => {
        if (!stopping) spawnOne(name, idx);
      }, 5000);
    });
  };

  const finishedNames = new Set();
  const maybeFinish = () => {
    if (finishedNames.size >= names.length && children.size === 0) {
      ui.info(
        `mine-all done: ${finishedNames.size}/${names.length} profile(s) finished.`,
      );
      process.exit(0);
    }
  };

  names.forEach((n, i) => spawnOne(n, i));

  const onSig = () => {
    if (stopping) {
      ui.warn('force exit.');
      process.exit(130);
    }
    stopping = true;
    ui.info(`stopping ${children.size} child(ren) ...`);
    for (const c of children.values()) {
      try {
        c.kill('SIGINT');
      } catch {
        /* ignore */
      }
    }
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  // Block forever (or until all children exit and we're stopping).
  await new Promise(() => {});
}

// ---------- Telegram bot ----------

async function cmdBot(args) {
  const bot = require('./lib/bot');
  await bot.run(args);
}

// Look up the first present numeric value at any of the dotted paths.
// Used to extract balance/minted counters from /mint responses without
// caring about the exact server schema.
function pickNumber(obj, paths) {
  if (!obj) return undefined;
  for (const p of paths) {
    let cur = obj;
    let ok = true;
    for (const seg of p.split('.')) {
      if (cur && typeof cur === 'object' && seg in cur) {
        cur = cur[seg];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && typeof cur === 'number' && Number.isFinite(cur)) return cur;
  }
  return undefined;
}

function shorten(s) {
  s = String(s);
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function help() {
  console.log(`
rpow2 CLI miner – usage:

  Single account (legacy):
    node rpow.js                       login (if needed) and mine continuously
    node rpow.js login [email]         request magic link and verify
    node rpow.js status                show account + public ledger
    node rpow.js activity              show recent transfers
    node rpow.js mine [--workers=N]    mine continuously (default workers = CPU-1)
                    [--max=N]          stop after N tokens
                    [--backend=native|node|gpu]  pick miner backend
                                       (gpu requires gpu-miner/rpow-miner-gpu.exe;
                                        build via gpu-miner/build.ps1)
    node rpow.js mine-workers          mine with N parallel challenge->solve->mint
                    [--workers=N]      chains (default = CPU count). Each worker
                    [--solve-workers=K]   has its own /challenge + /mint round-trip
                    [--backend=...]    so the API mint pipeline isn't bottlenecked
                    [--max=N]          by a single fetch loop. GPU is mutex-shared.
    node rpow.js logout                clear local session

  Multi-account (each profile = its own session file in ./profiles/NAME.json):
    node rpow.js login EMAIL --profile=NAME       login a profile
    node rpow.js status      --profile=NAME       status for one profile
    node rpow.js status-all                       status for every profile
    node rpow.js profiles                         list all profiles
    node rpow.js mine        --profile=NAME       mine one profile
    node rpow.js mine-all [--profiles=a,b,c]      mine every profile in parallel
                          [--workers=N]            workers per child
    node rpow.js logout      --profile=NAME       remove a profile

  Telegram bot (status / monitoring):
    node rpow.js bot                              run the Telegram bot
                                                  (reads ./bot.json or
                                                   TELEGRAM_BOT_TOKEN env)

  node rpow.js help                  this message

Environment:
  RPOW_API_BASE              override API base (default ${API_BASE})
  RPOW_SESSION_FILE          override default session file
  RPOW_BACKEND=native|node|gpu   force miner backend
  RPOW_MINER_GPU_BIN         override path to the GPU miner binary
  TELEGRAM_BOT_TOKEN         token for the bot command
  TELEGRAM_ALLOWED_CHATS     comma-separated chat IDs allowed to query the bot
`);
}

// ---------- entry ----------

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = (args._.shift() || 'run').toLowerCase();

  try {
    switch (cmd) {
      case 'login':
        await cmdLogin(args);
        break;
      case 'logout':
        await cmdLogout(args);
        break;
      case 'status':
      case 'me':
        await cmdStatus(args);
        break;
      case 'status-all':
        await cmdStatusAll();
        break;
      case 'profiles':
        await cmdProfiles();
        break;
      case 'activity':
        await cmdActivity(args);
        break;
      case 'mine':
        await cmdMine(args);
        break;
      case 'mine-workers':
        await cmdMineWorkers(args);
        break;
      case 'mine-all':
        await cmdMineAll(args);
        break;
      case 'bot':
        await cmdBot(args);
        break;
      case 'help':
      case '--help':
      case '-h':
        help();
        break;
      case 'run':
      case 'start':
        await cmdRun(args);
        break;
      default:
        ui.err(`unknown command: ${cmd}`);
        help();
        process.exit(2);
    }
  } catch (e) {
    ui.err(describeError(e));
    if (process.env.DEBUG) console.error(e);
    process.exit(1);
  }
}

main();
