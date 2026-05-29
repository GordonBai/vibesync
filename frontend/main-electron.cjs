const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, Notification, nativeImage, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const { getFocusedTerminalContext } = require('./terminal-context.cjs');
const { syncFocusedTerminalContextToClipboard: syncHotkeyContextToClipboard } = require('./hotkey-sync.cjs');

let tray = null;
let window = null;
let contextMenu = null;
let trayFeedbackTimer = null;
let backendProcess = null;
let backendPort = 8765;
let backendReady = false;
let trayUsesTitleFallback = false;
let trayImages = {};

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
    console.error('No available port found for backend');
    return false;
  }
  backendPort = port;
  if (port !== BACKEND_START_PORT) {
    console.log(`Port ${BACKEND_START_PORT} in use, using ${port}`);
  }

  const backendPath = resolveBackendPath();
  console.log(`Starting backend: python3 ${backendPath} --port ${backendPort}`);

  backendProcess = spawn('python3', [backendPath, '--port', String(backendPort)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  backendProcess.stdout.on('data', (data) => {
    console.log(`[backend] ${data.toString().trim()}`);
  });
  backendProcess.stderr.on('data', (data) => {
    console.error(`[backend] ${data.toString().trim()}`);
  });
  backendProcess.on('close', (code) => {
    console.log(`Backend exited with code ${code}`);
    backendReady = false;
    backendProcess = null;
    updateTrayTooltip();
  });
  backendProcess.on('error', (err) => {
    console.error('Failed to start backend:', err.message);
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
      console.log(`Backend healthy on port ${backendPort}`);
      updateTrayTooltip();
      return true;
    }
  }

  console.error('Backend did not become healthy within timeout');
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
    console.log('⚡ Running in DEV mode, loading dev server:', devServerUrl);
    window.loadURL(devServerUrl);
  } else {
    const indexPath = path.join(__dirname, 'dist', 'index.html');
    console.log('📦 Running in PRODUCTION mode, loading built files from:', indexPath);
    window.loadFile(indexPath).catch(err => {
      console.error('Failed to load production index.html. Did you run "npm run build"?', err);
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
    console.log('Tray status icons loaded from', path.join(__dirname, 'public'));
  } catch (err) {
    console.warn('⚠️ Failed to load status bar icon image, using empty fallback...', err);
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
    {
      type: 'separator'
    },
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
  return syncHotkeyContextToClipboard({
    backendUrl: getBackendUrl(),
    getFocusedTerminalContext,
    fetchImpl: fetch,
    writeClipboard: (text) => clipboard.writeText(text),
    showTrayFeedback,
    showTrayProgress: (icon, tooltip) => showTrayFeedback(icon, tooltip, { reset: false }),
    showErrorNotification,
    notify: (options) => new Notification(options).show(),
    logger: console,
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
  await startBackend();

  createWindow();
  createTray();

  const shortcutString = 'CommandOrControl+Shift+C';
  const isRegistered = globalShortcut.register(shortcutString, () => {
    syncFocusedTerminalContextToClipboard();
  });

  if (isRegistered) {
    console.log(`Registered global shortcut: ${shortcutString}`);
  } else {
    console.warn(`Failed to register global shortcut: ${shortcutString}`);
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
