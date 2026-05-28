const { execSync } = require('child_process');

// ── IDE Host Focused-Signal Feasibility (macOS) ──────────────────────────
// VS Code / Cursor / Windsurf / JetBrains are registered so the hotkey can
// walk their process trees when they are the frontmost app.
//
// With Accessibility permissions (System Events assistive access), IDE
// window titles are readable and can be used to identify the focused
// workspace. Without permissions, only process-tree heuristics apply.
//
//   Signal                       VS Code  Cursor  Windsurf  JetBrains
//   ──────────────────────       ───────  ──────  ────────  ─────────
//   AppleScript app name          ✓        ✓       ✓         ✗
//   Window title (accessibility)  ✓        ✓       ✓         ✓
//   Process-tree agent cwd        ✓        ✓       ✓         ✓
//   Config-file active w/s        ✗        ✗       ✗         ✗
//   Integrated-terminal tty       ✗        ✗       ✗         ✗
//
// With Accessibility: window title → workspace name → filter agent cwds
// whose basename matches. This disambiguates multi-window IDE setups.
//
// Without Accessibility: the resolver walks the full IDE process tree and
// may produce ambiguity errors when different agents run in different
// projects. The `accessibilityDenied` flag in the context result lets the
// UI prompt the user to grant the permission.
//
// When no coding agent is running in the IDE's process tree, the hotkey
// returns a clear error telling the user to start an agent in the IDE's
// integrated terminal.

const HOST_DEFINITIONS = [
  {
    key: 'ghostty',
    label: 'Ghostty',
    appNames: ['Ghostty'],
    bundleNames: ['Ghostty'],
    kind: 'terminal',
    cwdStrategy: 'ghostty',
    ttyStrategy: 'ghostty',
  },
  {
    key: 'iterm2',
    label: 'iTerm2',
    appNames: ['iTerm2'],
    bundleNames: ['iTerm', 'iTerm2'],
    kind: 'terminal',
    ttyStrategy: 'iterm2',
  },
  {
    key: 'terminal',
    label: 'Terminal.app',
    appNames: ['Terminal'],
    bundleNames: ['Terminal'],
    kind: 'terminal',
    ttyStrategy: 'terminal',
  },
  {
    key: 'vscode',
    label: 'VS Code',
    appNames: ['Code', 'Visual Studio Code'],
    bundleNames: ['Visual Studio Code', 'Code'],
    kind: 'ide',
  },
  {
    key: 'cursor',
    label: 'Cursor',
    appNames: ['Cursor'],
    bundleNames: ['Cursor'],
    kind: 'ide',
  },
  {
    key: 'windsurf',
    label: 'Windsurf',
    appNames: ['Windsurf'],
    bundleNames: ['Windsurf'],
    kind: 'ide',
  },
  {
    key: 'jetbrains',
    label: 'JetBrains IDE',
    appNames: [
      'IntelliJ IDEA',
      'PyCharm',
      'WebStorm',
      'GoLand',
      'PhpStorm',
      'CLion',
      'RubyMine',
      'DataGrip',
      'Rider',
      'Android Studio',
    ],
    bundleNames: [
      'IntelliJ IDEA',
      'PyCharm',
      'WebStorm',
      'GoLand',
      'PhpStorm',
      'CLion',
      'RubyMine',
      'DataGrip',
      'Rider',
      'Android Studio',
    ],
    kind: 'ide',
  },
];

const SUPPORTED_TERMINALS = HOST_DEFINITIONS
  .filter((host) => host.kind === 'terminal')
  .flatMap((host) => host.appNames);
const SUPPORTED_HOST_LABELS = HOST_DEFINITIONS.map((host) => host.label);

const COMMAND_MAP = {
  claude: 'claude',
  'claude-code': 'claude',
  codex: 'codex',
  antigravity: 'antigravity',
  'antigravity-cli': 'antigravity',
  agy: 'antigravity',
  opencode: 'opencode',
};

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function numericPid(pid) {
  const parsed = Number(pid);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizePath(value) {
  if (!value) return null;
  return String(value).replace(/\/+$/, '') || '/';
}

function osa(script) {
  return sh(`osascript -e ${shellQuote(script)}`);
}

function getHostDefinition(raw) {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const host of HOST_DEFINITIONS) {
    if (host.appNames.some((name) => name.toLowerCase() === lower)) {
      return host;
    }
  }
  return null;
}

function isSupportedHost(raw) {
  return Boolean(getHostDefinition(raw));
}

function getFrontmostApp() {
  return osa("tell application \"System Events\" to get name of first application process whose frontmost is true");
}

