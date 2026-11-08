const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qiziAgentFiles', {
  getContext: () => ipcRenderer.invoke('agent-files:context'),
  listAgents: () => ipcRenderer.invoke('agent-files:agents'),
  switchAgent: (payload) => ipcRenderer.invoke('agent-files:switch', payload),
  list: () => ipcRenderer.invoke('agent-files:list'),
  read: (file) => ipcRenderer.invoke('agent-files:read', file),
  save: (payload) => ipcRenderer.invoke('agent-files:save', payload),
  setDirty: (dirty) => ipcRenderer.send('agent-files:dirty', dirty === true),
  onRequestSave: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('agent-files:request-save', handler);
    return () => ipcRenderer.removeListener('agent-files:request-save', handler);
  },
  saveResult: (ok) => ipcRenderer.send('agent-files:save-result', ok === true),
  onReload: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('agent-files:reload', handler);
    return () => ipcRenderer.removeListener('agent-files:reload', handler);
  },
});
