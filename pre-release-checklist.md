# VibeSync Pre-Release Checklist

## Architecture Overview

```
vibesync/
├── backend/
│   ├── app.py                # HTTP server (stdlib http.server, port 8765)
│   ├── parser.py             # 4-agent session index + resolve + takeover prompt
│   └── tests/                # 15 parser + 4 app tests (unittest)
├── frontend/
│   ├── main-electron.cjs     # Electron main: tray, window, globalShortcut, IPC
│   ├── terminal-context.cjs  # macOS host detection (3 terminals, 4 IDEs)
│   ├── hotkey-sync.cjs       # Hotkey flow (DI pattern, testable)
│   ├── diagnose-hotkey.cjs   # CLI dry-run diagnostic
│   ├── src/
│   │   ├── App.jsx           # React Session Manager UI
│   │   ├── App.css           # Session UI styles (flat dark theme)
│   │   ├── main.jsx          # React entry point
│   │   └── index.css         # Global styles (gradient premium theme)
│   └── tests/                # 20 terminal-context + 9 hotkey-sync tests
├── README.md
├── TODO.md
└── pre-release-checklist.md  # ← this file
```

### Data Flow

```
Cmd+Shift+C press
  → Electron globalShortcut
    → getFocusedTerminalContext()       [terminal-context.cjs]
      → AppleScript frontmost app
      → host definition lookup
      → tty / cwd-strategy / accessibility window title
      → process-tree walk + agent filter
      → returns { hostKind, cwd, command, confidence }
    → POST /api/takeover/resolve         [backend app.py]
      → resolve_session_for_context()    [parser.py]
      → agent-scoped cwd match
      → returns { session, reason, confidence }
    → GET /api/sessions/:agent/:id       [backend app.py]
      → get_session_details()            [parser.py]
      → generates takeover_prompt
      → returns { metadata, takeover_prompt, conversation, ... }
    → clipboard.writeText(takeover_prompt)
    → tray feedback + native notification
```

---

## BLOCKING (must fix before GitHub release)

### 1. Electron App Packaging (zip for GitHub Releases)

- [ ] **Electron production build**: `npm run desktop` currently uses Vite dev server + `--dev` flag. Users can't run this.
  - Add `"build:desktop": "vite build && electron-builder --dir"` to produce `.app` bundle without DMG
  - Add `"package:zip": "vite build && electron-builder --mac --publish=never"` to produce zip
  - Use `electron-builder` with config in `package.json`:
    ```json
    "build": {
      "appId": "com.vibesync.app",
      "productName": "VibeSync",
      "mac": { "target": "zip", "category": "public.app-category.developer-tools" },
      "files": ["dist/**/*", "main-electron.cjs", "terminal-context.cjs", "hotkey-sync.cjs", "public/**/*", "package.json"]
    }
    ```
  - Backend Python files don't go inside the .app bundle — they live in the repo. Document: "clone repo, `pip install`, then run VibeSync.app"
  - OR: bundle backend inside .app Resources and spawn from there
- [ ] **App icon**: Tray uses `public/favicon.svg` (tiny). Need proper `.icns` for Dock/About/Finder.
  - Generate 1024x1024 PNG → use `iconutil` or online converter → place at `build/icon.icns`
  - Configure in electron-builder: `"icon": "build/icon.icns"`
- [ ] **GitHub Release workflow**: Document manual release steps or add CI:
  - `npm run build && npm run package:zip`
  - Upload zip to GitHub Releases with tag `v1.0.0`
  - Attach README section: "Download → unzip → right-click Open (Gatekeeper warning on first launch)"

### 2. Backend Lifecycle Management

- [ ] **Auto-start backend from Electron**: User currently runs `python3 backend/app.py` in separate terminal.
  - Spawn `python3` child process from `main-electron.cjs` on `app.whenReady()`
  - Resolve backend path relative to app: `path.join(__dirname, '..', 'backend', 'app.py')`
  - Kill child on `will-quit` with SIGTERM, force kill after 3s timeout
  - Show backend status in tray tooltip: "VibeSync · backend running" / "VibeSync · backend stopped"
- [ ] **Backend health check**: Poll `/api/health` on startup every 500ms with 10s timeout.
  - Add `backendStatus` state in App.jsx: `starting | connected | error`
  - Show spinner + "Starting backend..." instead of empty "No Sessions Loaded"
  - If health check fails after 10s, show error with "The backend failed to start. Check that Python 3 is installed."
- [ ] **Port conflict handling**: If 8765 is taken, try 8766, 8767... up to 8770.
  - Pass selected port to Electron renderer via IPC so App.jsx uses correct `backendUrl`
  - Show notification: "Port 8765 in use, using 8766"

