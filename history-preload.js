const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qiziHistory', {
  getContext: () => ipcRenderer.invoke('openclaw:history:context'),
  loadLocalMessages: (payload) => ipcRenderer.invoke('openclaw:history:read-local', payload),
  runMessageAction: (payload) => ipcRenderer.invoke('openclaw:history:message-action', payload),
  onRefresh: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('openclaw:history:refresh', handler);
    return () => ipcRenderer.removeListener('openclaw:history:refresh', handler);
  },
});