function getTerminalTty(host) {
  if (host?.ttyStrategy === 'ghostty') {
    return osa(`
      tell application "Ghostty"
        try
          return tty of focused terminal of selected tab of front window
        on error
          return ""
        end try
      end tell
    `);
  }
  if (host?.ttyStrategy === 'iterm2') {
    return osa("tell application \"iTerm2\" to tell current session of current window to get tty");
  }
  if (host?.ttyStrategy === 'terminal') {
    return osa(`
      tell application "Terminal"
        try
          get tty of selected tab of window 1
        on error
          return ""
        end try
      end tell
    `);
  }
  return '';
}

function getFocusedWorkingDirectory(host) {
  if (host?.cwdStrategy === 'ghostty') {
    return osa(`
      tell application "Ghostty"
        try
          return working directory of focused terminal of selected tab of front window
        on error
          return ""
        end try
      end tell
    `);
  }
  return '';
}

function getFocusedWindowTitleViaAccessibility(appName) {
  try {
    const result = execSync(
      `osascript -e ${shellQuote(`tell application "System Events" to tell process ${shellQuote(appName)} to get name of front window`)}`,
      { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 }
    ).trim();
    return { title: result, accessible: true };
  } catch (err) {
    const stderr = (err.stderr || '').toString();
    if (stderr.includes('-1719') || stderr.includes('not allowed assistive access')) {
      return { title: '', accessible: false };
    }
    // Window doesn't exist or other transient error — accessible but failed.
    return { title: '', accessible: true };
  }
}

function extractWorkspaceFromWindowTitle(title, host) {
  if (!title) return null;

  // Strip the IDE application name suffix (e.g. " — Visual Studio Code")
  // Sort by length descending so "Visual Studio Code" matches before "Code".
  let cleaned = title;
  const sortedNames = [...host.appNames].sort((a, b) => b.length - a.length);
  for (const appName of sortedNames) {
    const idx = cleaned.lastIndexOf(appName);
    if (idx > 0) {
      cleaned = cleaned.substring(0, idx).trim();
      cleaned = cleaned.replace(/[\s—–-]+$/, '');
      break;
    }
  }

  // Split into segments: "file.js — workspace" or "workspace — [branch] — file.js"
  const parts = cleaned.split(/\s+[—–-]\s+/).filter(Boolean);
  if (parts.length === 0) return null;

  // JetBrains: project is always the first segment.
  //   Format: "{project} – [{branch}] – {file}"  or  "{project} – {file}"
  if (host.key === 'jetbrains') {
    return parts[0].trim() || null;
  }

  // Electron-based IDEs (VS Code, Cursor, Windsurf):
  //   Format: "{workspace} — IDE"  or  "{file} — {workspace} — IDE"
  // The last non-file-like segment (right to left) is the workspace.
  const filePattern = /\.[a-zA-Z]{1,6}$/;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i].trim();
    if (part && !filePattern.test(part)) {
      return part;
    }
  }

  return null;
}

function getCwd(pid) {
  const safePid = numericPid(pid);
  if (!safePid) return null;
  const out = sh(`lsof -a -p ${safePid} -d cwd -Fn 2>/dev/null`);
  const match = out.match(/^n(.+)$/m);
  return match ? match[1] : null;
}

function getCommand(pid) {
  const safePid = numericPid(pid);
  if (!safePid) return null;
  return sh(`ps -o command= -p ${safePid} 2>/dev/null`) || null;
}

function normalizeCommand(cmd) {
  if (!cmd) return null;
  // Extract the first word (executable), not the last path segment of args.
  const firstWord = cmd.trim().split(/\s+/)[0];
  const base = firstWord.split('/').pop().toLowerCase();
  return COMMAND_MAP[base] || base;
}

function isSupportedAgentCommand(command) {
  return ['claude', 'codex', 'antigravity', 'opencode'].includes(command);
}

function isCodingAgentProcess(cmd) {
  const agent = normalizeCommand(cmd);
  if (!isSupportedAgentCommand(agent)) return false;

  const text = String(cmd || '');

  // Filter IDE extension / background processes that share the agent
  // executable name but are not interactive CLI sessions:
  //
  //   codex app-server [--listen stdio://]       Codex IDE extension server
  //   codex app-server --analytics-default-enabled  Codex telemetry sidecar
  //   codex app-server --anything                   any future app-server variant
  //
  // The CLI session process is just "codex" with no app-server subcommand.
  if (agent === 'codex' && /\bcodex\s+app-server\b/.test(text)) {
    return false;
  }

  return true;
}

function findProcessesOnTty(tty) {
  const short = (tty || '').replace('/dev/', '').trim();
  if (!/^tty[a-zA-Z0-9]+$/.test(short)) return [];
  const out = sh(`ps -t ${shellQuote(short)} -o pid=,ppid=,command= 2>/dev/null`);
  if (!out) return [];

  return out
    .split('\n')
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) return null;
      return {
        pid: parseInt(parts[0], 10),
        ppid: parseInt(parts[1], 10),
        command: parts.slice(2).join(' '),
      };
    })
    .filter(Boolean);
}

