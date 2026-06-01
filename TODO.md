# TODO: Context-Aware Terminal Hotkey Takeover

> **Status: Feature complete (2026-05-29).** All 12 implementation items below
> are shipped, the IDE accessibility flow is wired into both Electron main and
> the React debug panel, and the supporting test suite is at 60 automated
> tests (40 frontend + 20 backend). Remaining `Open Questions` items have been
> moved into [pre-release-checklist.md](pre-release-checklist.md) for tracking
> as release polish, not blocking new feature work.

## Goal

Make `Cmd+Shift+C` copy the takeover prompt for the coding agent session that belongs to the currently focused terminal pane/window.

The app UI remains the manual picker: if automatic terminal detection is unsupported, unavailable, or cannot match a session, the user can open VibeSync and select the exact session manually.

## Previous Behavior

- Electron currently registers global shortcuts in `frontend/main-electron.cjs`.
- The old shortcut path called `GET /api/sessions`, took `sessions[0]`, then copied that latest session's `takeover_prompt`.
- That was not terminal-aware. It did not know which terminal app, tab, pane, cwd, or coding agent process the user was currently using.
- Result: pressing the hotkey in a Claude terminal can still copy Codex or Antigravity if that session is newest.

## Target Behavior

- `Cmd+Shift+C`: copy takeover prompt for the currently focused terminal's active coding agent session.
- No secondary "copy latest session" hotkey.
- Tray/app UI: keep manual selection and copy buttons for unsupported or unmatched terminal contexts.
- `Cmd+Shift+C` must fail loudly instead of silently falling back to the latest session.

Expected user flow:

1. User is working in terminal A with Claude Code in `/path/to/project`.
2. User presses `Cmd+Shift+C`.
3. VibeSync identifies the focused terminal context.
4. VibeSync resolves that context to a local session transcript.
5. VibeSync copies a takeover prompt containing the transcript path and workspace path.
6. User switches to terminal B, starts another coding agent, and pastes the prompt.

## Implementation Plan

### 1. Add Terminal Context Capture

Create a small macOS-focused module in Electron main process, for example:

- `frontend/terminal-context.cjs`

It should expose:

```js
async function getFocusedTerminalContext() {
  return {
    terminalApp: 'Ghostty',
    pid: 12345,
    tty: '/dev/ttys007',
    cwd: '/Users/gordonbai/vibesync',
    command: 'claude',
    confidence: 0.9,
    source: 'accessibility+process-tree'
  };
}
```

Minimum viable fields:

- `terminalApp`
- `cwd`
- `command`
- `confidence`

Implementation sequence:

- Detect frontmost app with AppleScript/System Events.
- Support these terminal hosts:
  - Ghostty
  - iTerm2
  - Terminal.app
  - VS Code
  - Cursor
  - Windsurf
  - JetBrains IDEs
- Try to get active tab/window/pane tty from app-specific AppleScript when the host exposes it.
- For Ghostty, use AppleScript `front window -> selected tab -> focused terminal -> working directory`
  to constrain process-tree matches to the focused terminal cwd.
- Use recursive process inspection to infer the active coding agent, cwd, and command:
  - `lsof -a -p <pid> -d cwd -Fn`
  - `ps -o pid=,ppid=,command= -ax`
  - recursive child-process lookup from the focused host process
- Normalize recognized commands:
  - `claude`, `claude-code` -> `claude`
  - `codex` -> `codex`
  - `antigravity`, `antigravity-cli` -> `antigravity`
  - `opencode` -> `opencode`

Failure behavior:

- If the focused app is not a supported terminal, return a structured error.
- If cwd is unknown, do not guess; show notification and ask user to use the UI.
- If command is unknown or unsupported, do not guess; show notification and ask user to use the UI.

### 2. Add Backend Resolve Endpoint

Add a new endpoint in `backend/app.py`:

```http
POST /api/takeover/resolve
Content-Type: application/json

{
  "terminalApp": "Ghostty",
  "cwd": "/Users/gordonbai/vibesync",
  "command": "claude"
}
```

Response:

```json
{
  "session": {
    "agent": "claude",
    "id": "..."
  },
  "reason": "matched agent and cwd",
  "confidence": 0.95,
  "candidates": []
}
```

Matching rules:

