'use strict';

const session = require('./session');

const API_BASE = process.env.RPOW_API_BASE || 'https://api.rpow2.com';
const API_HOST = new URL(API_BASE).hostname;
const USER_AGENT =
  process.env.RPOW_USER_AGENT ||
  'rpow2-cli/1.0 (+https://github.com/local/rpow2-cli)';

class ApiError extends Error {
  constructor(code, message, status) {
    super(message || code || 'API error');
    this.name = 'ApiError';
    this.code = code || 'INTERNAL';
    this.status = status || 0;
  }
}

function cookieHeader(cookies) {
  const entries = Object.entries(cookies || {});
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}=${v}`).join('; ');
}

function parseSetCookie(line) {
  const semi = line.indexOf(';');
  const head = (semi === -1 ? line : line.slice(0, semi)).trim();
  const eq = head.indexOf('=');
  if (eq === -1) return null;
  const name = head.slice(0, eq).trim();
  const value = head.slice(eq + 1).trim();
  if (!name) return null;
  // crude expiry detection: "Max-Age=0" or expired Expires => clear
  const lower = line.toLowerCase();
  const cleared =
    /max-age=0(?![0-9])/i.test(lower) || value === '' || value === 'deleted';
  return { name, value, cleared };
}

function ingestSetCookie(state, headers) {
  const list =
    typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  if (!list || list.length === 0) return false;
  let changed = false;
  state.cookies = state.cookies || {};
  for (const line of list) {
    const parsed = parseSetCookie(line);
    if (!parsed) continue;
    if (parsed.cleared) {
      if (parsed.name in state.cookies) {
        delete state.cookies[parsed.name];
        changed = true;
      }
    } else if (state.cookies[parsed.name] !== parsed.value) {
      state.cookies[parsed.name] = parsed.value;
      changed = true;
    }
  }
  return changed;
}

async function call(method, pathname, body, state) {
  const url = `${API_BASE}${pathname}`;
  const headers = {
    accept: 'application/json',
    'user-agent': USER_AGENT,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const ck = cookieHeader(state.cookies);
  if (ck) headers.cookie = ck;

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (ingestSetCookie(state, res.headers)) {
    session.save(state);
  }

  if (!res.ok) {
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      /* ignore */
    }
    const code = (payload && payload.error) || `HTTP_${res.status}`;
    const message = (payload && payload.message) || res.statusText || code;
    throw new ApiError(code, message, res.status);
  }

  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

// Follow a magic-link URL and capture session cookie(s).
// The link may go directly to the API (sets cookie + redirects) or to the
// SPA with a token in the query/hash – in that case we forward the token to
// the API ourselves.
async function followMagicLink(rawUrl, state) {
  let current = String(rawUrl).trim();
  // strip surrounding quotes/whitespace
  current = current.replace(/^['"<\s]+|['">\s]+$/g, '');

  let hops = 0;
  while (hops < 10) {
    hops++;
    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      throw new ApiError('BAD_REQUEST', `not a valid URL: ${current}`);
    }

    // SPA URL? extract token from query or from hash like "#/auth?token=..."
    if (parsed.hostname !== API_HOST) {
      const tokens = new Map();
      for (const [k, v] of parsed.searchParams) tokens.set(k, v);
      if (parsed.hash) {
        const q = parsed.hash.indexOf('?');
        if (q !== -1) {
          for (const [k, v] of new URLSearchParams(parsed.hash.slice(q + 1))) {
            tokens.set(k, v);
          }
        }
      }
      const token =
        tokens.get('token') ||
        tokens.get('t') ||
        tokens.get('code') ||
        tokens.get('magic') ||
        tokens.get('magic_link');
      if (!token) {
        throw new ApiError(
          'BAD_REQUEST',
          `magic link does not target ${API_HOST} and no token query param was found`,
        );
      }
      current = `${API_BASE}/auth/verify?token=${encodeURIComponent(token)}`;
      continue;
    }

    const headers = {
      accept: 'text/html,application/json',
      'user-agent': USER_AGENT,
    };
    const ck = cookieHeader(state.cookies);
    if (ck) headers.cookie = ck;

    const res = await fetch(current, {
      method: 'GET',
      headers,
      redirect: 'manual',
    });

    if (ingestSetCookie(state, res.headers)) {
      session.save(state);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) break;
      try {
        current = new URL(loc, current).href;
      } catch {
        break;
      }
      // if we got bounced off the API host, we still already captured the
      // cookie above – stop following further redirects.
      if (new URL(current).hostname !== API_HOST) break;
      continue;
    }

    if (!res.ok) {
      let payload = null;
      try {
        payload = await res.json();
      } catch {
        /* ignore */
      }
      const code = (payload && payload.error) || `HTTP_${res.status}`;
      const message =
        (payload && payload.message) || res.statusText || 'magic link rejected';
      throw new ApiError(code, message, res.status);
    }

    // 2xx – done.
    break;
  }
}

const api = {
  authRequest: (email, state) => call('POST', '/auth/request', { email }, state),
  me: (state) => call('GET', '/me', undefined, state),
  logout: (state) => call('POST', '/auth/logout', undefined, state),
  challenge: (state) => call('POST', '/challenge', undefined, state),
  mint: (payload, state) => call('POST', '/mint', payload, state),
  activity: (state) => call('GET', '/activity', undefined, state),
  ledger: (state) => call('GET', '/ledger', undefined, state),
  followMagicLink,
};

module.exports = { api, ApiError, API_BASE, API_HOST };
