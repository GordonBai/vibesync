#!/usr/bin/env node

const { execFileSync } = require('child_process');
const { getFocusedTerminalContext } = require('./terminal-context.cjs');
const { syncFocusedTerminalContextToClipboard } = require('./hotkey-sync.cjs');

const args = new Set(process.argv.slice(2));
const writeClipboard = args.has('--copy');
const backendUrl = process.env.VIBESYNC_BACKEND_URL || 'http://localhost:8765';

function pbcopy(text) {
  execFileSync('pbcopy', [], { input: text });
}

async function main() {
  const events = [];
  const result = await syncFocusedTerminalContextToClipboard({
    backendUrl,
    getFocusedTerminalContext,
    fetchImpl: fetch,
    writeClipboard: (text) => {
      events.push({
        type: writeClipboard ? 'clipboard-write' : 'clipboard-dry-run',
        chars: text.length,
      });
      if (writeClipboard) {
        pbcopy(text);
      }
    },
    notify: (options) => {
      events.push({ type: 'notification', ...options });
    },
    showTrayFeedback: (icon, tooltip) => {
      events.push({ type: 'tray', icon, tooltip });
    },
    showErrorNotification: (message) => {
      events.push({ type: 'error-notification', message });
    },
    logger: {
      error: (...parts) => {
        events.push({ type: 'log-error', message: parts.map(String).join(' ') });
      },
    },
  });

  const context = await getFocusedTerminalContext();
  process.stdout.write(JSON.stringify({
    mode: writeClipboard ? 'copy' : 'dry-run',
    backendUrl,
    context,
    result,
    events,
  }, null, 2));
  process.stdout.write('\n');
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message || err}\n`);
  process.exit(1);
});
