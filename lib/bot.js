'use strict';

// Minimal Telegram bot for status reporting.
//
// Usage:
//   TELEGRAM_BOT_TOKEN=... node rpow.js bot
//   # or put the token in ./bot.json (gitignored): { "telegram_token": "...", "allowed_chat_ids": [123456789] }
//
// Commands the bot understands:
//   /start, /help        — list commands
//   /status              — total balance across all profiles + per-profile breakdown
//   /profiles            — list all known profiles
//   /me                  — same as /status but per the chat user
//   /ledger              — public ledger snapshot (difficulty, total minted, etc.)
//
// Polling-based (no webhook needed). Restarts on transient errors.

const fs = require('fs');
const path = require('path');
const session = require('./session');
const { api, ApiError } = require('./api');

const TELEGRAM_API = 'https://api.telegram.org';
const CONFIG_FILE = path.join(process.cwd(), 'bot.json');

function loadConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      // Strip UTF-8 BOM that Windows editors / Out-File love to add.
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
      cfg = JSON.parse(raw);
    } catch (e) {
      throw new Error(`failed to parse ${CONFIG_FILE}: ${e.message}`);
    }
  }
  if (process.env.TELEGRAM_BOT_TOKEN) {
    cfg.telegram_token = process.env.TELEGRAM_BOT_TOKEN;
  }
  if (process.env.TELEGRAM_ALLOWED_CHATS) {
    cfg.allowed_chat_ids = process.env.TELEGRAM_ALLOWED_CHATS
      .split(',')
      .map((s) => Number(s.trim()))
      .filter(Number.isFinite);
  }
  if (!cfg.telegram_token) {
    throw new Error(
      'no telegram token. set TELEGRAM_BOT_TOKEN or write { "telegram_token": "..." } to ./bot.json',
    );
  }
  return cfg;
}

async function tgCall(token, method, params = {}) {
  const url = `${TELEGRAM_API}/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => null);
  if (!data || !data.ok) {
    const desc = (data && data.description) || res.statusText || 'unknown';
    throw new Error(`telegram ${method} failed: ${desc}`);
  }
  return data.result;
}

function fmtNum(n) {
  if (typeof n !== 'number') return String(n);
  return n.toLocaleString('en-US');
}

async function buildStatusMessage() {
  const profiles = session.list();
  if (profiles.length === 0) {
    return 'No profiles configured yet.\nLogin with: `node rpow.js login your@email.com --profile=NAME`';
  }

  const rows = [];
  let totalBalance = 0;
  let totalMinted = 0;

  // Fetch all /me concurrently for speed. Retry transient network failures
  // a few times so a momentary "fetch failed" from the VPS to api.rpow2.com
  // doesn't show up as an error in the Telegram reply.
  const tasks = profiles.map(async (p) => {
    const profileArg = p.name === 'default' ? null : p.name;
    const state = session.load(profileArg);
    if (Object.keys(state.cookies).length === 0) {
      return { name: p.name, missing: true };
    }
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const me = await api.me(state);
        return { name: p.name, me };
      } catch (e) {
        lastErr = e;
        // Don't retry on auth/permanent errors.
        if (
          e instanceof ApiError &&
          (e.status === 401 || e.status === 403 || e.code === 'UNAUTHORIZED')
        ) {
          break;
        }
        // Linear backoff: 0.5s, 1s, 1.5s.
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    return { name: p.name, error: lastErr };
  });

  const results = await Promise.all(tasks);
  for (const r of results) {
    if (r.missing) {
      rows.push(`• \`${r.name}\` — _no session_`);
    } else if (r.error) {
      const msg =
        r.error instanceof ApiError ? r.error.code : r.error.message;
      rows.push(`• \`${r.name}\` — ⚠️ ${msg}`);
    } else {
      const m = r.me;
      totalBalance += Number(m.balance) || 0;
      totalMinted += Number(m.minted) || 0;
      rows.push(
        `• \`${r.name}\` (${m.email})\n   bal: *${fmtNum(m.balance)}*  · minted: ${fmtNum(m.minted)}  · sent: ${fmtNum(m.sent)}  · received: ${fmtNum(m.received)}`,
      );
    }
  }
  rows.push('');
  rows.push(
    `*TOTAL* — bal: *${fmtNum(totalBalance)}*  · minted: ${fmtNum(totalMinted)}`,
  );
  return rows.join('\n');
}