function findRepresentativeLeaf(processes) {
  if (processes.length === 0) return null;

  const parentPids = new Set(processes.map((p) => p.ppid));
  const candidates = processes.filter((p) => !parentPids.has(p.pid));
  if (candidates.length === 0) {
    return processes.reduce((a, b) => (a.pid > b.pid ? a : b));
  }

  for (const proc of candidates) {
    const norm = normalizeCommand(proc.command);
    if (isSupportedAgentCommand(norm) && isCodingAgentProcess(proc.command)) {
      return proc;
    }
  }

  return candidates.reduce((a, b) => (a.pid > b.pid ? a : b));
}

function resolveAgentFromProcesses(processes, source, cwdForPid = getCwd, cwdFilter = null) {
  const allAgentProcesses = processes
    .map((proc) => ({
      ...proc,
      agent: normalizeCommand(proc.command),
      cwd: cwdForPid(proc.pid),
    }))
    .filter((proc) => isCodingAgentProcess(proc.command));
  const normalizedCwdFilter = cwdFilter ? normalizePath(cwdFilter) : null;
  const agentProcesses = normalizedCwdFilter
    ? allAgentProcesses.filter((proc) => normalizePath(proc.cwd) === normalizedCwdFilter)
    : allAgentProcesses;

  if (cwdFilter && allAgentProcesses.length > 0 && agentProcesses.length === 0) {
    return {
      error: `No coding agent process matched focused cwd ${cwdFilter}. Open VibeSync to choose the exact session.`,
      command: null,
      cwd: cwdFilter,
      pid: null,
      source,
    };
  }

  if (agentProcesses.length === 1) {
    return {
      pid: agentProcesses[0].pid,
      cwd: agentProcesses[0].cwd,
      command: agentProcesses[0].agent,
      source,
    };
  }

  if (agentProcesses.length > 1) {
    const withCwd = agentProcesses.filter((proc) => proc.cwd);
    const uniqueContexts = new Set(withCwd.map((proc) => `${proc.agent}:${proc.cwd}`));
    if (uniqueContexts.size === 1) {
      const newest = withCwd.reduce((a, b) => (a.pid > b.pid ? a : b));
      return {
        pid: newest.pid,
        cwd: newest.cwd,
        command: newest.agent,
        source,
      };
    }
    return {
      error: `Multiple coding agent processes detected in focused ${source}. Open VibeSync to choose the exact session.`,
      command: null,
      cwd: null,
      pid: null,
      source,
    };
  }

  const leaf = findRepresentativeLeaf(processes);
  return {
    pid: leaf?.pid || null,
    cwd: leaf ? cwdForPid(leaf.pid) : null,
    command: leaf ? normalizeCommand(leaf.command) : null,
    source,
  };
}

function shouldUseHostProcessTree(usedFocusedTty, resolved) {
  return !usedFocusedTty && (
    !resolved ||
    resolved.error ||
    !resolved.cwd ||
    !isSupportedAgentCommand(resolved.command)
  );
}

function getChildPids(parentPid) {
  const safePid = numericPid(parentPid);
  if (!safePid) return [];
  // Use ps instead of pgrep -P: pgrep -P on macOS misses recently spawned children.
  const out = sh(`ps -eo pid=,ppid= | awk '$2 == ${safePid} {print $1}' 2>/dev/null`);
  if (!out) return [];
  return out.split('\n').map(Number).filter((n) => n && !isNaN(n));
}

function findHostPids(host) {
  if (!host) return [];

  const patterns = host.bundleNames.map((name) => {
    const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return `${escaped}\\.app/`;
  }).filter(Boolean);

  if (patterns.length === 0) return [];
  const out = sh(`ps -eo pid=,command= | grep -iE ${shellQuote(patterns.join('|'))} 2>/dev/null`);
  if (!out) return [];

  return [...new Set(out
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)/);
      return match ? parseInt(match[1], 10) : null;
    })
    .filter(Boolean))];
}

function collectProcessTree(parentPid, maxDepth, processes, seen) {
  if (maxDepth <= 0) return;
  const safePid = numericPid(parentPid);
  if (!safePid || seen.has(safePid)) return;
  seen.add(safePid);

  const children = getChildPids(safePid);
  for (const cpid of children) {
    if (seen.has(cpid)) continue;
    const cmd = getCommand(cpid);
    if (cmd) {
      processes.push({ pid: cpid, ppid: safePid, command: cmd });
    }
    collectProcessTree(cpid, maxDepth - 1, processes, seen);
  }
}

