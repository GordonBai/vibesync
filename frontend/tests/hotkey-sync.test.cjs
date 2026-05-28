const assert = require('node:assert/strict');
const { test } = require('node:test');

const { syncFocusedTerminalContextToClipboard } = require('../hotkey-sync.cjs');

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function makeDeps({ context, fetches = [] }) {
  const state = {
    clipboard: [],
    notifications: [],
    tray: [],
    errors: [],
    fetchCalls: [],
  };

  return {
    state,
    deps: {
      backendUrl: 'http://test-backend',
      async getFocusedTerminalContext() {
        return context;
      },
      async fetchImpl(url, options) {
        state.fetchCalls.push({ url, options });
        if (fetches.length === 0) {
          throw new Error(`Unexpected fetch ${url}`);
        }
        return fetches.shift();
      },
      writeClipboard(text) {
        state.clipboard.push(text);
      },
      notify(options) {
        state.notifications.push(options);
      },
      showTrayFeedback(icon, tooltip) {
        state.tray.push({ icon, tooltip });
      },
      showErrorNotification(message) {
        state.errors.push(message);
      },
      logger: { error() {} },
    },
  };
}

test('successful focused terminal sync writes takeover prompt to clipboard', async () => {
  const { deps, state } = makeDeps({
    context: {
      terminalApp: 'Ghostty',
      cwd: '/Users/test/project',
      command: 'claude',
    },
    fetches: [
      response(200, {
        session: {
          agent: 'claude',
          id: 'sid-1',
          project: '/Users/test/project',
        },
      }),
      response(200, {
        metadata: { agent_label: 'Claude Code' },
        takeover_prompt: 'TAKEOVER PROMPT',
      }),
    ],
  });

  const result = await syncFocusedTerminalContextToClipboard(deps);

  assert.equal(result.ok, true);
  assert.deepEqual(state.clipboard, ['TAKEOVER PROMPT']);
  assert.equal(state.fetchCalls.length, 2);
  assert.equal(state.fetchCalls[0].url, 'http://test-backend/api/takeover/resolve');
  assert.equal(JSON.parse(state.fetchCalls[0].options.body).command, 'claude');
  assert.equal(state.fetchCalls[1].url, 'http://test-backend/api/sessions/claude/sid-1');
  assert.equal(state.notifications.at(-1).title, 'VibeSync takeover prompt copied');
});

test('focused host error notifies and does not touch backend or clipboard', async () => {
  const { deps, state } = makeDeps({
    context: {
      error: 'Focused app "Codex" is not a supported terminal host.',
      cwd: null,
      command: null,
    },
  });

  const result = await syncFocusedTerminalContextToClipboard(deps);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'context-error');
  assert.deepEqual(state.clipboard, []);
  assert.deepEqual(state.fetchCalls, []);
  assert.equal(state.notifications[0].title, 'VibeSync');
});

test('missing cwd notifies and does not touch backend or clipboard', async () => {
  const { deps, state } = makeDeps({
    context: {
      terminalApp: 'Ghostty',
      cwd: null,
      command: 'claude',
    },
  });

  const result = await syncFocusedTerminalContextToClipboard(deps);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-cwd');
  assert.deepEqual(state.clipboard, []);
  assert.deepEqual(state.fetchCalls, []);
  assert.match(state.notifications[0].body, /working directory/);
});

test('unsupported command notifies and does not touch backend or clipboard', async () => {
  const { deps, state } = makeDeps({
    context: {
      terminalApp: 'Ghostty',
      cwd: '/Users/test/project',
      command: 'zsh',
    },
  });

  const result = await syncFocusedTerminalContextToClipboard(deps);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported-command');
  assert.deepEqual(state.clipboard, []);
  assert.deepEqual(state.fetchCalls, []);
  assert.equal(state.notifications[0].title, 'No supported coding agent detected');
});

test('backend 404 notifies and does not fetch details or write clipboard', async () => {
  const { deps, state } = makeDeps({
    context: {
      terminalApp: 'Ghostty',
      cwd: '/Users/test/project',
      command: 'codex',
    },
    fetches: [
      response(404, { error: 'no codex sessions matched terminal cwd' }),
    ],
  });

  const result = await syncFocusedTerminalContextToClipboard(deps);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-match');
  assert.deepEqual(state.clipboard, []);
  assert.equal(state.fetchCalls.length, 1);
  assert.equal(state.notifications[0].title, 'No matching session found');
});

test('backend 409 notifies and does not fetch details or write clipboard', async () => {
  const { deps, state } = makeDeps({
    context: {
      terminalApp: 'Ghostty',
      cwd: '/Users/test/project',
      command: 'claude',
    },
    fetches: [
      response(409, { error: 'ambiguous' }),
    ],
  });

  const result = await syncFocusedTerminalContextToClipboard(deps);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'multiple-matches');
  assert.deepEqual(state.clipboard, []);
  assert.equal(state.fetchCalls.length, 1);
  assert.equal(state.notifications[0].title, 'Multiple matching sessions found');
});

test('IDE host with unsupported command shows IDE-specific messages', async () => {
  const { deps, state } = makeDeps({
    context: {
      terminalApp: 'VS Code',
      hostKind: 'ide',
      cwd: '/Users/test/project',
      command: 'zsh',
    },
  });

  const result = await syncFocusedTerminalContextToClipboard(deps);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported-command');
  assert.deepEqual(state.clipboard, []);
  assert.equal(state.notifications[0].title, 'No coding agent detected in IDE');
  assert.match(state.notifications[0].body, /integrated terminal/);
  assert.match(state.tray[0].tooltip, /No coding agent detected in IDE/);
});

test('IDE host with missing cwd shows IDE-specific messages', async () => {
  const { deps, state } = makeDeps({
    context: {
      terminalApp: 'Cursor',
      hostKind: 'ide',
      cwd: null,
      command: 'claude',
    },
  });

  const result = await syncFocusedTerminalContextToClipboard(deps);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-cwd');
  assert.deepEqual(state.clipboard, []);
  assert.match(state.notifications[0].body, /workspace directory/);
  assert.match(state.tray[0].tooltip, /IDE workspace/);
});

test('terminal host with unsupported command still shows terminal-specific messages', async () => {
  const { deps, state } = makeDeps({
    context: {
      terminalApp: 'Ghostty',
      hostKind: 'terminal',
      cwd: '/Users/test/project',
      command: 'zsh',
    },
  });

  const result = await syncFocusedTerminalContextToClipboard(deps);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported-command');
  assert.equal(state.notifications[0].title, 'No supported coding agent detected');
  assert.match(state.notifications[0].body, /in this terminal/);
});