async function buildLedgerMessage() {
  // Use any logged-in profile to fetch /ledger.
  const profiles = session.list();
  for (const p of profiles) {
    const profileArg = p.name === 'default' ? null : p.name;
    const state = session.load(profileArg);
    if (Object.keys(state.cookies).length === 0) continue;
    try {
      const l = await api.ledger(state);
      const left =
        typeof l.coins_until_next_milestone === 'number'
          ? `\n   Until next epoch: ${fmtNum(l.coins_until_next_milestone)}`
          : '';
      return [
        `📊 *Public Ledger*`,
        `Total minted     : ${fmtNum(l.total_minted)}`,
        `Total transferred: ${fmtNum(l.total_transferred)}`,
        `Circulating      : ${fmtNum(l.circulating_supply)}`,
        `Difficulty       : *${l.current_difficulty} bits*`,
        `Users            : ${fmtNum(l.user_count)}${left}`,
      ].join('\n');
    } catch {
      continue;
    }
  }
  return 'No working session to fetch the ledger from.';
}

const HELP =
  'Commands:\n' +
  '/status — balance across all profiles\n' +
  '/profiles — list configured profiles\n' +
  '/ledger — public ledger snapshot\n' +
  '/help — this message';

async function handleUpdate(token, allow, update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  if (Array.isArray(allow) && allow.length > 0 && !allow.includes(chatId)) {
    await tgCall(token, 'sendMessage', {
      chat_id: chatId,
      text: `Sorry, this bot is private.\n(your chat id: ${chatId})`,
    }).catch(() => {});
    return;
  }

  const text = msg.text.trim();
  const cmd = text.split(/\s+/)[0].split('@')[0].toLowerCase();

  let reply;
  try {
    switch (cmd) {
      case '/start':
      case '/help':
        reply = HELP;
        break;
      case '/status':
      case '/me':
      case '/balance':
        reply = await buildStatusMessage();
        break;
      case '/profiles':
        reply = session
          .list()
          .map((p) => `• \`${p.name}\` — ${p.file}`)
          .join('\n') || '(no profiles)';
        break;
      case '/ledger':
        reply = await buildLedgerMessage();
        break;
      case '/whoami':
        reply = `chat id: \`${chatId}\``;
        break;
      default:
        if (text.startsWith('/')) reply = `Unknown command. ${HELP}`;
        return;
    }
  } catch (e) {
    reply = `Error: ${e.message}`;
  }

  if (!reply) return;
  await tgCall(token, 'sendMessage', {
    chat_id: chatId,
    text: reply,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  }).catch((e) => {
    // fallback: try plain text if Markdown parse failed
    return tgCall(token, 'sendMessage', { chat_id: chatId, text: reply }).catch(() => {});
  });
}

async function run(args) {
  const cfg = loadConfig();
  const token = cfg.telegram_token;
  const allow = cfg.allowed_chat_ids || [];

  // Verify token + show identity.
  const meBot = await tgCall(token, 'getMe').catch((e) => {
    throw new Error(`telegram auth failed: ${e.message}`);
  });
  console.log(
    `[bot] connected as @${meBot.username} (id ${meBot.id})${allow.length ? ` allow=${allow.join(',')}` : ' allow=any'}`,
  );

  // Drop any backlog so we don't re-handle stale commands.
  let offset = 0;
  try {
    const initial = await tgCall(token, 'getUpdates', { timeout: 0 });
    if (initial.length > 0) offset = initial[initial.length - 1].update_id + 1;
  } catch {
    /* ignore */
  }

  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
    console.log('[bot] stopping ...');
    setTimeout(() => process.exit(0), 1000).unref();
  });
  process.on('SIGTERM', () => {
    stop = true;
    setTimeout(() => process.exit(0), 1000).unref();
  });

  // Optional: announce on start.
  if (allow.length > 0 && args && !args.flags['no-announce']) {
    for (const chat of allow) {
      tgCall(token, 'sendMessage', {
        chat_id: chat,
        text: `🟢 rpow2 bot online on \`${require('os').hostname()}\`.\nSend /status for balances.`,
        parse_mode: 'Markdown',
      }).catch(() => {});
    }
  }

  while (!stop) {
    let updates;
    try {
      updates = await tgCall(token, 'getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message', 'edited_message'],
      });
    } catch (e) {
      console.error(`[bot] poll failed: ${e.message}; retrying in 5s`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      handleUpdate(token, allow, u).catch((e) =>
        console.error(`[bot] handler error: ${e.message}`),
      );
    }
  }
}

module.exports = { run };
