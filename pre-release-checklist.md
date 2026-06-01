# VibeSync Pre-Release Checklist

Last updated: 2026-05-29

## Release Goal

Ship a macOS-only local coding-agent handoff utility.

Core promise:

1. User works in a supported terminal or IDE terminal.
2. User presses `Cmd+Shift+C`.
3. VibeSync detects the focused host, resolves the active local coding agent session, and copies a takeover prompt.
4. If anything cannot be resolved, VibeSync fails visibly and never copies a random/latest session.

Supported agents for v1:

- Claude Code
- Codex
- Antigravity CLI
- OpenCode

Supported hosts for v1:

- Ghostty
- iTerm2
- Terminal.app
- VS Code
- Cursor
- Windsurf
- JetBrains IDEs

## Current Status

Implemented:

- [x] 4-agent backend parser and session detail API.
- [x] `takeover_prompt` is now the primary handoff artifact.
- [x] Agent-scoped `/api/takeover/resolve`.
- [x] Electron auto-starts backend and exposes backend URL through preload.
- [x] `contextIsolation: true`, `nodeIntegration: false`.
- [x] Focused host detector and process-tree agent resolver.
- [x] `Cmd+Shift+C` copies the focused terminal session takeover prompt.
- [x] Manual Session Manager picker remains available.
- [x] Tray/menu-bar feedback now changes immediately on hotkey trigger:
  - busy while resolving
  - check on success
  - x on failure
  - resets after 2 seconds
- [x] Vite dev server now uses strict port `5173` to avoid Electron loading a stale dev server.
- [x] File logger writes to `~/Library/Logs/VibeSync/vibesync.log` with size-based
  rotation; tray menu and debug panel both expose "Open Logs Folder".
- [x] `lastHotkeyEvent` diagnostics: tray menu `Show Last Hotkey Result` dialog
  and live-updating debug panel show host, cwd, command, agent, and result.
- [x] Accessibility permission bootstrap: debug panel detects `accessibilityDenied`
  and offers a `Grant Accessibility Access` button that drives
  `systemPreferences.isTrustedAccessibilityClient(true)`.
- [x] Clipboard sentinel safety tests cover all 8 known failure paths plus the
  positive control. Pre-existing clipboard contents are never overwritten on
  failure.
- [x] Backend integration smoke test spawns the real `python3 backend/app.py`
  on an ephemeral port and asserts `/api/health`, `/api/sessions`, and
  `/api/takeover/resolve` respond as documented.
- [x] Root `.gitignore` covers Node, Python, editor, OS, and Electron-builder
  output. Root `.gitattributes` enforces consistent text/binary handling.

Latest verification run:

- [x] `cd frontend && npm run lint`
- [x] `cd frontend && npm run test`  *(40 tests passing)*
- [x] `cd frontend && npm run build`
- [x] `python3 -m unittest discover backend/tests`  *(20 tests passing)*

## Blocking Before Public Release

### 1. Clean Dev Runtime State

- [ ] Ensure no stale VibeSync dev processes are left running before packaging:
  - `lsof -nP -iTCP:5173 -sTCP:LISTEN`
  - `lsof -nP -iTCP:8765 -sTCP:LISTEN`
  - `ps -eo pid=,ppid=,command= | rg 'vibesync|vite|backend/app.py|Electron.*frontend'`
- [ ] Confirm `npm run desktop` fails clearly if `5173` is occupied.
- [ ] Confirm Electron loads the intended dev server URL, not an older Vite instance.

### 2. Manual Hotkey QA Matrix

Run these manually on a real macOS desktop session. Automated keyboard simulation can be blocked by macOS Accessibility, so human keypress QA is required.

- [ ] Ghostty + Claude Code + matching workspace -> `Cmd+Shift+C` copies Claude takeover prompt.
- [ ] Ghostty + Antigravity CLI + matching workspace -> copies Antigravity takeover prompt.
- [ ] iTerm2 + Claude Code -> copies matching takeover prompt.
- [ ] Terminal.app + Codex -> copies matching takeover prompt.
- [ ] VS Code integrated terminal + supported agent -> copies matching takeover prompt.
- [ ] Cursor integrated terminal + supported agent -> copies matching takeover prompt.
- [ ] Unsupported app focused -> tray shows failure quickly, clipboard is not overwritten with a latest-session fallback.
- [ ] Supported terminal with only shell/no agent -> tray shows failure quickly, clipboard is not overwritten.
- [ ] Backend unavailable -> tray shows failure quickly and notification explains backend issue.
- [ ] Multiple matching sessions -> no clipboard write; user is told to use VibeSync UI.

