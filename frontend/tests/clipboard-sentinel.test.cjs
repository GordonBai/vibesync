// Clipboard sentinel safety: every failure path of the hotkey sync flow MUST
// leave the user's pre-existing clipboard contents intact. We seed the mock
// clipboard with a sentinel value, run the flow, then assert the sentinel
// still reads back unchanged.
//
// This catches regressions where a future code path silently writes a
// fallback or partial result into the system clipboard. Pre-release §3.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { syncFocusedTerminalContextToClipboard } = require('../hotkey-sync.cjs');

const SENTINEL = 'VIBESYNC_SENTINEL_DO_NOT_OVERWRITE';

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

function makeSentinelDeps({ context, fetches = [] }) {
  // Mock clipboard backed by a single string slot, pre-seeded with sentinel.
  let clipboardValue = SENTINEL;
  const writeCalls = [];

  const deps = {
    backendUrl: 'http://test-backend',
    async getFocusedTerminalContext() {
      return context;
    },
    async fetchImpl() {
      if (fetches.length === 0) {
        throw new Error('Unexpected fetch');
      }
      return fetches.shift();
    },
    writeClipboard(text) {
      writeCalls.push(text);
      clipboardValue = text;
    },
    notify() {},
    showTrayFeedback() {},
    showTrayProgress() {},
    showErrorNotification() {},
    logger: { error() {} },
  };

  return {
    deps,
    readClipboard: () => clipboardValue,
    writeCalls,
  };
}

test('sentinel: focused host error leaves clipboard untouched', async () => {
  const { deps, readClipboard, writeCalls } = makeSentinelDeps({
    context: {
      error: 'Focused app "Finder" is not a supported terminal host.',
      cwd: null,
      command: null,
    },
  });

  await syncFocusedTerminalContextToClipboard(deps);

  assert.equal(readClipboard(), SENTINEL);
  assert.deepEqual(writeCalls, []);
});

test('sentinel: missing cwd leaves clipboard untouched', async () => {
  const { deps, readClipboard, writeCalls } = makeSentinelDeps({
    context: {
      terminalApp: 'Ghostty',
      cwd: null,
      command: 'claude',
    },
  });

  await syncFocusedTerminalContextToClipboard(deps);

  assert.equal(readClipboard(), SENTINEL);
  assert.deepEqual(writeCalls, []);
});

test('sentinel: unsupported command leaves clipboard untouched', async () => {
  const { deps, readClipboard, writeCalls } = makeSentinelDeps({
    context: {
      terminalApp: 'Ghostty',
      cwd: '/Users/test/project',
      command: 'zsh',
    },
  });

  await syncFocusedTerminalContextToClipboard(deps);

  assert.equal(readClipboard(), SENTINEL);
  assert.deepEqual(writeCalls, []);
});

test('sentinel: backend 404 no-match leaves clipboard untouched', async () => {
  const { deps, readClipboard, writeCalls } = makeSentinelDeps({
    context: {
      terminalApp: 'Ghostty',
      cwd: '/Users/test/project',
      command: 'codex',
    },
    fetches: [response(404, { error: 'no codex sessions matched' })],
  });

  await syncFocusedTerminalContextToClipboard(deps);

  assert.equal(readClipboard(), SENTINEL);
  assert.deepEqual(writeCalls, []);
});

test('sentinel: backend 409 ambiguous leaves clipboard untouched', async () => {
  const { deps, readClipboard, writeCalls } = makeSentinelDeps({
    context: {
      terminalApp: 'Ghostty',
      cwd: '/Users/test/project',
      command: 'claude',
    },
    fetches: [response(409, { error: 'ambiguous' })],
  });

  await syncFocusedTerminalContextToClipboard(deps);

  assert.equal(readClipboard(), SENTINEL);
  assert.deepEqual(writeCalls, []);
});

test('sentinel: backend 5xx leaves clipboard untouched', async () => {
  const { deps, readClipboard, writeCalls } = makeSentinelDeps({
    context: {
      terminalApp: 'Ghostty',
      cwd: '/Users/test/project',
      command: 'claude',
    },
    fetches: [response(500, { error: 'internal' })],
  });

  await syncFocusedTerminalContextToClipboard(deps);

  assert.equal(readClipboard(), SENTINEL);
  assert.deepEqual(writeCalls, []);
});

test('sentinel: missing takeover_prompt in details leaves clipboard untouched', async () => {
  const { deps, readClipboard, writeCalls } = makeSentinelDeps({
    context: {
      terminalApp: 'Ghostty',
      cwd: '/Users/test/project',
      command: 'claude',
    },
    fetches: [
      response(200, {
        session: { agent: 'claude', id: 'sid-1', project: '/Users/test/project' },
      }),
      response(200, { metadata: {} }), // details has no takeover_prompt
    ],
  });

  await syncFocusedTerminalContextToClipboard(deps);

  assert.equal(readClipboard(), SENTINEL);
  assert.deepEqual(writeCalls, []);
});

test('sentinel: details fetch failure leaves clipboard untouched', async () => {
  const { deps, readClipboard, writeCalls } = makeSentinelDeps({
    context: {
      terminalApp: 'Ghostty',
      cwd: '/Users/test/project',
      command: 'claude',
    },
    fetches: [
      response(200, {
        session: { agent: 'claude', id: 'sid-1', project: '/Users/test/project' },
      }),
      response(500, 'broken'),
    ],
  });

  await syncFocusedTerminalContextToClipboard(deps);

  assert.equal(readClipboard(), SENTINEL);
  assert.deepEqual(writeCalls, []);
});

test('sentinel: success path overwrites sentinel with takeover prompt', async () => {
  // Positive control: confirms the mock clipboard actually mutates when the
  // flow succeeds. Without this, every other test could pass even if the
  // mock was broken and never accepted writes.
  const { deps, readClipboard, writeCalls } = makeSentinelDeps({
    context: {
      terminalApp: 'Ghostty',
      cwd: '/Users/test/project',
      command: 'claude',
    },
    fetches: [
      response(200, {
        session: { agent: 'claude', id: 'sid-1', project: '/Users/test/project' },
      }),
      response(200, {
        metadata: { agent_label: 'Claude Code' },
        takeover_prompt: 'NEW TAKEOVER PROMPT',
      }),
    ],
  });

  await syncFocusedTerminalContextToClipboard(deps);

  assert.equal(readClipboard(), 'NEW TAKEOVER PROMPT');
  assert.deepEqual(writeCalls, ['NEW TAKEOVER PROMPT']);
});
