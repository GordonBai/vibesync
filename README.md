# VibeSync - Local Coding Agent Takeover

VibeSync helps local coding agents hand work to each other without relying on lossy summaries. It locates session transcripts from Claude Code, Codex, Antigravity CLI, and OpenCode, then generates a takeover prompt that tells the next local agent which workspace and transcript to read.

Built with a zero-dependency Python backend and a React dashboard wrapped in macOS Electron, VibeSync extracts workspace paths, transcript paths, local git status, command hints, touched files, and conversation previews so the next agent can reconstruct context from the original source.

---

## Features
1. **macOS Menu Bar App**: Opens a compact Session Manager from the status bar.
2. **Focused Terminal Hotkey (`Cmd + Shift + C`)**: Copies the takeover prompt for the supported coding agent running in the currently focused terminal.
3. **Four-Agent Session Index**: Displays local sessions for Claude Code, Codex, Antigravity CLI, and OpenCode.
4. **Manual Session Picker**: Lets you search, filter by agent, inspect details, and copy the exact takeover prompt from the dashboard.
5. **Transcript Path Handoff**: Points the next local agent to the exact source session file instead of relying on a compressed summary.
6. **Repo Hints**: Shows git branch/status, command hints, touched files, and a conversation preview.

---

## Getting Started

### Step 1: Run Backend Server
The backend requires Python 3 and starts on port `8765`:

```bash
python3 backend/app.py
```

### Step 2: Run the macOS Desktop App
In a new terminal window, start the Electron app:

```bash
cd frontend
npm run desktop
```

> 💡 **Tip (Network Issue / fetch failed):** If you see `Error: Electron failed to install correctly` or download timeouts, run:
> ```bash
> ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install electron
> ```

You should see a status bar icon. Click it to open the Session Manager.

---

## How to Use the Hotkey

The hotkey is intentionally terminal-aware. It does not copy the latest session as a fallback.

1. Work in a supported terminal app with Claude Code, Codex, Antigravity CLI, or OpenCode running.
2. Press `Command + Shift + C`.
3. VibeSync detects the focused terminal, its working directory, and the active coding agent command.
4. If VibeSync can match that context to a local session, it copies the takeover prompt and shows a notification.
5. Paste into another local coding agent to continue from the transcript and workspace.

If the focused app is not a supported terminal, no supported coding agent is detected, or no session matches the terminal cwd, VibeSync shows a notification and does not copy a guessed prompt. Use the dashboard picker in that case.

Supported host detection currently targets Ghostty, iTerm2, Terminal.app, VS Code, Cursor, Windsurf, and common JetBrains IDEs. iTerm2 and Terminal.app use focused-tty detection first. Ghostty uses its AppleScript focused terminal working directory, then filters recursive process-tree matches to that cwd. IDE hosts use recursive process-tree detection and only succeed when exactly one supported coding agent context can be proven.

### Hotkey Diagnostics

To inspect what the hotkey would do without writing to the clipboard:

```bash
cd frontend
npm run diagnose:hotkey
```

Run it while a terminal or IDE is focused. It prints the detected host/cwd/agent, resolve result, and notification events. Add `-- --copy` to write the resolved takeover prompt to the macOS clipboard through the same hotkey flow.