For every successful case, paste the clipboard into a scratch buffer and confirm:

- `Source agent` matches the actual CLI.
- `Workspace` matches the focused terminal project.
- `Source transcript` points to the expected local session file.
- `Reading protocol` is present.

### 3. Clipboard Safety

- [x] Automated sentinel coverage in `frontend/tests/clipboard-sentinel.test.cjs`:
  - host error, missing cwd, unsupported command
  - backend 404 no-match, 409 ambiguous, 5xx
  - missing `takeover_prompt` in details payload
  - details fetch failure
  - positive control verifies the mock clipboard mutates on success
- [ ] Manual sentinel verification before tagging the release:
  1. Put `VIBESYNC_SENTINEL` in clipboard.
  2. Focus unsupported app.
  3. Press `Cmd+Shift+C`.
  4. Confirm clipboard still contains `VIBESYNC_SENTINEL`.
- [ ] Repeat manual sentinel test for:
  - unsupported command
  - missing cwd
  - backend 404 no-match
  - backend 409 ambiguous-match

This is a release blocker because the product must not copy the wrong session.

### 4. Notifications And Tray Feedback

- [ ] Confirm tray icon state changes with low latency:
  - default -> busy immediately after hotkey
  - busy -> check/x immediately after completion
  - check/x -> default after ~2 seconds
- [ ] Confirm macOS native notifications appear when notifications are allowed.
- [ ] Confirm tray feedback still works when native notifications are disabled.
- [ ] Confirm tray icon has no white square background on light and dark menu bars.

### 5. Accessibility Permission Flow

Implemented 2026-05-29 (Option A):

- [x] When the debug panel mounts in Electron, it calls `vibesync.checkAccessibility()`
  via preload. If the result is `{ trusted: false }`, an in-panel notice
  appears with a `Grant Accessibility Access` button.
- [x] The button invokes `systemPreferences.isTrustedAccessibilityClient(true)`,
  which triggers the macOS system prompt the first time and silently confirms
  trust on subsequent calls.
- [x] `accessibilityDenied` is shown in the "Detected terminal" debug rows so
  the user can correlate IDE detection failures with permission state.
- [x] README troubleshooting section documents the permission requirement.
- [ ] (Optional polish) Add a one-shot tray notification on the very first
  IDE-host hotkey if `accessibilityDenied` is true.

### 6. Packaged App QA

- [ ] Run `cd frontend && npm run build:desktop`.
- [ ] Launch the generated `.app` from `frontend/dist/mac*` or builder output.
- [ ] Confirm packaged app starts backend from bundled `extraResources`.
- [ ] Confirm packaged app does not depend on Vite.
- [ ] Confirm `Cmd+Shift+C` works in packaged app.
- [ ] Confirm tray icon images are included in packaged app.
- [ ] Confirm agent icons and app icon are included.
- [ ] Run `cd frontend && npm run package:zip`.
- [ ] Install from the zip on a clean macOS user account or separate machine if possible.

### 7. Repository Hygiene

- [x] Root `.gitignore` covers:
  - `node_modules/`
  - `frontend/dist/`, `frontend/out/`
  - `frontend/.vite/`
  - `__pycache__/`
  - `.DS_Store`
  - `*.log`
  - local screenshots/temp artifacts
- [x] Root `LICENSE` (MIT) committed.
- [x] Root `.gitattributes` with `* text=auto` plus per-extension overrides.
- [ ] Decide whether generated assets belong in git:
  - app icon (kept — referenced by README)
  - tray template icons (kept — bundled into .app)
  - agent icons (kept — referenced by UI)
  - packaged artifacts (zip/dmg) should not be committed — covered by `.gitignore`
- [x] Vite/React template leftovers removed (`frontend/README.md`,
  `src/assets/{hero.png,react.svg,vite.svg}`, `public/icons.svg`).

### 8. README Rewrite

The README should be release-ready before GitHub publication.

Required sections:

- [ ] What VibeSync does.
- [ ] Demo workflow:
  - start Claude/Codex/etc. in terminal A
  - press `Cmd+Shift+C`
  - paste into another local coding agent in terminal B
- [ ] Supported agents.
- [ ] Supported terminal and IDE hosts.
- [ ] macOS-only requirement.
- [ ] Installation from release zip.
- [ ] Development setup:
  - backend tests
  - frontend tests
  - `npm run desktop`
- [ ] Permissions and troubleshooting:
  - global shortcut conflict
  - notification permissions
  - Accessibility for IDE detection
  - backend port conflicts
  - no matching session found