1. Require `cwd`; missing cwd returns an error.
2. Require `command` to map to a supported coding agent.
3. Search only that agent's sessions.
4. Prefer exact `session.project == cwd`.
5. Then allow parent workspace matches, using the existing `matches_cwd()` behavior.
6. Sort same-agent candidates by timestamp descending.
7. Return the top candidate if confidence is high.
8. If no candidate exists for the detected agent and cwd, return `404`; do not retry other agents.

Add parser method:

```py
def resolve_session_for_context(self, cwd=None, agent=None):
    ...
```

Keep this separate from `list_all_sessions()` so shortcut behavior can evolve without changing UI list behavior.

### 3. Wire Hotkey To Context-Aware Resolve

Update `frontend/main-electron.cjs`:

- `Cmd+Shift+C` should call `syncFocusedTerminalContextToClipboard()`.
- Keep only the `Cmd+Shift+C` global shortcut.
- Latest-session copying should only happen if the user manually selects a session in the UI.

New flow:

```text
global shortcut
-> getFocusedTerminalContext()
-> POST /api/takeover/resolve
-> GET /api/sessions/<agent>/<id>
-> clipboard.writeText(takeover_prompt)
-> native notification with agent, project, and match reason
```

Notification examples:

- Success:
  - `Copied Claude Code takeover prompt for vibesync`
  - Body: `Matched focused Ghostty pane: /Users/gordonbai/vibesync`
- Unsupported command:
  - `No supported coding agent detected`
  - Body: `Start Claude Code, Codex, Antigravity CLI, or OpenCode in this terminal.`
- Unsupported terminal:
  - `Focused app is not a supported terminal`
  - Body: `Use the VibeSync UI or switch to a supported terminal host.`

### 4. Add UI Debug Surface

Add a small debug area or dev-only button in the app UI:

- `Detect Current Terminal`
- Shows:
  - terminal app
  - cwd
  - command
  - matched agent/session
  - confidence/reason

This is important because terminal detection is inherently platform-specific and can fail silently without observability.

### 5. Tests

Backend tests:

- `resolve_session_for_context(cwd, agent)` exact agent + cwd match.
- Parent/child cwd match.
- Same cwd across multiple agents, command chooses correct agent.
- Same agent + same cwd multiple sessions, latest timestamp wins.
- Missing agent command returns no match.
- Unknown agent returns no match.
- No cwd returns no match.

Frontend/Electron tests or script-level checks:

- Live diagnostic script shows detected focused context, notification events, and dry-run clipboard behavior.
- Hotkey flow success writes the resolved `takeover_prompt` to clipboard.
- Host error, missing cwd, unsupported command, backend 404, and backend 409 notify without clipboard writes.
- Host detector lists Ghostty, iTerm2, Terminal.app, VS Code, Cursor, Windsurf, JetBrains.
- Command normalization maps Claude Code, Codex, Antigravity/agy, and OpenCode.
- Process resolver returns a single supported agent with cwd.
- Process resolver refuses multiple different agent contexts.
- Focused tty result blocks app-wide process-tree fallback.
- Confirm only the `Cmd+Shift+C` shortcut is registered.
- Confirm `Cmd+Shift+C` never copies latest session when terminal context cannot be resolved.

Manual QA:

1. Start backend with new parser.
2. Start Electron.
3. Open Ghostty in `/Users/gordonbai/vibesync`.
4. Start Claude Code, create a small interaction.
5. Press `Cmd+Shift+C`.
6. Paste clipboard into a text buffer and verify:
   - `Source agent: Claude Code`
   - `Workspace: /Users/gordonbai/vibesync`
   - transcript path points to `~/.claude/projects/...`
7. Repeat with Codex in the same cwd.
8. Focus an unsupported app and press `Cmd+Shift+C`; verify VibeSync shows an error and does not copy latest session.

Runtime evidence gathered:

- `npm run diagnose:hotkey` while Codex was frontmost returned `context-error` and only notification/tray events.
- After focusing the Ghostty `vibesync` tab, `npm run diagnose:hotkey` detected:
  - `terminalApp: Ghostty`
  - `cwd: /Users/gordonbai/vibesync`
  - `command: claude`
  - resolved `agent: claude`
  - emitted a dry-run clipboard event for a 916-char takeover prompt
