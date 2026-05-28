const SUPPORTED_AGENT_COMMANDS = new Set(['claude', 'codex', 'antigravity', 'opencode']);

const DEFAULT_BACKEND_URL = 'http://localhost:8765';
const TRAY_SUCCESS = ' ✓ ';
const TRAY_ERROR = ' ✗ ';

function notify(deps, title, body) {
  deps.notify({ title, body, silent: false });
}

function errorResult(reason) {
  return { ok: false, reason };
}

async function syncFocusedTerminalContextToClipboard(deps) {
  const {
    backendUrl = DEFAULT_BACKEND_URL,
    fetchImpl = fetch,
    getFocusedTerminalContext,
    writeClipboard,
    showTrayFeedback,
    showErrorNotification,
    logger = console,
  } = deps;

  try {
    const context = await getFocusedTerminalContext();

    if (context.error) {
      showTrayFeedback(TRAY_ERROR, context.error);
      notify(
        deps,
        'VibeSync',
        context.error + ' Use the VibeSync UI or switch to a supported terminal host.'
      );
      return errorResult('context-error');
    }

    const isIde = context.hostKind === 'ide';

    if (!context.cwd) {
      const trayMsg = isIde ? 'Could not detect IDE workspace.' : 'Could not detect terminal cwd.';
      const notifyBody = isIde
        ? 'Could not detect IDE workspace directory. Open VibeSync to manually select a session.'
        : 'Could not detect terminal working directory. Open VibeSync to manually select a session.';
      showTrayFeedback(TRAY_ERROR, trayMsg);
      notify(deps, 'VibeSync', notifyBody);
      return errorResult('missing-cwd');
    }

    if (!SUPPORTED_AGENT_COMMANDS.has(context.command)) {
      const trayMsg = isIde
        ? 'No coding agent detected in IDE.'
        : 'No supported coding agent in focused terminal.';
      const notifyBody = isIde
        ? `No coding agent found in ${context.terminalApp}. Start Claude Code, Codex, Antigravity CLI, or OpenCode in the integrated terminal.`
        : `Focused terminal command is "${context.command || 'unknown'}". Start Claude Code, Codex, Antigravity CLI, or OpenCode in this terminal.`;
      const notifyTitle = isIde
        ? 'No coding agent detected in IDE'
        : 'No supported coding agent detected';
      showTrayFeedback(TRAY_ERROR, trayMsg);
      notify(deps, notifyTitle, notifyBody);
      return errorResult('unsupported-command');
    }

    const resolveRes = await fetchImpl(`${backendUrl}/api/takeover/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        terminalApp: context.terminalApp,
        cwd: context.cwd,
        command: context.command,
      }),
    });

    if (resolveRes.status === 409) {
      showTrayFeedback(TRAY_ERROR, 'Multiple matching sessions. Open VibeSync to choose.');
      notify(
        deps,
        'Multiple matching sessions found',
        'Open VibeSync to choose the exact session.'
      );
      return errorResult('multiple-matches');
    }

    if (resolveRes.status === 404) {
      showTrayFeedback(TRAY_ERROR, 'No matching session for this terminal.');
      notify(
        deps,
        'No matching session found',
        'Could not find a session matching the focused terminal. Open VibeSync to select manually.'
      );
      return errorResult('no-match');
    }

    if (!resolveRes.ok) {
      const errorData = await resolveRes.json().catch(() => ({}));
      throw new Error(errorData.error || `Backend returned ${resolveRes.status}`);
    }

    const { session } = await resolveRes.json();

    const detailsRes = await fetchImpl(`${backendUrl}/api/sessions/${session.agent}/${session.id}`);
    if (!detailsRes.ok) {
      const detailsError = await detailsRes.text();
      throw new Error(`Error fetching details for ${session.agent}/${session.id}: ${detailsError}`);
    }

    const details = await detailsRes.json();
    if (!details || !details.takeover_prompt) {
      showTrayFeedback(TRAY_ERROR, 'Failed to generate takeover prompt.');
      showErrorNotification('Failed to generate takeover prompt.');
      return errorResult('missing-takeover-prompt');
    }

    writeClipboard(details.takeover_prompt);

    const agentLabel = details.metadata?.agent_label || session.agent;
    const projectName = session.project.split('/').pop();

    showTrayFeedback(TRAY_SUCCESS, `Copied ${agentLabel} prompt · ${projectName}`);
    notify(
      deps,
      'VibeSync takeover prompt copied',
      `Copied ${agentLabel} prompt for ${projectName}. Matched ${context.terminalApp}: ${context.cwd}`
    );

    return {
      ok: true,
      agent: session.agent,
      sessionId: session.id,
      project: session.project,
    };
  } catch (err) {
    logger.error?.('VibeSync context-aware copy error:', err);
    showTrayFeedback(TRAY_ERROR, 'Backend unreachable or error occurred.');
    showErrorNotification(err.message || 'Make sure VibeSync backend server is running (python3 backend/app.py).');
    return errorResult('exception');
  }
}

module.exports = {
  SUPPORTED_AGENT_COMMANDS,
  syncFocusedTerminalContextToClipboard,
  _private: {
    TRAY_SUCCESS,
    TRAY_ERROR,
  },
};
