const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qiziCopyEdit', {
  getPayload: () => ipcRenderer.invoke('copy-edit:payload'),
  sendToAgent: (payload) => ipcRenderer.invoke('copy-edit:send', payload),
  stash: (draft) => ipcRenderer.invoke('copy-edit:stash', draft),
  discard: (payload) => ipcRenderer.invoke('copy-edit:discard', payload),
  setDirty: (dirty) => ipcRenderer.send('copy-edit:dirty', dirty === true),
  onCloseAction: (callback) => {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on('copy-edit:close-action', handler);
    return () => ipcRenderer.removeListener('copy-edit:close-action', handler);
  },
  closeActionResult: (ok) => ipcRenderer.send('copy-edit:close-action-result', ok === true),
  onPayload: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('copy-edit:load', handler);
    return () => ipcRenderer.removeListener('copy-edit:load', handler);
  },
});
