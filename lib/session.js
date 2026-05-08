'use strict';

// Session/profile storage.
//
// Without a profile name, the session lives at ./session.json (legacy layout
// for single-account use). With --profile=NAME, it lives at
// ./profiles/NAME.json so multiple accounts can coexist in one repo.
//
// State objects carry their own ._file / ._profile metadata so that
// callers can hand a state around without remembering which profile it
// belongs to.

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const PROFILES_DIR = path.join(ROOT, 'profiles');
const DEFAULT_FILE = path.join(ROOT, 'session.json');

// Resolve absolute path for a profile.
//   pathFor()              -> ./session.json (or $RPOW_SESSION_FILE)
//   pathFor('default')     -> same as no arg
//   pathFor('namc')        -> ./profiles/namc.json
function pathFor(profile) {
  if (!profile || profile === 'default') {
    return process.env.RPOW_SESSION_FILE || DEFAULT_FILE;
  }
  if (!/^[A-Za-z0-9_.\-]+$/.test(profile)) {
    throw new Error(
      `invalid profile name "${profile}" (allowed: letters, digits, _ . -)`,
    );
  }
  return path.join(PROFILES_DIR, `${profile}.json`);
}

function load(profile) {
  const file = pathFor(profile);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return {
      email: data.email || null,
      cookies: data.cookies || {},
      _profile: profile || null,
      _file: file,
    };
  } catch {
    return {
      email: null,
      cookies: {},
      _profile: profile || null,
      _file: file,
    };
  }
}

function save(state) {
  // Defensive: a state object created on the fly (without going through
  // load(profile)) has neither _file nor _profile set. Auto-save callers
  // in api.js would otherwise silently write its cookies to ./session.json,
  // creating a phantom "default" profile. Skip those.
  if (state && !state._file && !state._profile) {
    return;
  }
  const file = state._file || pathFor(state._profile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = {
    email: state.email || null,
    cookies: state.cookies || {},
  };
  fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
}

// clear() removes the file. Pass either a state object or a profile name.
// With no args it clears the default session for backward compatibility.
function clear(stateOrProfile) {
  let file;
  if (typeof stateOrProfile === 'string' || stateOrProfile === undefined) {
    file = pathFor(stateOrProfile);
  } else if (stateOrProfile && stateOrProfile._file) {
    file = stateOrProfile._file;
  } else {
    file = pathFor();
  }
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

function file(stateOrProfile) {
  if (typeof stateOrProfile === 'string' || stateOrProfile === undefined) {
    return pathFor(stateOrProfile);
  }
  if (stateOrProfile && stateOrProfile._file) return stateOrProfile._file;
  return pathFor();
}

// Enumerate all known profiles (default + named) that currently have a file.
function list() {
  const out = [];
  const def = pathFor();
  if (fs.existsSync(def)) {
    out.push({ name: 'default', file: def });
  }
  try {
    for (const f of fs.readdirSync(PROFILES_DIR)) {
      if (f.endsWith('.json')) {
        out.push({
          name: f.slice(0, -5),
          file: path.join(PROFILES_DIR, f),
        });
      }
    }
  } catch {
    /* no profiles dir */
  }
  return out;
}

function exists(profile) {
  return fs.existsSync(pathFor(profile));
}

module.exports = { load, save, clear, file, list, exists, pathFor };
