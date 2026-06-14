const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qiziUpdate', {
  getCurrentVersion: () => ipcRenderer.invoke('qizi-update:version'),
  checkForUpdate: () => ipcRenderer.invoke('qizi-update:check'),
  installUpdate: () => ipcRenderer.invoke('qizi-update:install'),
  onDownloadProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('qizi-update:progress', handler);
    return () => ipcRenderer.removeListener('qizi-update:progress', handler);
  },
  onRecheck: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('qizi-update:recheck', handler);
    return () => ipcRenderer.removeListener('qizi-update:recheck', handler);
  },
});
