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

// HTML-escape user-supplied content so emails like `foo_bar@x.com` or
// error messages with `<` / `>` / `&` don't break Telegram's HTML parser.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Current time in Jakarta (WIB), e.g. "16:28".
function nowJakarta() {
  const t = new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${t} WIB`;
}

const DIVIDER = '━━━━━━━━━━━━━━━━━━━';

// Describe a Telegram-friendly error string without leaking stack traces.
function describeProfileError(err) {
  if (err instanceof ApiError) {
    if (err.code === 'UNAUTHORIZED' || err.status === 401 || err.status === 403) {
      return 'session expired — please re-login';
    }
    if (err.code === 'HTTP_500' || err.status === 500) {
      return 'upstream API 500 (try again in a bit)';
    }
    return err.code || err.message || 'unknown API error';
  }
  const m = (err && err.message) || String(err);
  if (m.includes('fetch failed')) {
    return 'network blip to api.rpow2.com (try /status again)';
  }
  return m;
}

// Single /me fetch with retry for transient network errors.
async function fetchMeWithRetry(state, retries = 4) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return { ok: true, me: await api.me(state) };
    } catch (e) {
      lastErr = e;
      if (
        e instanceof ApiError &&
        (e.status === 401 || e.status === 403 || e.code === 'UNAUTHORIZED')
      ) {
        break; // permanent
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return { ok: false, error: lastErr };
}

async function buildStatusMessage() {
  const profiles = session.list();
  if (profiles.length === 0) {
    return (
      '📭 <b>No profiles configured yet</b>\n' +
      '\n' +
      'Login on the server with:\n' +
      '<code>node rpow.js login your@email.com --profile=NAME</code>'
    );
  }

  // Fetch all /me concurrently so the slowest profile bounds the response.
  const results = await Promise.all(
    profiles.map(async (p) => {
      const profileArg = p.name === 'default' ? null : p.name;
      const state = session.load(profileArg);
      if (Object.keys(state.cookies).length === 0) {
        return { name: p.name, missing: true, email: state.email };
      }
      const r = await fetchMeWithRetry(state);
      return r.ok
        ? { name: p.name, me: r.me }
        : { name: p.name, error: r.error, email: state.email };
    }),
  );

  const lines = [];
  lines.push('💰 <b>Portfolio Summary</b>');
  lines.push(`<i>Updated ${nowJakarta()}</i>`);
  lines.push('');

  let totalBalance = 0;
  let totalMinted = 0;
  let ok = 0;
  let warn = 0;

  for (const r of results) {
    if (r.missing) {
      warn += 1;
      lines.push(`👤 <b>${esc(r.name)}</b>`);
      if (r.email) lines.push(`<code>${esc(r.email)}</code>`);
      lines.push('💤 <i>no session — login required</i>');
      lines.push('');
      continue;
    }
    if (r.error) {
      warn += 1;
      lines.push(`👤 <b>${esc(r.name)}</b>`);
      if (r.email) lines.push(`<code>${esc(r.email)}</code>`);
      lines.push(`⚠️ <i>${esc(describeProfileError(r.error))}</i>`);
      lines.push('');
      continue;
    }
    ok += 1;
    const m = r.me;
    const bal = Number(m.balance) || 0;
    const minted = Number(m.minted) || 0;
    const sent = Number(m.sent) || 0;
    const recv = Number(m.received) || 0;
    totalBalance += bal;
    totalMinted += minted;
    lines.push(`👤 <b>${esc(r.name)}</b>`);
    lines.push(`<code>${esc(m.email)}</code>`);
    lines.push(
      `💎 <b>${fmtNum(bal)}</b> RPOW · ⛏️ ${fmtNum(minted)} · 📤 ${fmtNum(sent)} · 📥 ${fmtNum(recv)}`,
    );
    lines.push('');
  }

  lines.push(DIVIDER);
  lines.push(`💼 <b>TOTAL: ${fmtNum(totalBalance)} RPOW</b>`);
  lines.push(`⛏️ Lifetime minted: ${fmtNum(totalMinted)}`);
  if (warn > 0) {
    lines.push('');
    lines.push(
      `<i>${ok} ok, ${warn} with warning. Retry /status in a few seconds if the API is flaky.</i>`,
    );
  }
  return lines.join('\n');
}

async function buildLedgerMessage() {
  const profiles = session.list();
  let lastErr;
  for (const p of profiles) {
    const profileArg = p.name === 'default' ? null : p.name;
    const state = session.load(profileArg);
    if (Object.keys(state.cookies).length === 0) continue;
    try {
      const l = await api.ledger(state);
      const lines = [];
      lines.push(`📊 <b>Public Ledger</b>`);
      lines.push(`<i>${nowJakarta()}</i>`);
      lines.push('');

      // Highlight the headline network state.
      const diff = l.current_difficulty_bits;
      const nextDiff = l.next_difficulty_bits;
      const epoch = l.epoch;
      const minted = Number(l.total_minted) || 0;
      const maxSupply = Number(l.max_supply) || 0;
      const pct = maxSupply ? (minted / maxSupply) * 100 : null;
      if (typeof epoch === 'number' && typeof diff === 'number') {
        const nextPart =
          typeof nextDiff === 'number' && nextDiff !== diff
            ? ` → ${nextDiff} at next epoch`
            : '';
        lines.push(
          `⛏️ Epoch <b>${epoch}</b> · Difficulty <b>${diff} bits</b>${nextPart}`,
        );
      }
      if (pct !== null && maxSupply) {
        lines.push(
          `💎 Minted: <b>${fmtNum(minted)}</b> / ${fmtNum(maxSupply)} (${pct.toFixed(2)}%)`,
        );
      }
      lines.push('');

      // Use a <pre> block so the columns align in any Telegram client.
      const rows = [
        ['Total minted', fmtNum(l.total_minted)],
        ['Total transferred', fmtNum(l.total_transferred)],
        ['Circulating', fmtNum(l.circulating_supply)],
      ];
      if (typeof diff === 'number') {
        rows.push(['Difficulty', `${diff} bits`]);
      }
      if (typeof nextDiff === 'number' && nextDiff !== diff) {
        rows.push(['Next difficulty', `${nextDiff} bits`]);
      }
      rows.push(['Users', fmtNum(l.user_count)]);
      if (typeof l.coins_until_next_milestone === 'number') {
        rows.push([
          'Until next epoch',
          fmtNum(l.coins_until_next_milestone),
        ]);
      }
      if (typeof l.next_milestone_at === 'number') {
        rows.push(['Next milestone at', fmtNum(l.next_milestone_at)]);
      }
      if (typeof l.max_supply === 'number') {
        rows.push(['Max supply', fmtNum(l.max_supply)]);
      }
      if (l.is_capped) {
        rows.push(['Capped', 'yes ⛔']);
      }
      const keyWidth = Math.max(...rows.map((r) => r[0].length));
      const pre = rows
        .map(([k, v]) => `${k.padEnd(keyWidth)} : ${v}`)
        .join('\n');
      lines.push(`<pre>${esc(pre)}</pre>`);
      return lines.join('\n');
    } catch (e) {
      lastErr = e;
    }
  }
  return (
    `⚠️ <b>Could not fetch ledger</b>\n` +
    `<i>${esc(lastErr ? describeProfileError(lastErr) : 'no working session available')}</i>`
  );
}

const HELP = [
  '🤖 <b>rpow2 bot</b>',
  '',
  'Tap a button below or type a command:',
  '',
  '/status — 💰 balance across all profiles',
  '/profiles — 📋 list configured profiles',
  '/ledger — 📊 public ledger snapshot',
  '/whoami — 🪪 show your chat id',
  '/help — this message',
].join('\n');

// Persistent reply keyboard shown at the bottom of the chat so the user
// can tap buttons instead of typing slash commands every time.
const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '💰 Status' }, { text: '📊 Ledger' }],
    [{ text: '📋 Profiles' }, { text: '🆘 Help' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

// Map visible button text back to a canonical slash command. This makes
// taps on the keyboard flow through the same switch statement as typed
// commands, so there's exactly one code path for each action.
const BUTTON_TO_CMD = {
  '💰 Status': '/status',
  '📊 Ledger': '/ledger',
  '📋 Profiles': '/profiles',
  '🆘 Help': '/help',
};

// Inline "🔄 Refresh" button attached under /status and /ledger replies so
// the user can tap to re-run the same command without scrolling to the
// bottom keyboard. Uses callback_query → we handle it in handleUpdate.
const refreshKeyboard = (action) => ({
  inline_keyboard: [[{ text: '🔄 Refresh', callback_data: `refresh:${action}` }]],
});

function buildProfilesMessage() {
  const profiles = session.list();
  if (profiles.length === 0) {
    return (
      '📭 <b>No profiles configured</b>\n' +
      '\n' +
      'Login on the server with:\n' +
      '<code>node rpow.js login your@email.com --profile=NAME</code>'
    );
  }
  const lines = [];
  lines.push(`📋 <b>Configured Profiles</b> (${profiles.length})`);
  lines.push('');
  for (const p of profiles) {
    const state = session.load(p.name === 'default' ? null : p.name);
    const loggedIn = Object.keys(state.cookies).length > 0;
    const icon = loggedIn ? '✅' : '💤';
    const emailLine = state.email
      ? `\n   <code>${esc(state.email)}</code>`
      : '';
    lines.push(`${icon} <b>${esc(p.name)}</b>${emailLine}`);
  }
  return lines.join('\n');
}

// Resolve an incoming text (typed command OR reply-keyboard tap) to a
// normalized slash command. Returns null if it isn't recognisable as one.
function normalizeCommand(text) {
  if (!text) return null;
  const t = text.trim();
  if (BUTTON_TO_CMD[t]) return BUTTON_TO_CMD[t];
  if (!t.startsWith('/')) return null;
  return t.split(/\s+/)[0].split('@')[0].toLowerCase();
}

// Build the reply payload for a given command. Centralised so both typed
// commands and inline "🔄 Refresh" callbacks produce identical output.
async function dispatchCommand(cmd, { chatId }) {
  let reply = null;
  let action = null; // for attaching the 🔄 Refresh inline button
  switch (cmd) {
    case '/start':
      reply =
        `👋 <b>Welcome to rpow2 bot</b>\n` +
        `\n` +
        `I report your RPOW mining balances across all configured profiles.\n` +
        `\n` +
        `Tap a button below or use a slash command.\n` +
        `\n` +
        HELP;
      break;
    case '/help':
      reply = HELP;
      break;
    case '/status':
    case '/me':
    case '/balance':
      reply = await buildStatusMessage();
      action = 'status';
      break;
    case '/profiles':
      reply = buildProfilesMessage();
      action = 'profiles';
      break;
    case '/ledger':
      reply = await buildLedgerMessage();
      action = 'ledger';
      break;
    case '/whoami':
      reply = `🪪 <b>Your chat id</b>\n<code>${esc(chatId)}</code>`;
      break;
    default:
      if (cmd && cmd.startsWith('/')) {
        reply = `❓ <i>Unknown command.</i>\n\n${HELP}`;
      }
      break;
  }
  return { reply, action };
}

async function sendReply(token, chatId, reply, action) {
  if (!reply) return;
  const payload = {
    chat_id: chatId,
    text: reply,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  // Status / ledger / profiles get a 🔄 Refresh inline button; everything
  // else just keeps the persistent reply keyboard.
  if (action === 'status' || action === 'ledger' || action === 'profiles') {
    payload.reply_markup = refreshKeyboard(action);
  } else {
    payload.reply_markup = MAIN_KEYBOARD;
  }
  await tgCall(token, 'sendMessage', payload).catch(() => {
    // Fallback: strip HTML tags if Telegram rejects the markup.
    return tgCall(token, 'sendMessage', {
      chat_id: chatId,
      text: reply.replace(/<[^>]+>/g, ''),
      reply_markup: MAIN_KEYBOARD,
    }).catch(() => {});
  });
}

async function handleCallbackQuery(token, allow, cb) {
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  if (!chatId) return;
  if (Array.isArray(allow) && allow.length > 0 && !allow.includes(chatId)) {
    await tgCall(token, 'answerCallbackQuery', {
      callback_query_id: cb.id,
      text: 'Not authorized.',
    }).catch(() => {});
    return;
  }
  // Dismiss the loading spinner on the user's side.
  tgCall(token, 'answerCallbackQuery', { callback_query_id: cb.id }).catch(
    () => {},
  );
  const data = String(cb.data || '');
  if (!data.startsWith('refresh:')) return;
  const action = data.slice('refresh:'.length);
  const cmd = action === 'status' ? '/status'
    : action === 'ledger' ? '/ledger'
    : action === 'profiles' ? '/profiles'
    : null;
  if (!cmd) return;
  try {
    const { reply, action: nextAction } = await dispatchCommand(cmd, { chatId });
    // Edit the original message in place rather than sending a new one, so
    // the chat stays clean when you tap 🔄 repeatedly.
    if (reply) {
      await tgCall(token, 'editMessageText', {
        chat_id: chatId,
        message_id: cb.message.message_id,
        text: reply,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: refreshKeyboard(nextAction || action),
      }).catch(async () => {
        // If edit fails (e.g., identical content), send a fresh reply.
        await sendReply(token, chatId, reply, nextAction || action);
      });
    }
  } catch (e) {
    await tgCall(token, 'sendMessage', {
      chat_id: chatId,
      text: `⚠️ <b>Error</b>\n<i>${esc((e && e.message) || String(e))}</i>`,
      parse_mode: 'HTML',
      reply_markup: MAIN_KEYBOARD,
    }).catch(() => {});
  }
}

async function handleUpdate(token, allow, update) {
  if (update.callback_query) {
    return handleCallbackQuery(token, allow, update.callback_query);
  }

  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  if (Array.isArray(allow) && allow.length > 0 && !allow.includes(chatId)) {
    await tgCall(token, 'sendMessage', {
      chat_id: chatId,
      text:
        `🔒 <b>Private bot</b>\n` +
        `Sorry, you are not authorized.\n` +
        `\n` +
        `Your chat id: <code>${esc(chatId)}</code>`,
      parse_mode: 'HTML',
    }).catch(() => {});
    return;
  }

  const cmd = normalizeCommand(msg.text);
  if (!cmd) return; // not a command and not a button tap; ignore plain text

  let reply;
  let action = null;
  try {
    const out = await dispatchCommand(cmd, { chatId });
    reply = out.reply;
    action = out.action;
  } catch (e) {
    reply =
      `⚠️ <b>Error</b>\n` +
      `<i>${esc((e && e.message) || String(e))}</i>`;
  }
  await sendReply(token, chatId, reply, action);
}

function logLine(kind, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const tag = { info: 'bot', warn: 'bot WARN', err: 'bot ERR ' }[kind] || 'bot';
  const stream = kind === 'err' ? console.error : console.log;
  stream(`[${ts}] [${tag}] ${msg}`);
}

async function run(args) {
  const cfg = loadConfig();
  const token = cfg.telegram_token;
  const allow = cfg.allowed_chat_ids || [];

  // Verify token + show identity.
  const meBot = await tgCall(token, 'getMe').catch((e) => {
    throw new Error(`telegram auth failed: ${e.message}`);
  });
  logLine(
    'info',
    `connected as @${meBot.username} (id ${meBot.id}) allow=${allow.length ? allow.join(',') : 'any'}`,
  );
  logLine('info', `profiles loaded: ${session.list().map((p) => p.name).join(', ') || '(none)'}`);

  // Register commands so Telegram shows them in the "/" autocomplete menu.
  // Also sets the "Menu" button (command list accessible from chat header).
  await tgCall(token, 'setMyCommands', {
    commands: [
      { command: 'status', description: '💰 Balance across all profiles' },
      { command: 'ledger', description: '📊 Public ledger snapshot' },
      { command: 'profiles', description: '📋 List configured profiles' },
      { command: 'help', description: 'Show help' },
      { command: 'whoami', description: 'Show your chat id' },
    ],
  }).catch((e) => logLine('warn', `setMyCommands failed: ${e.message}`));

  // Drop any backlog so we don't re-handle stale commands.
  let offset = 0;
  try {
    const initial = await tgCall(token, 'getUpdates', { timeout: 0 });
    if (initial.length > 0) {
      offset = initial[initial.length - 1].update_id + 1;
      logLine('info', `dropped ${initial.length} backlogged update(s)`);
    }
  } catch {
    /* ignore */
  }

  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
    logLine('info', 'stopping ...');
    setTimeout(() => process.exit(0), 1000).unref();
  });
  process.on('SIGTERM', () => {
    stop = true;
    setTimeout(() => process.exit(0), 1000).unref();
  });

  // Announce online on startup (one notification per allow-listed chat).
  if (allow.length > 0 && args && !args.flags['no-announce']) {
    const host = require('os').hostname();
    const profileCount = session.list().length;
    const text = [
      `🟢 <b>rpow2 bot online</b>`,
      `<i>${nowJakarta()}</i>`,
      ``,
      `🖥️ Host: <code>${esc(host)}</code>`,
      `📋 Profiles: <b>${profileCount}</b>`,
      ``,
      `Send /status for balances.`,
    ].join('\n');
    for (const chat of allow) {
      tgCall(token, 'sendMessage', {
        chat_id: chat,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: MAIN_KEYBOARD,
      }).catch(() => {});
    }
  }

  while (!stop) {
    let updates;
    try {
      updates = await tgCall(token, 'getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message', 'edited_message', 'callback_query'],
      });
    } catch (e) {
      logLine('warn', `poll failed: ${e.message}; retrying in 5s`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const who =
        (u.message && u.message.from && u.message.from.username) ||
        (u.message && u.message.chat && u.message.chat.id) ||
        '?';
      const body =
        (u.message && u.message.text) ||
        (u.edited_message && u.edited_message.text) ||
        '';
      if (body) {
        logLine('info', `cmd from @${who}: ${body.slice(0, 80)}`);
      }
      handleUpdate(token, allow, u).catch((e) =>
        logLine('err', `handler error: ${e.message}`),
      );
    }
  }
}

module.exports = { run };
