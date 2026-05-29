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

Latest verification run:

- [x] `cd frontend && npm run lint`
- [x] `cd frontend && npm run test`
- [x] `cd frontend && npm run build`
- [x] `python3 -m unittest discover backend/tests`

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

- [ ] Add or manually verify a sentinel clipboard test:
  1. Put `VIBESYNC_SENTINEL` in clipboard.
  2. Focus unsupported app.
  3. Press `Cmd+Shift+C`.
  4. Confirm clipboard still contains `VIBESYNC_SENTINEL`.
- [ ] Repeat sentinel test for:
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

Current state: IDE detection can work through process tree, but better workspace disambiguation may require Accessibility.

Before release, either implement a permission flow or document the limitation clearly.

- [ ] Decide v1 behavior:
  - Option A: implement permission prompt with `systemPreferences.isTrustedAccessibilityClient(true)`.
  - Option B: explicitly document that IDE workspace detection is best-effort unless Accessibility is granted.
- [ ] If Option A:
  - [ ] Show one-time prompt when IDE host returns `accessibilityDenied`.
  - [ ] Add debug output for Accessibility granted/denied.
  - [ ] Add troubleshooting copy for System Settings -> Privacy & Security -> Accessibility.
- [ ] If Option B:
  - [ ] Add README troubleshooting section.
  - [ ] Add in-app message when `accessibilityDenied` is true.

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

- [ ] Add or verify root `.gitignore` covers:
  - `node_modules/`
  - `frontend/dist/`
  - `frontend/out/`
  - `frontend/.vite/`
  - `__pycache__/`
  - `.DS_Store`
  - `*.log`
  - local screenshots/temp artifacts
- [ ] Add `LICENSE` before public release.
- [ ] Add `.gitattributes` with `* text=auto`.
- [ ] Decide whether generated assets belong in git:
  - app icon
  - tray template icons
  - agent icons
  - packaged artifacts should not be committed
- [ ] Remove or intentionally document obsolete/deleted Vite template files.

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

This is the most valuable next improvement.

- [ ] Add `lastHotkeyEvent` state in Electron main:
  - timestamp
  - stage
  - focused host
  - cwd
  - command
  - matched agent/session
  - result
  - error reason
- [ ] Expose it through preload IPC.
- [ ] Show it in Session Manager debug panel.
- [ ] Add tray menu item: `Show Last Hotkey Result`.

This will make future user reports much easier to debug than “I pressed the shortcut and nothing happened.”

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

- [ ] Add file logging under `~/Library/Logs/VibeSync/`.
- [ ] Log:
  - app startup
  - backend port chosen
  - shortcut registration result
  - each hotkey stage
  - resolver result
  - errors with stack traces
- [ ] Add tray menu item: `Open Logs`.

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

Current automated coverage:

| Layer | Tests | Status |
| --- | ---: | --- |
| Backend parser | 15 | Pass |
| Backend app / resolve helpers | 4 | Pass |
| Frontend terminal-context | 20 | Pass |
| Frontend hotkey-sync | 8+ | Pass |
| React UI | 0 | Manual only |
| Electron main runtime | 0 | Manual only |

Required before public release:

- [ ] Keep all existing automated tests passing.
- [ ] Add at least one scripted integration check that starts backend and calls `/api/health`.
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

