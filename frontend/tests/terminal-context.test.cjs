const assert = require('node:assert/strict');
const { test } = require('node:test');

const { SUPPORTED_HOST_LABELS, _private } = require('../terminal-context.cjs');

function cwdMap(entries) {
  return (pid) => entries[pid] || null;
}

test('host detector lists the target terminal and IDE hosts', () => {
  for (const label of ['Ghostty', 'iTerm2', 'Terminal.app', 'VS Code', 'Cursor', 'Windsurf', 'JetBrains IDE']) {
    assert.ok(SUPPORTED_HOST_LABELS.includes(label), `${label} should be supported`);
  }

  assert.equal(_private.getHostDefinition('Code').label, 'VS Code');
  assert.equal(_private.getHostDefinition('Cursor').label, 'Cursor');
  assert.equal(_private.getHostDefinition('WebStorm').label, 'JetBrains IDE');
  assert.equal(_private.getHostDefinition('Safari'), null);
});

test('agent command normalization covers supported coding CLIs', () => {
  assert.equal(_private.normalizeCommand('/opt/homebrew/bin/claude --continue'), 'claude');
  assert.equal(_private.normalizeCommand('claude-code'), 'claude');
  assert.equal(_private.normalizeCommand('/usr/local/bin/codex resume abc'), 'codex');
  assert.equal(_private.normalizeCommand('agy'), 'antigravity');
  assert.equal(_private.normalizeCommand('opencode'), 'opencode');
  assert.equal(_private.normalizeCommand('/bin/zsh -l'), 'zsh');
});

test('process resolver returns the only supported agent process with its cwd', () => {
  const result = _private.resolveAgentFromProcesses(
    [
      { pid: 10, ppid: 1, command: '/bin/zsh -l' },
      { pid: 11, ppid: 10, command: '/opt/homebrew/bin/codex' },
    ],
    'focused-tty',
    cwdMap({ 11: '/Users/test/project' })
  );

  assert.deepEqual(result, {
    pid: 11,
    cwd: '/Users/test/project',
    command: 'codex',
    source: 'focused-tty',
  });
});

test('process resolver allows duplicate processes only when they prove the same agent context', () => {
  const result = _private.resolveAgentFromProcesses(
    [
      { pid: 21, ppid: 1, command: 'claude' },
      { pid: 22, ppid: 1, command: '/usr/local/bin/claude-code --resume' },
    ],
    'host-process-tree',
    cwdMap({ 21: '/Users/test/project', 22: '/Users/test/project' })
  );

  assert.equal(result.pid, 22);
  assert.equal(result.cwd, '/Users/test/project');
  assert.equal(result.command, 'claude');
});

test('process resolver refuses multiple different agent contexts', () => {
  const result = _private.resolveAgentFromProcesses(
    [
      { pid: 31, ppid: 1, command: 'claude' },
      { pid: 32, ppid: 1, command: 'codex' },
    ],
    'host-process-tree',
    cwdMap({ 31: '/Users/test/a', 32: '/Users/test/b' })
  );

  assert.equal(result.pid, null);
  assert.equal(result.cwd, null);
  assert.equal(result.command, null);
  assert.match(result.error, /Multiple coding agent processes/);
});

test('process resolver can restrict host process tree matches to a focused cwd', () => {
  const result = _private.resolveAgentFromProcesses(
    [
      { pid: 51, ppid: 1, command: 'claude' },
      { pid: 52, ppid: 1, command: 'codex' },
    ],
    'host-process-tree',
    cwdMap({ 51: '/Users/test/focused', 52: '/Users/test/other' }),
    '/Users/test/focused/'
  );

  assert.equal(result.pid, 51);
  assert.equal(result.cwd, '/Users/test/focused');
  assert.equal(result.command, 'claude');
});

test('process resolver refuses agent processes outside the focused cwd', () => {
  const result = _private.resolveAgentFromProcesses(
    [
      { pid: 61, ppid: 1, command: 'codex' },
    ],
    'host-process-tree',
    cwdMap({ 61: '/Users/test/other' }),
    '/Users/test/focused'
  );

  assert.equal(result.pid, null);
  assert.equal(result.cwd, '/Users/test/focused');
  assert.equal(result.command, null);
  assert.match(result.error, /No coding agent process matched focused cwd/);
});

test('isCodingAgentProcess filters codex app-server extension processes', () => {
  // CLI agent process — should be recognized
  assert.equal(_private.isCodingAgentProcess('/opt/homebrew/bin/codex'), true);
  assert.equal(_private.isCodingAgentProcess('codex resume abc123'), true);

  // IDE extension / background processes — should be filtered
  assert.equal(
    _private.isCodingAgentProcess('codex app-server --listen stdio://'),
    false
  );
  assert.equal(
    _private.isCodingAgentProcess('/Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled'),
    false
  );
  assert.equal(
    _private.isCodingAgentProcess('/Users/test/.vscode/extensions/openai.chatgpt/bin/codex app-server --analytics-default-enabled'),
    false
  );
  assert.equal(
    _private.isCodingAgentProcess('claude'), true
  );
  assert.equal(
    _private.isCodingAgentProcess('opencode serve'), true
  );
  assert.equal(
    _private.isCodingAgentProcess('/bin/zsh -l'), false
  );
});