function resolveAgentFromHostProcessTree(host, cwdFilter = null) {
  const rootPids = findHostPids(host);
  if (rootPids.length === 0) {
    return {
      error: `Could not inspect ${host.label} process tree.`,
      pid: null,
      cwd: null,
      command: null,
      source: 'host-process-tree',
    };
  }

  const processes = [];
  const seen = new Set();
  for (const rootPid of rootPids) {
    const rootCommand = getCommand(rootPid);
    if (rootCommand) {
      processes.push({ pid: rootPid, ppid: 0, command: rootCommand });
    }
    collectProcessTree(rootPid, 10, processes, seen);
  }

  return resolveAgentFromProcesses(processes, 'host-process-tree', getCwd, cwdFilter);
}

function calculateConfidence(appName, cwd, command) {
  let confidence = 0;
  if (isSupportedHost(appName)) confidence += 0.3;
  if (cwd) confidence += 0.3;
  if (command && isSupportedAgentCommand(command)) {
    confidence += 0.4;
  } else if (command) {
    confidence += 0.1;
  }
  return Math.min(confidence, 1.0);
}

async function getFocusedTerminalContext() {
  const rawAppName = getFrontmostApp();
  const host = getHostDefinition(rawAppName);

  if (!host) {
    return {
      terminalApp: rawAppName || 'unknown',
      hostApp: rawAppName || 'unknown',
      hostKind: 'unsupported',
      cwd: null,
      command: null,
      confidence: 0,
      error: rawAppName
        ? `Focused app "${rawAppName}" is not a supported terminal host.`
        : 'Could not determine focused application.',
    };
  }

  const tty = getTerminalTty(host);
  let focusedCwd = getFocusedWorkingDirectory(host);
  let resolved = null;
  let usedFocusedTty = false;
  let accessibilityDenied = false;
  let accessibilitySource = null;

  // ── IDE host: try Accessibility window title as focused-workspace signal ──
  if (host.kind === 'ide') {
    const { title, accessible } = getFocusedWindowTitleViaAccessibility(rawAppName);
    if (!accessible) {
      accessibilityDenied = true;
    } else if (title) {
      const workspaceName = extractWorkspaceFromWindowTitle(title, host);
      if (workspaceName) {
        // Walk the IDE process tree looking for agent cwds that match the
        // workspace name extracted from the window title. If exactly one
        // agent cwd matches, use it as the focusedCwd filter.
        const ideProcesses = [];
        const ideSeen = new Set();
        const ideRootPids = findHostPids(host);
        for (const rp of ideRootPids) {
          const rc = getCommand(rp);
          if (rc) ideProcesses.push({ pid: rp, ppid: 0, command: rc });
          collectProcessTree(rp, 10, ideProcesses, ideSeen);
        }

        const matchingCwds = [...new Set(
          ideProcesses
            .filter((p) => isCodingAgentProcess(p.command))
            .map((p) => getCwd(p.pid))
            .filter(Boolean)
            .filter((cwd) => {
              const base = cwd.split('/').pop();
              return base === workspaceName || cwd.endsWith('/' + workspaceName);
            })
        )];

        if (matchingCwds.length === 1) {
          focusedCwd = matchingCwds[0];
          accessibilitySource = 'ide-window-title';
        }
      }
    }
  }

  if (tty) {
    usedFocusedTty = true;
    const processes = findProcessesOnTty(tty);
    if (processes.length > 0) {
      resolved = resolveAgentFromProcesses(processes, 'focused-tty');
    }
  }

  if (shouldUseHostProcessTree(usedFocusedTty, resolved)) {
    resolved = resolveAgentFromHostProcessTree(host, focusedCwd || null);
    if (focusedCwd && resolved && !resolved.cwd) {
      resolved.cwd = focusedCwd;
    }
  }

  const confidence = calculateConfidence(rawAppName, resolved?.cwd, resolved?.command);

  let source = resolved?.source || (tty ? 'focused-tty' : 'host-process-tree');
  if (accessibilitySource && resolved?.source === 'host-process-tree') {
    source = accessibilitySource;
  }

  return {
    terminalApp: host.label,
    hostApp: host.label,
    hostKind: host.kind,
    pid: resolved?.pid || null,
    tty: tty || null,
    cwd: resolved?.cwd || focusedCwd || null,
    command: resolved?.command || null,
    confidence,
    source,
    error: resolved?.error || null,
    accessibilityDenied: accessibilityDenied || undefined,
  };
}

module.exports = {
  getFocusedTerminalContext,
  SUPPORTED_TERMINALS,
  SUPPORTED_HOST_LABELS,
  _private: {
    getHostDefinition,
    getFocusedWorkingDirectory,
    getFocusedWindowTitleViaAccessibility,
    extractWorkspaceFromWindowTitle,
    normalizeCommand,
    isCodingAgentProcess,
    normalizePath,
    findRepresentativeLeaf,
    resolveAgentFromProcesses,
    resolveAgentFromHostProcessTree,
    shouldUseHostProcessTree,
    calculateConfidence,
    isSupportedHost,
  },
};