- Automated `Cmd+Shift+C` keystroke simulation was attempted through `System Events`, but macOS returned error 1002 because `osascript` is not allowed to send keystrokes. This blocks automated shortcut pressing only; it does not exercise the same permission path as a human pressing the shortcut.

## Implementation Status (2026-05-28)

### Completed

1. **terminal-context.cjs** — `frontend/terminal-context.cjs`
   - Detects frontmost app via AppleScript/System Events
   - Supports Ghostty, iTerm2, Terminal.app, VS Code, Cursor, Windsurf, common JetBrains IDEs
   - Split into terminal host detection and recursive process-tree agent resolution
   - iTerm2/Terminal.app: AppleScript tty detection + `ps`/`lsof` process inspection
   - Ghostty: AppleScript focused terminal cwd + recursive process-tree agent resolution filtered to that cwd
   - IDE hosts: recursive process-tree detection
   - Command normalization: claude, codex, antigravity/agy, opencode
   - Confidence scoring: 0.3 app + 0.3 cwd + 0.1-0.4 command

2. **resolve_session_for_context** — `backend/parser.py`
   - Requires terminal cwd
   - Requires supported coding agent command
   - Searches only the detected agent with cwd filter
   - Exact cwd > parent workspace matching via `matches_cwd()`
   - Confidence scoring: agent match +0.2, exact cwd +0.2, parent cwd +0.1, recent +0.1

3. **POST /api/takeover/resolve** — `backend/app.py`
   - Accepts `{ cwd, command }`
   - 400 when cwd is missing
   - 400 when command is not a supported coding agent
   - 200 with `{ session, reason, confidence, candidates }` on match
   - 404 on no match
   - Shared decision path in `resolve_takeover_payload()` is covered by app-level unit tests

4. **Hotkey wired** — `frontend/main-electron.cjs`
   - `Cmd+Shift+C` now calls `syncFocusedTerminalContextToClipboard()`
   - Removed secondary global shortcut behavior
   - Removed latest-session copying from global shortcuts
   - Notifications: success (agent + project + matched pane), unsupported terminal, unsupported command, no match
   - IPC handler `detect-terminal` for UI debug surface
   - Core shortcut copy flow lives in testable `frontend/hotkey-sync.cjs`
   - `frontend/diagnose-hotkey.cjs` reuses the same hotkey flow for dry-run or explicit clipboard diagnostics

5. **Debug UI** — `frontend/src/App.jsx` + `App.css`
   - "Detect Current Terminal" button in session sidebar
   - Shows: terminal app, cwd, command, confidence, source
   - Shows resolve result: matched agent/session, reason, confidence

6. **Tests** — `backend/tests/test_parser.py` (15 tests)
   - `test_resolve_exact_agent_cwd_match` — exact agent + cwd
   - `test_resolve_parent_cwd_match` — child cwd matches parent project
   - `test_resolve_prefers_exact_cwd_over_newer_parent_workspace` — exact cwd beats newer broad parent match
   - `test_resolve_command_chooses_correct_agent` — agent param scopes search
   - `test_resolve_latest_timestamp_wins_same_agent_cwd` — latest wins
   - `test_resolve_missing_agent_returns_none` — no agent command → None
   - `test_resolve_unknown_agent_returns_none` — unknown agent → None
   - `test_resolve_no_match_returns_none` — empty → None
   - `test_resolve_no_cwd_no_agent_returns_none` — no latest fallback

7. **App resolve tests** — `backend/tests/test_app.py` (4 tests)
   - Missing cwd returns 400
   - Unsupported command returns 400
   - Command-scoped no match returns 404 without cross-agent fallback
   - Matching `{cwd, command}` returns 200 with the resolved session

8. **Hotkey sync tests** — `frontend/tests/hotkey-sync.test.cjs` (9 tests)
   - Successful focused terminal sync writes takeover prompt to clipboard
   - Focused host error notifies and does not touch backend or clipboard
   - Missing cwd notifies and does not touch backend or clipboard
   - Unsupported command notifies and does not touch backend or clipboard
   - Backend 404 notifies and does not fetch details or write clipboard
   - Backend 409 notifies and does not fetch details or write clipboard
   - IDE host with unsupported command shows IDE-specific messages
   - IDE host with missing cwd shows IDE-specific messages
   - Terminal host still shows terminal-specific messages (not IDE)

