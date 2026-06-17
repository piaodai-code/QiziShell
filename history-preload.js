const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qiziHistory', {
  getContext: () => ipcRenderer.invoke('openclaw:history:context'),
  onRefresh: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('openclaw:history:refresh', handler);
    return () => ipcRenderer.removeListener('openclaw:history:refresh', handler);
  },
});
