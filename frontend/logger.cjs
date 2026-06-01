// Minimal file logger for VibeSync's Electron main process.
//
// Writes to ~/Library/Logs/VibeSync/vibesync.log (macOS standard) and also
// mirrors to console so dev mode keeps its existing behavior. A single log
// file is rotated by size: when it exceeds MAX_BYTES, it's renamed to
// vibesync.log.1 (replacing any previous .1) and a fresh file is started.
//
// Surfaces backend stdout/stderr by giving callers a separate channel
// (`logBackend`) so they're easier to grep.

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'VibeSync');
const LOG_FILE = path.join(LOG_DIR, 'vibesync.log');
const ROTATED_FILE = path.join(LOG_DIR, 'vibesync.log.1');
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB per rotation

let initFailed = false;

function ensureLogDir() {
  if (initFailed) return false;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    return true;
  } catch (err) {
    initFailed = true;
    console.warn('VibeSync logger: could not create log dir:', err.message);
    return false;
  }
}

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_BYTES) {
      try { fs.unlinkSync(ROTATED_FILE); } catch {}
      try { fs.renameSync(LOG_FILE, ROTATED_FILE); } catch {}
    }
  } catch {
    // file doesn't exist yet — nothing to rotate
  }
}

function appendLine(level, channel, args) {
  if (!ensureLogDir()) return;
  rotateIfNeeded();
  const ts = new Date().toISOString();
  const message = args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    })
    .join(' ');
  const line = `${ts} [${level}] [${channel}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    // Don't crash the app over a logging failure — fall back to console only.
    initFailed = true;
    console.warn('VibeSync logger: write failed:', err.message);
  }
}

function makeChannel(channel) {
  // Opt-out console mirror so test runs (or future headless modes) can
  // silence the duplicate output. The file log is always written.
  const mirror = process.env.VIBESYNC_LOG_QUIET !== '1';
  return {
    info: (...args) => {
      if (mirror) console.log(`[${channel}]`, ...args);
      appendLine('INFO', channel, args);
    },
    warn: (...args) => {
      if (mirror) console.warn(`[${channel}]`, ...args);
      appendLine('WARN', channel, args);
    },
    error: (...args) => {
      if (mirror) console.error(`[${channel}]`, ...args);
      appendLine('ERROR', channel, args);
    },
  };
}

const main = makeChannel('main');
const backend = makeChannel('backend');
const hotkey = makeChannel('hotkey');

module.exports = {
  main,
  backend,
  hotkey,
  getLogFilePath: () => LOG_FILE,
  getLogDir: () => LOG_DIR,
  // Exposed for tests.
  _private: { LOG_FILE, ROTATED_FILE, MAX_BYTES, makeChannel },
};