### 3. Error Resilience

- [ ] **Backend unreachable recovery**: Add auto-retry with backoff when backend connection drops.
  - App.jsx: show "Backend connection lost. Reconnecting..." banner at top
  - Retry every 2s, 4s, 8s, max 30s
  - Tray icon: green dot (connected) / yellow dot (connecting) / red dot (error > 30s)
- [ ] **Request timeouts**: All frontend `fetch` calls lack timeout.
  - Add `AbortController` with 8s timeout on every API call
  - On timeout, show "Request timed out — backend may be overloaded"

### 4. Security

- [ ] **`contextIsolation: true` + preload script**: Currently `false`, `nodeIntegration: true`.
  - Create `preload.cjs` with `contextBridge.exposeInMainWorld('vibesync', { detectTerminal: () => ipcRenderer.invoke('detect-terminal') })`
  - Set `contextIsolation: true`, `nodeIntegration: false`, `preload: path.join(__dirname, 'preload.cjs')`
  - App.jsx: replace `window.require('electron')` with `window.vibesync`
- [ ] **Backend bind address**: Already `127.0.0.1` (localhost only). Document this as intentional security boundary.

---

## HIGH PRIORITY (should fix before GitHub release)

### 5. GitHub-Ready Polish

- [ ] **README rewrite**: Current README is a Vite template. Needs full rewrite:
  - What VibeSync does (one-liner + 2-3 sentence description)
  - Supported coding agents (Claude Code, Codex, Antigravity, OpenCode)
  - Supported terminals/IDEs (Ghostty, iTerm2, Terminal.app, VS Code, Cursor, Windsurf, JetBrains)
  - Installation: `git clone` + `cd vibesync && pip install -r backend/requirements.txt && cd frontend && npm install`
  - Usage: `python3 backend/app.py` + run VibeSync.app, then `Cmd+Shift+C` in any supported terminal
  - Requirements: macOS 14+ (Sonoma), Python 3.10+, Node.js 20+
  - Screenshots section (placeholder — add after UI is final)
  - Link to GitHub Releases for downloading the `.app` zip
- [ ] **LICENSE file**: Add `LICENSE` (MIT) at repo root
- [ ] **`.gitignore` audit**: Ensure `node_modules/`, `dist/`, `__pycache__/`, `.env`, `*.log`, `out/` (electron-builder output) are ignored
- [ ] **`.gitattributes`**: Add `* text=auto` for consistent line endings across macOS/Windows clones
- [ ] **Remove dead assets before release**:
  - `public/icons.svg` — Bluesky, Discord, GitHub, X social icons, unused
  - `src/assets/hero.png`, `src/assets/react.svg`, `src/assets/vite.svg` — Vite template leftovers
  - `frontend/README.md` — Vite template boilerplate, replace with project-specific docs
- [ ] **Google Fonts offline**: `index.css` imports Inter, Outfit, Fira Code via `@import url()` — blocks render. Remove `@import` and use system font stack fallback (`system-ui, -apple-system` already in `var(--sans)`)

### 6. Accessibility Permission Flow

- [ ] **Electron permission prompt**: `accessibilityDenied` flag is returned from context but never acted upon
  - On first IDE host detection, if `accessibilityDenied: true`, show tray notification with "Enable Accessibility" button
  - Use `systemPreferences.isTrustedAccessibilityClient(true)` to trigger system dialog
  - Add setting to re-prompt if user dismissed
- [ ] **Debug panel permission indicator**: Show "Accessibility: Denied / Granted" in the debug output
- [ ] **Fallback messaging**: When Accessibility denied on IDE host, hotkey notification should add "Grant Accessibility for better IDE workspace detection"

### 7. UI Polish

- [ ] **Design system unification**: `index.css` uses gradient premium theme (Outfit/Inter fonts, purple/cyan/pink accents), `App.css` uses flat dark theme (`#1f1f22`, `#27272c`)
  - The two CSS files define completely different color schemes and visual languages
  - Pick one system and apply consistently throughout
  - The `index.css` system is more polished; migrate App.css to use its variables
- [ ] **Window resize**: Fixed 1180x768, `resizable: false`. On 13" MacBook (1440x900 effective), this is tight
  - Make window resizable or at minimum allow 100px height increase
  - Test on 13" / 14" / 16" MacBook screens
- [ ] **Debug panel visibility**: Debug panel is always shown when `ipcRenderer` exists (i.e., always in Electron). Should be hidden behind a flag or collapsed by default
  - Add "Debug" toggle in tray context menu
  - Or hold Option key to reveal
- [ ] **Window positioning**: `alignWindowWithTray()` uses `tray.getBounds()` which can be off-screen on multi-monitor setups or when menu bar is hidden
  - Add bounds checking: clamp x/y to visible screen area

