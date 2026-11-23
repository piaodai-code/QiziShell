const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qiziLocalTime', {
  parts: (ms) => {
    try {
      return ipcRenderer.sendSync('qizi:local-time-parts', ms);
    } catch {
      return null;
    }
  },
});

contextBridge.exposeInMainWorld('automation', {
  list: () => ipcRenderer.invoke('automation:list'),
  run: (id) => ipcRenderer.invoke('automation:run', { id }),
});