test('IDE host definitions return correct hostKind and lack cwd/tty strategies', () => {
  const vscode = _private.getHostDefinition('Code');
  assert.equal(vscode.kind, 'ide');
  assert.equal(vscode.cwdStrategy, undefined);
  assert.equal(vscode.ttyStrategy, undefined);

  const cursor = _private.getHostDefinition('Cursor');
  assert.equal(cursor.kind, 'ide');

  const windsurf = _private.getHostDefinition('Windsurf');
  assert.equal(windsurf.kind, 'ide');

  const idea = _private.getHostDefinition('IntelliJ IDEA');
  assert.equal(idea.kind, 'ide');
  assert.equal(idea.label, 'JetBrains IDE');

  const terminal = _private.getHostDefinition('Ghostty');
  assert.equal(terminal.kind, 'terminal');
  assert.equal(terminal.cwdStrategy, 'ghostty');
  assert.equal(terminal.ttyStrategy, 'ghostty');
});

test('process resolver filters codex app-server but keeps agent CLI in IDE process trees', () => {
  // Simulate a typical IDE process tree: zsh shell with codex agent running,
  // plus a codex app-server extension process in the same tree.
  const result = _private.resolveAgentFromProcesses(
    [
      { pid: 100, ppid: 1, command: '/bin/zsh -l' },
      { pid: 101, ppid: 100, command: '/opt/homebrew/bin/codex' },
      { pid: 102, ppid: 1, command: 'codex app-server --analytics-default-enabled' },
    ],
    'host-process-tree',
    cwdMap({ 100: '/Users/test/ide-project', 101: '/Users/test/ide-project', 102: '/Users/test/ide-project' })
  );

  assert.equal(result.pid, 101);
  assert.equal(result.cwd, '/Users/test/ide-project');
  assert.equal(result.command, 'codex');
});

test('process resolver returns leaf shell when no agent in IDE tree with cwd filter', () => {
  // IDE focused on a specific workspace but no coding agent running there.
  // Falls through to findRepresentativeLeaf, which returns the shell process.
  // The hotkey layer then shows "No supported coding agent" based on command.
  const result = _private.resolveAgentFromProcesses(
    [
      { pid: 200, ppid: 1, command: '/bin/zsh -l' },
    ],
    'host-process-tree',
    cwdMap({ 200: '/Users/test/other' }),
    '/Users/test/focused'
  );

  assert.equal(result.pid, 200);
  assert.equal(result.cwd, '/Users/test/other');
  assert.equal(result.command, 'zsh');
  // zsh is not a supported agent — the hotkey layer rejects it.
  // resolveAgentFromProcesses does not error; it gives the best leaf it has.
});

test('IDE host falls through to host-process-tree when no focused tty', () => {
  // shouldUseHostProcessTree returns true when no focused tty was used
  // and resolved result is missing cwd or agent command.
  const noAgentResult = { pid: 300, cwd: '/tmp', command: 'zsh', source: 'host-process-tree' };
  assert.equal(_private.shouldUseHostProcessTree(false, noAgentResult), true);

  // With a valid tty result, should NOT fall through.
  const ttyResult = { pid: 301, cwd: '/Users/test', command: 'claude', source: 'focused-tty' };
  assert.equal(_private.shouldUseHostProcessTree(true, ttyResult), false);
});

test('focused tty result blocks app-wide process-tree fallback', () => {
  const shellOnly = _private.resolveAgentFromProcesses(
    [
      { pid: 41, ppid: 1, command: '/bin/zsh -l' },
    ],
    'focused-tty',
    cwdMap({ 41: '/Users/test/project' })
  );

  assert.equal(shellOnly.command, 'zsh');
  assert.equal(shellOnly.cwd, '/Users/test/project');
  assert.equal(_private.shouldUseHostProcessTree(true, shellOnly), false);
  assert.equal(_private.shouldUseHostProcessTree(false, shellOnly), true);
});

test('extractWorkspaceFromWindowTitle parses VS Code title with workspace only', () => {
  const host = _private.getHostDefinition('Code');
  const result = _private.extractWorkspaceFromWindowTitle('vibesync - Visual Studio Code', host);
  assert.equal(result, 'vibesync');
});

test('extractWorkspaceFromWindowTitle parses VS Code title with file and workspace', () => {
  const host = _private.getHostDefinition('Code');
  const result = _private.extractWorkspaceFromWindowTitle('App.jsx - vibesync - Visual Studio Code', host);
  assert.equal(result, 'vibesync');
});

test('extractWorkspaceFromWindowTitle parses Cursor title with em dash', () => {
  const host = _private.getHostDefinition('Cursor');
  const result = _private.extractWorkspaceFromWindowTitle('myproject — Cursor', host);
  assert.equal(result, 'myproject');
});

test('extractWorkspaceFromWindowTitle parses JetBrains title with file', () => {
  const host = _private.getHostDefinition('IntelliJ IDEA');
  const result = _private.extractWorkspaceFromWindowTitle('vibesync – backend/app.py', host);
  assert.equal(result, 'vibesync');
});

test('extractWorkspaceFromWindowTitle parses JetBrains title with branch and file', () => {
  const host = _private.getHostDefinition('IntelliJ IDEA');
  // JetBrains format: "{project} – [{branch}] – {file}" — project is first segment.
  const result = _private.extractWorkspaceFromWindowTitle('vibesync – [main] – app.py', host);
  assert.equal(result, 'vibesync');
});

test('extractWorkspaceFromWindowTitle returns null for empty title', () => {
  const host = _private.getHostDefinition('Code');
  assert.equal(_private.extractWorkspaceFromWindowTitle('', host), null);
  assert.equal(_private.extractWorkspaceFromWindowTitle(null, host), null);
});
