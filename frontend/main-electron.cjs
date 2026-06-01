const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, Notification, nativeImage, ipcMain, shell, systemPreferences, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const { getFocusedTerminalContext } = require('./terminal-context.cjs');
const { syncFocusedTerminalContextToClipboard: syncHotkeyContextToClipboard } = require('./hotkey-sync.cjs');
const logger = require('./logger.cjs');

const mainLog = logger.main;
const backendLog = logger.backend;
const hotkeyLog = logger.hotkey;

let tray = null;
let window = null;
let contextMenu = null;
let trayFeedbackTimer = null;
let backendProcess = null;
let backendPort = 8765;
let backendReady = false;
let trayUsesTitleFallback = false;
let trayImages = {};
let lastHotkeyEvent = null;

const TRAY_READY = ' ⚡ ';
const TRAY_BUSY = ' … ';
const TRAY_SUCCESS = ' ✓ ';
const TRAY_ERROR = ' ✗ ';
const DEFAULT_TOOLTIP = 'VibeSync - Premium Context Sync';
const FEEDBACK_DURATION_MS = 2000;
const BACKEND_START_PORT = 8765;
const BACKEND_MAX_PORT = 8770;
const HEALTH_CHECK_INTERVAL_MS = 500;
const HEALTH_CHECK_TIMEOUT_MS = 10000;
const TRAY_STATUS = {
  ready: 'ready',
  busy: 'busy',
  success: 'success',
  error: 'error',
};
const TRAY_TITLE_BY_STATUS = {
  [TRAY_STATUS.ready]: TRAY_READY,
  [TRAY_STATUS.busy]: TRAY_BUSY,
  [TRAY_STATUS.success]: TRAY_SUCCESS,
  [TRAY_STATUS.error]: TRAY_ERROR,
};
const TRAY_IMAGE_BY_STATUS = {
  [TRAY_STATUS.ready]: 'tray-iconTemplate.png',
  [TRAY_STATUS.busy]: 'tray-busyTemplate.png',
  [TRAY_STATUS.success]: 'tray-successTemplate.png',
  [TRAY_STATUS.error]: 'tray-errorTemplate.png',
};

const isDev = process.argv.includes('--dev');

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  killBackend();
});

if (process.platform === 'darwin') {
  app.dock.hide();
}

// ── Backend lifecycle ──────────────────────────────────────────────────────

function resolveBackendPath() {
  if (isDev) {
    return path.join(__dirname, '..', 'backend', 'app.py');
  }
  return path.join(process.resourcesPath, 'backend', 'app.py');
}

function findAvailablePort(start, max) {
  return new Promise((resolve) => {
    function tryPort(port) {
      if (port > max) {
        resolve(null);
        return;
      }
      const server = http.createServer();
      server.listen(port, '127.0.0.1', () => {
        server.close(() => {
          resolve(port);
        });
      });
      server.on('error', () => {
        tryPort(port + 1);
      });
    }
    tryPort(start);
  });
}

function healthCheck(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.status === 'healthy');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function killBackend() {
  if (!backendProcess) return;
  try {
    backendProcess.kill('SIGTERM');
    const forceTimeout = setTimeout(() => {
      try { backendProcess.kill('SIGKILL'); } catch {}
    }, 3000);
    backendProcess.on('close', () => {
      clearTimeout(forceTimeout);
    });
  } catch {}
  backendProcess = null;
  backendReady = false;
}