- [ ] Security note:
  - local-only backend on `127.0.0.1`
  - transcript paths are local
  - no web-agent/cloud upload handoff

## Should Fix Before v1 If Time Allows

### 9. Hotkey Diagnostics Panel

Implemented 2026-05-29.

- [x] `lastHotkeyEvent` state tracked in `main-electron.cjs`:
  - timestamp (started/completed)
  - host + hostKind
  - cwd, command
  - matched agent/sessionId/project
  - result (`ok`) and reason
  - accessibilityDenied flag
- [x] Exposed via preload: `vibesync.getLastHotkeyEvent()` and live
  `vibesync.onHotkeyEvent(callback)`.
- [x] Shown in Session Manager debug panel (collapsible).
- [x] Tray menu item: `Show Last Hotkey Result` opens a `dialog.showMessageBox`
  with the full payload.

### 10. Better Error Copy

- [ ] Replace generic backend errors with user-facing categories:
  - shortcut not registered
  - unsupported focused app
  - supported host but no coding agent process
  - cwd unavailable
  - no matching session
  - multiple matching sessions
  - transcript unreadable
  - backend unavailable
- [ ] Keep developer details in logs, not in main notification text.

### 11. Electron Logs

Implemented 2026-05-29.

- [x] File logger at `frontend/logger.cjs` writes to
  `~/Library/Logs/VibeSync/vibesync.log` with 2 MB size-based rotation
  (`vibesync.log.1`).
- [x] Three named channels — `main`, `backend`, `hotkey` — surface in the log
  prefix. Errors include stack traces.
- [x] All `console.*` calls in `main-electron.cjs` migrated to the structured
  logger. Backend stdout/stderr is captured into the `backend` channel.
- [x] Tray menu item: `Open Logs Folder` and debug-panel button both call
  `shell.openPath(logger.getLogDir())`.
- [x] `VIBESYNC_LOG_QUIET=1` silences the console mirror so test runs and
  headless environments are not noisy.

### 12. UI Polish

- [ ] Hide or collapse the debug panel by default.
- [ ] Make dashboard window resizable or at least more tolerant of 13" MacBook screens.
- [ ] Clamp tray window positioning to the active display bounds.
- [ ] Verify layout at:
  - 1280 x 800
  - 1440 x 900
  - 1728 x 1117
  - external monitor with menu bar.
- [ ] Confirm long session titles do not visually imply the wrong agent.

### 13. Session List Scale

- [ ] Add pagination or “show more”; current list can hide older sessions if parser limit is too low.
- [ ] Show counts by agent.
- [ ] Add empty states per agent:
  - no Claude sessions found
  - no Codex sessions found
  - no OpenCode data directory found

## Post-v1

- [ ] In-app candidate picker when backend returns ambiguous `409`.
- [ ] User preferences:
  - launch at login
  - default dashboard visibility
  - remembered filter/search
  - notification preference
- [ ] Search inside transcript previews.
- [ ] More terminal hosts.
- [ ] Windows/Linux research.
- [ ] GitHub Actions:
  - backend tests
  - frontend tests
  - build on macOS runner
  - release zip on tag.
- [ ] TypeScript or JSDoc type pass for Electron modules.

## Test Coverage Summary

Current automated coverage (all passing):

| Layer | Tests | Status |
| --- | ---: | --- |
| Backend parser | 15 | Pass |
| Backend app / resolve helpers | 4 | Pass |
| Backend HTTP smoke (subprocess + curl) | 1 | Pass |
| Frontend terminal-context | 19 | Pass |
| Frontend hotkey-sync | 9 | Pass |
| Frontend clipboard sentinel | 9 | Pass |
| Frontend logger (rotation, error stacks) | 3 | Pass |
| React UI components | 0 | Manual only |
| Electron main runtime | 0 | Manual only |
| **Total automated** | **60** | **All pass** |

Required before public release:

- [x] All existing automated tests pass.
- [x] Scripted integration check that starts backend and calls `/api/health`
  (covered by `backend/tests/test_smoke.py`).
- [ ] Keep manual hotkey QA results in release notes or `testing-guide.md`.

## Release Command Checklist

From a clean working tree:

```bash
python3 -m unittest discover backend/tests
cd frontend
npm install
npm run lint
npm run test
npm run build
npm run build:desktop
npm run package:zip
```

Manual after packaging:

- [ ] Open packaged app.
- [ ] Confirm tray icon appears.
- [ ] Confirm backend starts.
- [ ] Confirm `Cmd+Shift+C` works from a real supported terminal.
- [ ] Confirm failure states are visible and do not overwrite clipboard.

