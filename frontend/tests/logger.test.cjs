// Smoke + rotation tests for the file logger. Uses an isolated temp dir
// instead of ~/Library/Logs/VibeSync so the test never touches user state.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Fresh require per test: logger.cjs caches the resolved log dir at module
// scope. We swap HOME *before* requiring it.
function loadLoggerInTempHome() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vibesync-log-'));
  const oldHome = process.env.HOME;
  const oldQuiet = process.env.VIBESYNC_LOG_QUIET;
  process.env.HOME = tmpHome;
  process.env.VIBESYNC_LOG_QUIET = '1';
  // Drop cached module so the LOG_DIR const re-resolves with the new HOME.
  delete require.cache[require.resolve('../logger.cjs')];
  const logger = require('../logger.cjs');
  return {
    tmpHome,
    logger,
    cleanup: () => {
      process.env.HOME = oldHome;
      if (oldQuiet === undefined) delete process.env.VIBESYNC_LOG_QUIET;
      else process.env.VIBESYNC_LOG_QUIET = oldQuiet;
      delete require.cache[require.resolve('../logger.cjs')];
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    },
  };
}

test('logger writes lines to vibesync.log under Library/Logs/VibeSync', () => {
  const { tmpHome, logger, cleanup } = loadLoggerInTempHome();
  try {
    logger.main.info('hello world', { detail: 42 });
    logger.hotkey.warn('something off');

    const logPath = path.join(tmpHome, 'Library', 'Logs', 'VibeSync', 'vibesync.log');
    assert.equal(fs.existsSync(logPath), true);

    const contents = fs.readFileSync(logPath, 'utf8');
    assert.match(contents, /\[INFO\] \[main\] hello world/);
    assert.match(contents, /"detail":42/);
    assert.match(contents, /\[WARN\] \[hotkey\] something off/);
  } finally {
    cleanup();
  }
});

test('logger rotates when file exceeds MAX_BYTES', () => {
  const { logger, cleanup } = loadLoggerInTempHome();
  try {
    const { LOG_FILE, ROTATED_FILE, MAX_BYTES } = logger._private;
    // Pre-fill with junk past the threshold so the next write triggers rotation.
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.writeFileSync(LOG_FILE, 'x'.repeat(MAX_BYTES + 1024));

    logger.main.info('post-rotation message');

    assert.equal(fs.existsSync(ROTATED_FILE), true);
    const contents = fs.readFileSync(LOG_FILE, 'utf8');
    assert.match(contents, /post-rotation message/);
    // Rotated file holds the old junk, not the new message.
    const rotated = fs.readFileSync(ROTATED_FILE, 'utf8');
    assert.equal(rotated.includes('post-rotation message'), false);
  } finally {
    cleanup();
  }
});

test('logger.error logs Error objects with stack trace', () => {
  const { tmpHome, logger, cleanup } = loadLoggerInTempHome();
  try {
    const err = new Error('synthetic failure');
    logger.main.error('caught:', err);
    const contents = fs.readFileSync(
      path.join(tmpHome, 'Library', 'Logs', 'VibeSync', 'vibesync.log'),
      'utf8'
    );
    assert.match(contents, /caught:/);
    assert.match(contents, /Error: synthetic failure/);
  } finally {
    cleanup();
  }
});
