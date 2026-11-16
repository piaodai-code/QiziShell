const { contextBridge, ipcRenderer } = require('electron');

function readSystemZoneSnapshot() {
  try {
    return ipcRenderer.sendSync('qizi:local-time-zone');
  } catch {
    return null;
  }
}

contextBridge.exposeInMainWorld('qiziLocalTime', {
  snapshot: readSystemZoneSnapshot(),
});

contextBridge.exposeInMainWorld('qiziHistory', {
  getContext: () => ipcRenderer.invoke('openclaw:history:context'),
  loadLocalMessages: (payload) => ipcRenderer.invoke('openclaw:history:read-local', payload),
  runMessageAction: (payload) => ipcRenderer.invoke('openclaw:history:message-action', payload),
  openCopyEdit: (payload) => ipcRenderer.invoke('copy-edit:open-from-history', payload),
  exportWord: (entries) => ipcRenderer.invoke('openclaw:export:word', { entries }),
  onRefresh: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('openclaw:history:refresh', handler);
    return () => ipcRenderer.removeListener('openclaw:history:refresh', handler);
  },
});