async function startBackend() {
  const port = await findAvailablePort(BACKEND_START_PORT, BACKEND_MAX_PORT);
  if (!port) {
    mainLog.error('No available port found for backend');
    return false;
  }
  backendPort = port;
  if (port !== BACKEND_START_PORT) {
    mainLog.info(`Port ${BACKEND_START_PORT} in use, using ${port}`);
  }

  const backendPath = resolveBackendPath();
  mainLog.info(`Starting backend: python3 ${backendPath} --port ${backendPort}`);

  backendProcess = spawn('python3', [backendPath, '--port', String(backendPort)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  backendProcess.stdout.on('data', (data) => {
    backendLog.info(data.toString().trim());
  });
  backendProcess.stderr.on('data', (data) => {
    backendLog.error(data.toString().trim());
  });
  backendProcess.on('close', (code) => {
    mainLog.info(`Backend exited with code ${code}`);
    backendReady = false;
    backendProcess = null;
    updateTrayTooltip();
  });
  backendProcess.on('error', (err) => {
    mainLog.error('Failed to start backend:', err.message);
    backendReady = false;
    backendProcess = null;
    updateTrayTooltip();
  });

  // Wait for backend health
  const startTime = Date.now();
  while (Date.now() - startTime < HEALTH_CHECK_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
    if (await healthCheck(backendPort)) {
      backendReady = true;
      mainLog.info(`Backend healthy on port ${backendPort}`);
      updateTrayTooltip();
      return true;
    }
  }

  mainLog.error('Backend did not become healthy within timeout');
  updateTrayTooltip();
  return false;
}

function getBackendUrl() {
  return `http://127.0.0.1:${backendPort}`;
}

function updateTrayTooltip() {
  if (!tray) return;
  if (backendReady) {
    tray.setToolTip(`${DEFAULT_TOOLTIP} · backend running`);
  } else if (backendProcess) {
    tray.setToolTip(`${DEFAULT_TOOLTIP} · backend starting...`);
  } else {
    tray.setToolTip(`${DEFAULT_TOOLTIP} · backend stopped`);
  }
}

// ── Window & tray ──────────────────────────────────────────────────────────

function createWindow() {
  window = new BrowserWindow({
    width: 1180,
    height: 768,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    }
  });

  if (isDev) {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    mainLog.info('⚡ Running in DEV mode, loading dev server:', devServerUrl);
    window.loadURL(devServerUrl);
  } else {
    const indexPath = path.join(__dirname, 'dist', 'index.html');
    mainLog.info('📦 Running in PRODUCTION mode, loading built files from:', indexPath);
    window.loadFile(indexPath).catch(err => {
      mainLog.error('Failed to load production index.html. Did you run "npm run build"?', err);
    });
  }

  window.on('blur', () => {
    window.hide();
  });

  window.on('closed', () => {
    window = null;
  });
}

function createTray() {
  try {
    trayImages = loadTrayImages();
    tray = new Tray(trayImages[TRAY_STATUS.ready]);
    trayUsesTitleFallback = false;
    mainLog.info('Tray status icons loaded from', path.join(__dirname, 'public'));
  } catch (err) {
    mainLog.warn('Failed to load status bar icon image, using empty fallback:', err);
    const emptyImage = nativeImage.createEmpty();
    tray = new Tray(emptyImage);
    trayUsesTitleFallback = true;
  }

  if (process.platform === 'darwin') {
    tray.setTitle(trayUsesTitleFallback ? TRAY_READY : '');
  }

  tray.setToolTip(DEFAULT_TOOLTIP);

  contextMenu = Menu.buildFromTemplate([
    {
      label: 'Toggle Dashboard',
      click: () => toggleWindow()
    },
    {
      label: 'Sync Context Now',
      accelerator: 'CommandOrControl+Shift+C',
      click: () => syncFocusedTerminalContextToClipboard()
    },
    { type: 'separator' },
    {
      label: 'Show Last Hotkey Result',
      click: () => showLastHotkeyResultDialog()
    },
    {
      label: 'Open Logs Folder',
      click: () => shell.openPath(logger.getLogDir())
    },
    { type: 'separator' },
    {
      label: 'Quit VibeSync',
      role: 'quit',
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.on('click', () => {
    toggleWindow();
  });

  tray.on('right-click', () => {
    tray.popUpContextMenu(contextMenu);
  });
}

function loadTrayImages() {
  return Object.fromEntries(
    Object.entries(TRAY_IMAGE_BY_STATUS).map(([status, fileName]) => {
      const iconPath = path.join(__dirname, 'public', fileName);
      const image = nativeImage.createFromPath(iconPath);
      if (image.isEmpty()) {
        throw new Error(`Tray icon is empty: ${iconPath}`);
      }
      image.setTemplateImage(true);
      return [status, image];
    })
  );
}

function toggleWindow() {
  if (!window) return;

  if (window.isVisible()) {
    window.hide();
  } else {
    alignWindowWithTray();
    window.show();
    window.focus();
  }
}

function alignWindowWithTray() {
  const trayBounds = tray.getBounds();
  const windowBounds = window.getBounds();

  const x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
  const y = Math.round(trayBounds.y + trayBounds.height + 4);

  window.setPosition(x, y, false);
}

async function syncFocusedTerminalContextToClipboard() {
  // Initialize the event record before the resolver runs so we capture the
  // start timestamp even if the flow throws synchronously inside the host
  // detector. capturedContext gets populated by the wrapped getter below.
  const startedAt = new Date().toISOString();
  let capturedContext = null;

  hotkeyLog.info('hotkey triggered');

  const result = await syncHotkeyContextToClipboard({
    backendUrl: getBackendUrl(),
    getFocusedTerminalContext: async () => {
      capturedContext = await getFocusedTerminalContext();
      return capturedContext;
    },
    fetchImpl: fetch,
    writeClipboard: (text) => clipboard.writeText(text),
    showTrayFeedback,
    showTrayProgress: (icon, tooltip) => showTrayFeedback(icon, tooltip, { reset: false }),
    showErrorNotification,
    notify: (options) => new Notification(options).show(),
    logger: hotkeyLog,
  });

  lastHotkeyEvent = {
    startedAt,
    completedAt: new Date().toISOString(),
    ok: result?.ok === true,
    reason: result?.reason || (result?.ok ? 'success' : 'unknown'),
    host: capturedContext?.terminalApp || null,
    hostKind: capturedContext?.hostKind || null,
    cwd: capturedContext?.cwd || null,
    command: capturedContext?.command || null,
    accessibilityDenied: capturedContext?.accessibilityDenied || false,
    agent: result?.agent || null,
    sessionId: result?.sessionId || null,
    project: result?.project || null,
  };

  hotkeyLog.info('hotkey result:', lastHotkeyEvent);
  notifyRendererOfHotkeyEvent();

  return result;
}

function notifyRendererOfHotkeyEvent() {
  const allWindows = BrowserWindow.getAllWindows();
  for (const w of allWindows) {
    try {
      w.webContents.send('hotkey-event', lastHotkeyEvent);
    } catch (err) {
      mainLog.warn('Failed to forward hotkey event to renderer:', err.message);
    }
  }
}

function showLastHotkeyResultDialog() {
  if (!lastHotkeyEvent) {
    dialog.showMessageBox({
      type: 'info',
      title: 'VibeSync — Last Hotkey Result',
      message: 'No hotkey activity recorded yet.',
      detail: 'Press Cmd+Shift+C in a supported terminal or IDE first.',
      buttons: ['OK'],
    });
    return;
  }

  const e = lastHotkeyEvent;
  const lines = [
    `Status: ${e.ok ? '✓ success' : '✗ failed'}`,
    `Reason: ${e.reason}`,
    `Started: ${e.startedAt}`,
    `Completed: ${e.completedAt}`,
    '',
    `Host: ${e.host || 'unknown'} (${e.hostKind || '?'})`,
    `Cwd: ${e.cwd || '(none)'}`,
    `Command: ${e.command || '(none)'}`,
  ];
  if (e.accessibilityDenied) {
    lines.push('', 'Accessibility: DENIED — IDE workspace detection is reduced.');
  }
  if (e.ok) {
    lines.push('', `Agent: ${e.agent}`, `Session: ${e.sessionId}`, `Project: ${e.project}`);
  }
  dialog.showMessageBox({
    type: e.ok ? 'info' : 'warning',
    title: 'VibeSync — Last Hotkey Result',
    message: e.ok ? 'Last hotkey copied a takeover prompt.' : 'Last hotkey did not copy.',
    detail: lines.join('\n'),
    buttons: ['OK'],
  });
}

function trayStatusFromIcon(icon) {
  if (icon === TRAY_BUSY) return TRAY_STATUS.busy;
  if (icon === TRAY_SUCCESS) return TRAY_STATUS.success;
  if (icon === TRAY_ERROR) return TRAY_STATUS.error;
  return TRAY_STATUS.ready;
}

function setTrayStatus(status) {
  if (!tray) return;
  if (process.platform === 'darwin' && trayUsesTitleFallback) {
    tray.setTitle(TRAY_TITLE_BY_STATUS[status] || TRAY_READY);
    return;
  }
  const image = trayImages[status] || trayImages[TRAY_STATUS.ready];
  if (image) {
    tray.setImage(image);
  }
}

function showTrayFeedback(icon, tooltip, options = {}) {
  if (!tray) return;
  const { reset = true, duration = FEEDBACK_DURATION_MS } = options;
  clearTimeout(trayFeedbackTimer);
  setTrayStatus(trayStatusFromIcon(icon));
  tray.setToolTip(tooltip);
  if (!reset) {
    trayFeedbackTimer = null;
    return;
  }
  trayFeedbackTimer = setTimeout(() => {
    setTrayStatus(TRAY_STATUS.ready);
    updateTrayTooltip();
    trayFeedbackTimer = null;
  }, duration);
}

function showErrorNotification(message) {
  new Notification({
    title: '❌ VibeSync Error',
    body: message
  }).show();
}

// ── Startup ────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  mainLog.info('VibeSync starting up. Logs at:', logger.getLogFilePath());
  await startBackend();

  createWindow();
  createTray();

  const shortcutString = 'CommandOrControl+Shift+C';
  const isRegistered = globalShortcut.register(shortcutString, () => {
    syncFocusedTerminalContextToClipboard();
  });

  if (isRegistered) {
    mainLog.info(`Registered global shortcut: ${shortcutString}`);
  } else {
    mainLog.warn(`Failed to register global shortcut: ${shortcutString}`);
    showErrorNotification(`${shortcutString} is already used by another app.`);
  }

  // IPC handlers
  ipcMain.handle('detect-terminal', async () => {
    return await getFocusedTerminalContext();
  });

  ipcMain.handle('get-backend-url', () => {
    return getBackendUrl();
  });

  ipcMain.handle('get-backend-status', () => {
    return { ready: backendReady, port: backendPort, url: getBackendUrl() };
  });

  ipcMain.handle('get-last-hotkey-event', () => {
    return lastHotkeyEvent;
  });

  ipcMain.handle('open-logs', () => {
    return shell.openPath(logger.getLogDir());
  });

  ipcMain.handle('request-accessibility', () => {
    if (process.platform !== 'darwin') {
      return { trusted: true, platform: process.platform };
    }
    // Pass `true` so macOS shows the system prompt the first time. On
    // subsequent calls when already trusted, returns true silently.
    const trusted = systemPreferences.isTrustedAccessibilityClient(true);
    mainLog.info('Accessibility trust check:', trusted ? 'granted' : 'denied');
    return { trusted, platform: 'darwin' };
  });

  ipcMain.handle('check-accessibility', () => {
    if (process.platform !== 'darwin') {
      return { trusted: true, platform: process.platform };
    }
    const trusted = systemPreferences.isTrustedAccessibilityClient(false);
    return { trusted, platform: 'darwin' };
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
