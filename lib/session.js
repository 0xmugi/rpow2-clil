'use strict';

const fs = require('fs');
const path = require('path');

const SESSION_FILE =
  process.env.RPOW_SESSION_FILE ||
  path.join(process.cwd(), 'session.json');

function load() {
  try {
    const raw = fs.readFileSync(SESSION_FILE, 'utf8');
    const data = JSON.parse(raw);
    return {
      email: data.email || null,
      cookies: data.cookies || {},
    };
  } catch {
    return { email: null, cookies: {} };
  }
}

function save(session) {
  fs.writeFileSync(
    SESSION_FILE,
    JSON.stringify(session, null, 2),
    { mode: 0o600 }
  );
}

function clear() {
  try {
    fs.unlinkSync(SESSION_FILE);
  } catch {
    /* ignore */
  }
}

function file() {
  return SESSION_FILE;
}

module.exports = { load, save, clear, file };
