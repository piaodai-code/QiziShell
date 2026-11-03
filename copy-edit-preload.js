const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qiziCopyEdit', {
  getPayload: () => ipcRenderer.invoke('copy-edit:payload'),
  sendToAgent: (payload) => ipcRenderer.invoke('copy-edit:send', payload),
  stash: (draft) => ipcRenderer.invoke('copy-edit:stash', draft),
  discard: (payload) => ipcRenderer.invoke('copy-edit:discard', payload),
  onPayload: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('copy-edit:load', handler);
    return () => ipcRenderer.removeListener('copy-edit:load', handler);
  },
});
