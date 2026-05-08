'use strict';

const RULE = '+----------------------------------------------------------------------+';

function box(title, body) {
  const t = title ? ` ${title} ` : '';
  const dash = Math.max(2, 70 - t.length);
  const top = `+--${t}${'-'.repeat(dash)}+`;
  const lines = String(body).split('\n');
  return [top, ...lines.map((l) => '  ' + l), RULE].join('\n');
}

function fmtNum(n) {
  return Number(n).toLocaleString('en-US');
}

function fmtRate(hashesPerSec) {
  if (!isFinite(hashesPerSec) || hashesPerSec <= 0) return '0 H/s';
  const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s'];
  let i = 0;
  let v = hashesPerSec;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function ts() {
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function info(...args) {
  console.log(`[${ts()}]`, ...args);
}
function warn(...args) {
  console.warn(`[${ts()}] !`, ...args);
}
function err(...args) {
  console.error(`[${ts()}] x`, ...args);
}

function clearLine() {
  if (process.stdout.isTTY) {
    process.stdout.write('\r\x1b[2K');
  }
}

function statusLine(text) {
  if (process.stdout.isTTY) {
    process.stdout.write(`\r\x1b[2K${text}`);
  } else {
    // non-TTY: occasional newline
  }
}

module.exports = {
  RULE,
  box,
  fmtNum,
  fmtRate,
  fmtElapsed,
  ts,
  info,
  warn,
  err,
  clearLine,
  statusLine,
};
