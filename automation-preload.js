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

contextBridge.exposeInMainWorld('automation', {
  list: () => ipcRenderer.invoke('automation:list'),
  run: (id) => ipcRenderer.invoke('automation:run', { id }),
});