9. **Terminal context tests** — `frontend/tests/terminal-context.test.cjs` (20 tests)
   - Host detector includes requested terminal/IDE hosts
   - Command normalization covers supported coding CLIs
   - Single agent process resolves to agent + cwd
   - Duplicate processes only pass when they prove the same context
   - Multiple distinct agent contexts fail loudly
   - Host process-tree matches can be restricted to a focused cwd
   - Agent processes outside the focused cwd fail loudly
   - Focused tty does not fall back to app-wide process scanning
   - `isCodingAgentProcess` filters codex app-server extension variants
   - IDE host definitions have correct kind and lack cwd/tty strategies
   - Process resolver filters app-server but keeps agent CLI in IDE trees
   - Leaf shell returned when no agent in IDE tree (hotkey layer rejects zsh)
   - IDE host falls through to host-process-tree when no focused tty
   - Focused tty blocks host-process-tree fallback
   - `extractWorkspaceFromWindowTitle` parses VS Code, Cursor, JetBrains title formats
   - VS Code title with workspace-only parsed correctly
   - VS Code title with file + workspace parsed correctly
   - Cursor title with em dash parsed correctly
   - JetBrains title with branch and file parsed correctly
   - Empty/null title returns null

10. **IDE Host Focused-Signal Audit** (2026-05-28)
    - Audited all four IDE hosts: VS Code, Cursor, Windsurf, JetBrains
    - Verified AppleScript availability, process-tree reach, config-file workspace data

    | Signal               | VS Code | Cursor | Windsurf | JetBrains |
    |----------------------|---------|--------|----------|-----------|
    | AppleScript app name | yes     | yes    | likely   | no        |
    | AppleScript windows  | no      | no     | no       | no        |
    | Process-tree agent   | yes     | yes    | yes      | yes       |
    | Config active w/s    | no      | no     | no       | no        |
    | IPC socket query     | fragile | fragile| fragile  | no        |

    - **Verdict**: Partially feasible. IDE hosts detect coding agents via process tree
      but cannot identify which workspace is "focused" when multiple windows are open.
      Without Accessibility permissions, no reliable focused-workspace signal exists.

    - **Tightening applied**:
      - `isCodingAgentProcess` regex narrowed from `\bapp-server\b|--listen\s+stdio://`
        to `\bcodex\s+app-server\b` — requires the full "codex app-server" bigram,
        reducing false positives on future argument patterns.
      - Documentation block added above `HOST_DEFINITIONS` listing the signal matrix.
      - `hotkey-sync.cjs` now emits IDE-specific error messages when `hostKind === 'ide'`
        and no agent is detected ("No coding agent detected in IDE" vs "in focused terminal").
      - IDE hosts lack `cwdStrategy` and `ttyStrategy` — they rely on `resolveAgentFromHostProcessTree`
        which walks the full IDE process tree and filters to coding agent CLIs.
      - Verified Codex app-server processes (`--listen stdio://`, `--analytics-default-enabled`)
        are correctly filtered in VS Code and standalone Codex.app contexts.

11. **Accessibility-Based IDE Workspace Detection** (2026-05-28)
    - Added `getFocusedWindowTitleViaAccessibility(appName)` — reads front window title
      via System Events Accessibility API. Returns `{ title, accessible }` to distinguish
      "permission denied" (error -1719) from "window has no title" (other errors).
    - Added `extractWorkspaceFromWindowTitle(title, host)` — parses IDE window titles:
      - VS Code/Cursor/Windsurf: `"{workspace} — IDE"` or `"{file} — {workspace} — IDE"`
      - JetBrains: `"{project} – [{branch}] – {file}"` — project is first segment
      - Sorts appNames by length to avoid substring mismatches (e.g. "Code" vs "Visual Studio Code")
    - In `getFocusedTerminalContext()`: when host kind is `'ide'`, tries Accessibility window
      title before falling back to unfiltered process tree. If title yields a workspace name,
      walks IDE process tree to find agent cwds whose basename matches. Sets `focusedCwd`
      to the matching cwd, constraining the host-process-tree resolver to the correct workspace.
    - Returns `accessibilityDenied: true` when permission is missing, so the UI/Electron layer
      can prompt the user to grant assistive access.
    - `accessibilityDenied` is `undefined` for terminal hosts and unsupported hosts (no noise).