### 8. Session Management Edge Cases

- [ ] **Session deletion**: No way to delete/forget a session from the UI
  - Add "Forget" button in session detail header (danger-action style)
  - Deleting transcript file is destructive — confirm dialog needed
- [ ] **Empty conversation display**: Shows "No conversation preview is available" — this is OK but could show the first/last prompt even without full history
- [ ] **Very large transcripts**: Content truncated at 4000 chars per turn. Add indicator showing "Showing first 4000 of N chars"
- [ ] **Session list pagination**: `list_all_sessions` limits to 20. If user has >20 sessions, older ones are invisible
  - Add "Show more" / pagination or load on scroll

### 9. Cross-Agent Edge Cases

- [ ] **Agent process dies mid-detection**: If `lsof` or `ps` runs on a PID that just exited, it fails silently (returns empty). The current code handles this gracefully but could add explicit PID liveness check
- [ ] **Same agent, two instances in different workspaces**: Currently triggers ambiguity error. Could show a quick picker in a small popup window from the tray
- [ ] **Agent not in `COMMAND_MAP`**: Falls through to raw command name. Should log warning for unknown agents so we can add them later

---

## MEDIUM PRIORITY (nice to have for v1.0)

### 10. Cross-Platform Foundation

- [ ] **Document macOS-only status**: README should clearly state "macOS only (Sonoma+)"
- [ ] **Platform guards in code**: `process.platform === 'darwin'` checks exist for tray/dock but not for terminal-context
  - Add early return in `getFocusedTerminalContext()` for non-macOS: `return { error: 'macOS required for terminal detection' }`
- [ ] **Windows/Linux research spike**: What would it take to add Windows Terminal / VS Code detection on Windows? WSL detection? Document as future work

### 11. Configuration & Persistence

- [ ] **User preferences file**: Store in `~/.vibesync/config.json` or Electron `app.getPath('userData')`
  - Backend port
  - Launch on login
  - Accessibility permission acknowledged
  - Last selected agent filter
- [ ] **Backend port configuration**: Currently hardcoded to 8765 in:
  - `hotkey-sync.cjs` → `DEFAULT_BACKEND_URL`
  - `App.jsx` → `backendUrl`
  - `diagnose-hotkey.cjs` → defaults to env var
  - Should be single source of truth (config file or env var)

### 12. Logging & Diagnostics

- [ ] **File logging**: Replace `console.log` with file-based logger in Electron main process
  - Log to `~/Library/Logs/VibeSync/` (macOS standard)
  - Log terminal detection attempts, resolve results, errors
- [ ] **In-app log viewer**: Add "View Logs" option in tray context menu or debug panel
- [ ] **Crash reporting**: At minimum, catch unhandled rejections and log stack traces

### 13. Code Quality

- [ ] **Run and fix linter**: `npm run lint` passes with 0 warnings
- [ ] **Add `.editorconfig`** for consistent formatting
- [ ] **Consider TypeScript migration path**: At minimum, add JSDoc types to `terminal-context.cjs` and `hotkey-sync.cjs`

### 14. Startup Experience

- [ ] **Launch on login**: Add `app.setLoginItemSettings({ openAtLogin: true })` with tray toggle
- [ ] **First-run experience**: If no sessions exist and no coding agents detected:
  - Show onboarding tooltip: "Start Claude Code, Codex, Antigravity CLI, or OpenCode in your terminal, then press Cmd+Shift+C"
  - Link to agent installation guides

---

## LOW PRIORITY (post v1.0)

### 15. Advanced Features

- [ ] **In-app session picker popup**: When ambiguity detected (409), show a small popup near the tray with candidate list instead of just notification
- [ ] **Session search across transcripts**: Search within conversation content, not just titles
- [ ] **Takeover prompt customization**: Let user choose what to include (git status, commands, files, full transcript vs. summary)
- [ ] **Multi-monitor support**: Test and fix window alignment on multi-monitor setups
- [ ] **Keyboard navigation**: Full keyboard accessibility for session list (arrow keys, Enter to select, Escape to close)
- [ ] **Agent process health indicator**: Show green/yellow dot in tray when supported agent is detected in active host

### 16. Docs & Community

- [ ] **Developer documentation**: How to add a new coding agent (registry entry, parser, tests)
- [ ] **Changelog**: `CHANGELOG.md` with semantic versioning
- [ ] **Screenshots in README**: Tray icon, Session Manager UI, notification examples
- [ ] **Troubleshooting guide**: Common issues (backend not running, accessibility denied, terminal not detected)

### 17. CI/CD

