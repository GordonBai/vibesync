const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vibesync', {
  detectTerminal: () => ipcRenderer.invoke('detect-terminal'),
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),
  getBackendStatus: () => ipcRenderer.invoke('get-backend-status'),
  getLastHotkeyEvent: () => ipcRenderer.invoke('get-last-hotkey-event'),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  requestAccessibility: () => ipcRenderer.invoke('request-accessibility'),
  checkAccessibility: () => ipcRenderer.invoke('check-accessibility'),
  onBackendStatusChange: (callback) => {
    ipcRenderer.on('backend-status-changed', (_event, status) => callback(status));
  },
  onHotkeyEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('hotkey-event', listener);
    return () => ipcRenderer.removeListener('hotkey-event', listener);
  },
});