12. **Ghostty tty isolation + findHostPids fix** (2026-05-28)
    - **Bug**: Pressing `Cmd+Shift+C` in a Ghostty tab with no coding agent showed ✓ (success) instead of ✗ (error). Two root causes:
      1. Ghostty had no `ttyStrategy` — fell through to host-process-tree which walks ALL tabs/windows. If another tab had a coding agent in the same cwd, it was incorrectly matched.
      2. `findHostPids` used `ps -eo pid=,comm=` which shows only the executable basename (e.g. `Ghostty`), but the grep pattern looked for `Ghostty\\.app/`. This failed on macOS where `comm=` doesn't include the .app bundle path.
    - **Fixes applied**:
      - Added `ttyStrategy: 'ghostty'` to Ghostty HOST_DEFINITIONS — queries tty via AppleScript (`tty of focused terminal of selected tab of front window`)
      - Added Ghostty tty handler in `getTerminalTty()` — returns the tty device path for the focused terminal
      - Changed `findHostPids` grep from `comm=` to `command=` — `command=` includes the full executable path with `.app/` bundle segment
      - Moved `usedFocusedTty = true` before `findProcessesOnTty` check — blocks host-process-tree fallback whenever tty is available, even if tty returns empty
      - Changed `focusedCwd` assignment from `tty ? '' : getFocusedWorkingDirectory(host)` to always call `getFocusedWorkingDirectory(host)` — cwd is now always populated for display and error messages
    - **Result**: Ghostty now uses tty-based process isolation (same as iTerm2/Terminal.app). Only processes on the focused tab's tty are considered. Cross-tab cwd matches no longer cause false positives. `findHostPids` now reliably finds .app processes on all macOS versions.

### Decisions Made

1. Support Ghostty + iTerm2 + Terminal.app (not Ghostty-only).
2. `Cmd+Shift+C` never silently falls back to latest session.
3. Unsupported contexts fail with notification; manual selection remains in UI.
4. IDE hosts (VS Code, Cursor, Windsurf, JetBrains) are registered as supported hosts
   so process-tree agent detection works. Error messages distinguish IDE ("No coding
   agent detected in IDE") from terminal ("No supported coding agent in focused terminal").
5. `isCodingAgentProcess` uses `\bcodex\s+app-server\b` to filter extension processes.
   The old alternation `\bapp-server\b|--listen\s+stdio://` was too broad and could
   theoretically match unrelated app-server arguments.
6. IDE hosts use Accessibility (System Events) to read window titles when permission
   is granted. The window title workspace name filters agent cwds by basename match,
   resolving multi-window ambiguity. When permission is denied, the context includes
   `accessibilityDenied: true` so the UI/Electron layer can guide the user to enable it.
7. `extractWorkspaceFromWindowTitle` handles JetBrains differently from Electron IDEs:
   JetBrains project is the first title segment; Electron IDEs (VS Code/Cursor/Windsurf)
   use the last non-file-like segment (right-to-left scan, skipping file extensions).
8. Ghostty now uses tty-based process isolation (`ttyStrategy: 'ghostty'`) instead of
   falling through to host-process-tree. `usedFocusedTty` is set true whenever tty is
   available, blocking the host-process-tree fallback and preventing cross-tab false
   matches. `findHostPids` uses `command=` (full path) instead of `comm=` (basename only)
   for reliable .app bundle detection across macOS versions.

## Open Questions

- ~~Do we want to add a permission-bootstrap flow in the Electron tray/app that prompts
  the user to grant Accessibility access to VibeSync (or their terminal) for IDE window
  title detection?~~ **Resolved 2026-05-29:** the React debug panel detects
  `accessibilityDenied` (via the new `checkAccessibility` IPC) and surfaces a
  "Grant Accessibility Access" button that calls `systemPreferences.isTrustedAccessibilityClient(true)`.
  IDE-host hotkey notifications now also recommend granting access.
- Do we want to add an in-app picker for unsupported or unmatched terminal/IDE contexts?
  (Tracked in pre-release-checklist Post-v1; not blocking initial release.)

Recommended defaults:

- Do not silently fall back to latest for `Cmd+Shift+C`.
- Keep unsupported or unmatched resolution in the UI, not in the global shortcut.
- IDE hosts work best-effort without Accessibility; with it, multi-window disambiguation
  becomes reliable via window title → workspace name matching.
