const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vibesync', {
  detectTerminal: () => ipcRenderer.invoke('detect-terminal'),
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),
  getBackendStatus: () => ipcRenderer.invoke('get-backend-status'),
  onBackendStatusChange: (callback) => {
    ipcRenderer.on('backend-status-changed', (_event, status) => callback(status));
  },
});