- [ ] **GitHub Actions**: Run `npm test` + `python3 -m unittest` on push
- [ ] **macOS runner**: Tests require macOS (AppleScript) — must use `macos-latest` or mock AppleScript calls
- [ ] **Automated build**: Build and zip Electron app on tag push, attach to GitHub Release

---

## Test Coverage Summary

| Layer | Tests | Status |
|-------|-------|--------|
| Backend parser | 15 | All pass |
| Backend app (resolve) | 4 | All pass |
| Frontend terminal-context | 20 | All pass |
| Frontend hotkey-sync | 9 | All pass |
| **Total** | **48** | **All pass** |

### Missing Test Coverage

- [ ] **Electron main process**: No tests for tray creation, window management, shortcut registration
  - These are hard to unit test (require Electron runtime) — at minimum add manual test script
- [ ] **End-to-end integration**: No test that spawns backend + runs diagnose-hotkey + verifies prompt content
  - `diagnose-hotkey.cjs` is the closest but not an automated test
- [ ] **App.jsx React components**: No component tests (React Testing Library or similar)
- [ ] **Backend HTTP server**: `test_app.py` tests `resolve_takeover_payload` directly but not the HTTP handler
  - Add `http.client` tests against a running server instance

---

## Manual QA Checklist

### Hotkey Smoke Test

- [ ] Ghostty + Claude Code → `Cmd+Shift+C` → takeover prompt copied, tray shows `✓`
- [ ] iTerm2 + Claude Code → `Cmd+Shift+C` → takeover prompt copied
- [ ] Terminal.app + Codex → `Cmd+Shift+C` → takeover prompt copied
- [ ] Ghostty + zsh (no agent) → `Cmd+Shift+C` → error notification, tray shows `✗`
- [ ] Unsupported app (Chrome, Finder) focused → `Cmd+Shift+C` → error notification
- [ ] Backend not running → `Cmd+Shift+C` → "Backend unreachable" notification

### IDE Smoke Test

- [ ] VS Code + integrated terminal with Claude Code → `Cmd+Shift+C` → takeover prompt copied
- [ ] VS Code + no agent running → `Cmd+Shift+C` → "No coding agent detected in IDE" notification
- [ ] VS Code + Accessibility granted → window title workspace used for cwd matching
- [ ] VS Code + Accessibility denied → `accessibilityDenied: true` in debug output, still works via process tree

### UI Smoke Test

- [ ] Tray icon appears on app launch
- [ ] Left-click tray → window appears, aligned below tray
- [ ] Click outside window → window hides
- [ ] Right-click tray → context menu (Toggle Dashboard, Sync Context Now, Quit)
- [ ] Session list loads all 4 agent types
- [ ] Agent filter dropdown filters correctly
- [ ] Search filters by title, project, agent name
- [ ] Click session → conversation preview loads
- [ ] Copy Takeover Prompt button works
- [ ] Copy Transcript Path button works
- [ ] Quick Copy button in session list works
- [ ] Debug "Detect Current Terminal" shows correct host/cwd/command
- [ ] Refresh button reloads session list
- [ ] Window closes cleanly (no process left behind)

### Backend Smoke Test

- [ ] `python3 backend/app.py` starts without errors
- [ ] `curl http://localhost:8765/api/health` returns `{"status": "healthy"}`
- [ ] `curl http://localhost:8765/api/sessions` returns session list
- [ ] `curl http://localhost:8765/api/sessions/claude/<sid>` returns details with takeover_prompt
- [ ] `curl -X POST http://localhost:8765/api/takeover/resolve -H 'Content-Type: application/json' -d '{"cwd":"/path","command":"claude"}'` returns 200 or 404
- [ ] Ctrl+C cleanly shuts down server

---

## Summary

| Category | Items | Blocking |
|----------|-------|----------|
| Packaging & Distribution | 4 | 4 |
| Backend Lifecycle | 3 | 3 |
| Error Resilience | 3 | 3 |
| Security Hardening | 2 | 2 |
| GitHub-Ready Polish | 6 | 0 |
| Accessibility Flow | 3 | 0 |
| UI Polish | 4 | 0 |
| Session Edge Cases | 4 | 0 |
| Cross-Agent Edge Cases | 3 | 0 |
| Cross-Platform | 3 | 0 |
| Configuration | 2 | 0 |
| Logging | 3 | 0 |
| Code Quality | 3 | 0 |
| Startup Experience | 2 | 0 |
| Advanced Features | 6 | 0 |
| Docs & Community | 4 | 0 |
| CI/CD | 3 | 0 |
| Test Coverage Gaps | 4 | 0 |
| Manual QA | 22 | 0 |

**Blocking items: 12**  
**High priority: 20**  
**Medium priority: 14**  
**Low priority: 16**  
**Total: 62 checklist items**
