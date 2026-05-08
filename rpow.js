#!/usr/bin/env node
'use strict';

const readline = require('readline');
const session = require('./lib/session');
const { api, ApiError, API_BASE } = require('./lib/api');
const ui = require('./lib/ui');
const { solveChallenge, defaultWorkers } = require('./lib/miner');

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

async function getMe(state) {
  try {
    return await api.me(state);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.code === 'UNAUTHORIZED')) {
      return null;
    }
    throw e;
  }
}

function printBanner() {
  console.log('+======================================================================+');
  console.log('|                   RPOW2 - Reusable Proofs of Work                    |');
  console.log('|                          headless CLI miner                          |');
  console.log('+======================================================================+');
}

// ---------- commands ----------

async function cmdLogin(args) {
  const state = session.load();
  let email = args._[0] || args.flags.email;

  // already logged in?
  if (Object.keys(state.cookies).length > 0) {
    const me = await getMe(state).catch(() => null);
    if (me && me.email) {
      ui.info(`already logged in as ${me.email}`);
      ui.info(`session file: ${session.file()}`);
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

async function cmdLogout() {
  const state = session.load();
  if (Object.keys(state.cookies).length === 0) {
    ui.info('no active session.');
    return;
  }
  try {
    await api.logout(state);
  } catch (e) {
    ui.warn(`server logout failed: ${describeError(e)}`);
  }
  session.clear();
  ui.info('local session cleared.');
}

async function cmdStatus() {
  const state = session.load();
  if (Object.keys(state.cookies).length === 0) {
    ui.info('not logged in. run: node rpow.js login');
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

async function cmdActivity() {
  const state = session.load();
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

function printAccount(me) {
  console.log(
    ui.box(
      'ACCOUNT',
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

async function ensureLoggedIn() {
  const state = session.load();
  if (Object.keys(state.cookies).length === 0) {
    ui.info('no session – starting login flow.');
    await cmdLogin({ _: [], flags: {} });
    return session.load();
  }
  const me = await getMe(state);
  if (!me) {
    ui.warn('session expired – starting login flow.');
    session.clear();
    await cmdLogin({ _: [], flags: {} });
    return session.load();
  }
  return state;
}

async function cmdMine(args) {
  const state = await ensureLoggedIn();
  const me = await api.me(state);
  printAccount(me);

  const workers = Math.max(1, Number(args.flags.workers) || defaultWorkers());
  const maxTokens = args.flags.max ? Number(args.flags.max) : Infinity;

  ui.info(`mining with ${workers} worker thread(s). press Ctrl+C to stop.`);

  let stop = false;
  const onSig = () => {
    if (stop) {
      ui.warn('force exit.');
      process.exit(130);
    }
    stop = true;
    ui.info('stopping after current attempt ...');
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  let mined = 0;
  let totalHashes = 0n;
  const sessionStart = Date.now();

  while (!stop && mined < maxTokens) {
    let challenge;
    try {
      challenge = await api.challenge(state);
    } catch (e) {
      if (
        e instanceof ApiError &&
        (e.status === 401 || e.code === 'UNAUTHORIZED')
      ) {
        ui.warn('session expired mid-mining; re-login required.');
        session.clear();
        break;
      }
      ui.err(`challenge failed: ${describeError(e)}`);
      await sleep(3000);
      continue;
    }

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

    let mintRes;
    try {
      mintRes = await api.mint(
        {
          challenge_id: challenge.challenge_id,
          solution_nonce: found.solution_nonce,
        },
        state,
      );
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STALE_CHALLENGE') {
        ui.warn('challenge expired before submission, retrying ...');
        continue;
      }
      ui.err(`mint failed: ${describeError(e)}`);
      await sleep(2000);
      continue;
    }

    mined += 1;
    totalHashes += found.hashes;
    const tokenId = mintRes && mintRes.token && mintRes.token.id;
    ui.info(
      `+ minted ${tokenId ? `token ${shorten(tokenId)} ` : ''}(this run: ${mined}, total hashes: ${ui.fmtNum(Number(totalHashes))}, uptime: ${ui.fmtElapsed(Date.now() - sessionStart)})`,
    );

    try {
      const fresh = await api.me(state);
      ui.info(
        `  balance=${fresh.balance} minted=${fresh.minted} sent=${fresh.sent} received=${fresh.received}`,
      );
    } catch {
      /* non-fatal */
    }
  }

  process.off('SIGINT', onSig);
  process.off('SIGTERM', onSig);
  ui.info(`done. mined ${mined} token(s) in ${ui.fmtElapsed(Date.now() - sessionStart)}.`);
}

async function cmdRun(args) {
  // default flow: login if needed, then mine forever.
  printBanner();
  await cmdMine(args);
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

  node rpow.js                       login (if needed) and mine continuously
  node rpow.js login [email]         request magic link and verify
  node rpow.js status                show account + public ledger
  node rpow.js activity              show recent transfers
  node rpow.js mine [--workers=N]    mine continuously (default workers = CPU-1)
                  [--max=N]          stop after N tokens
  node rpow.js logout                clear local session
  node rpow.js help                  this message

Environment:
  RPOW_API_BASE       override API base (default ${API_BASE})
  RPOW_SESSION_FILE   override session file path (default ./session.json)
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
        await cmdLogout();
        break;
      case 'status':
      case 'me':
        await cmdStatus();
        break;
      case 'activity':
        await cmdActivity();
        break;
      case 'mine':
        await cmdMine(args);
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
