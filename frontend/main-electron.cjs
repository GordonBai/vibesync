const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, Notification, nativeImage, ipcMain } = require('electron');
const path = require('path');
const { getFocusedTerminalContext } = require('./terminal-context.cjs');
const { syncFocusedTerminalContextToClipboard: syncHotkeyContextToClipboard } = require('./hotkey-sync.cjs');

let tray = null;
let window = null;
let contextMenu = null;
let trayFeedbackTimer = null;

const TRAY_READY = ' ⚡ ';
const TRAY_SUCCESS = ' ✓ ';
const TRAY_ERROR = ' ✗ ';
const DEFAULT_TOOLTIP = 'VibeSync - Premium Context Sync';
const FEEDBACK_DURATION_MS = 2000;

// Determine if we are running in Dev Mode (via command-line arguments)
const isDev = process.argv.includes('--dev');

// Clean up shortcut when app exits
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Avoid showing standard dock icon to keep it pure menu-bar widget style
if (process.platform === 'darwin') {
  app.dock.hide();
}

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
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  // Dual Load Routing:
  // If in Dev Mode, load Vite dev server.
  // Otherwise, load compiled production assets directly from files.
  if (isDev) {
    console.log('⚡ Running in DEV mode, loading dev server...');
    window.loadURL('http://localhost:5173');
  } else {
    const indexPath = path.join(__dirname, 'dist', 'index.html');
    console.log('📦 Running in PRODUCTION mode, loading built files from:', indexPath);
    window.loadFile(indexPath).catch(err => {
      console.error('Failed to load production index.html. Did you run "npm run build"?', err);
    });
  }

  // Hide the window when it loses focus
  window.on('blur', () => {
    window.hide();
  });

  window.on('closed', () => {
    window = null;
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'public', 'favicon.svg');
  
  try {
    tray = new Tray(iconPath);
  } catch (err) {
    console.warn('⚠️ Failed to load status bar icon image, using empty fallback...', err);
    const emptyImage = nativeImage.createEmpty();
    tray = new Tray(emptyImage);
  }
  
  if (process.platform === 'darwin') {
    tray.setTitle(TRAY_READY);
  }
  
  tray.setToolTip(DEFAULT_TOOLTIP);

  // Build high-fidelity Right-Click Context Menu
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

  // Support both left-click (toggle panel) and right-click (native context menu)
  tray.on('click', () => {
    toggleWindow();
  });

  tray.on('right-click', () => {
    tray.popUpContextMenu(contextMenu);
  });
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
  
  // Calculate center coordinates directly under the menu bar icon
  const x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
  const y = Math.round(trayBounds.y + trayBounds.height + 4);

  window.setPosition(x, y, false);
}

async function syncFocusedTerminalContextToClipboard() {
  return syncHotkeyContextToClipboard({
    getFocusedTerminalContext,
    fetchImpl: fetch,
    writeClipboard: (text) => clipboard.writeText(text),
    showTrayFeedback,
    showErrorNotification,
    notify: (options) => new Notification(options).show(),
    logger: console,
  });
}

function showTrayFeedback(icon, tooltip) {
  if (!tray) return;
  clearTimeout(trayFeedbackTimer);
  tray.setTitle(icon);
  tray.setToolTip(tooltip);
  trayFeedbackTimer = setTimeout(() => {
    tray.setTitle(TRAY_READY);
    tray.setToolTip(DEFAULT_TOOLTIP);
    trayFeedbackTimer = null;
  }, FEEDBACK_DURATION_MS);
}

function showErrorNotification(message) {
  new Notification({
    title: '❌ VibeSync Error',
    body: message
  }).show();
}

app.whenReady().then(() => {
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

  ipcMain.handle('detect-terminal', async () => {
    return await getFocusedTerminalContext();
  });
});

// Quit when all windows are closed, except on macOS where tray icon persists
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
