const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qiziAgentFiles', {
  getContext: () => ipcRenderer.invoke('agent-files:context'),
  list: () => ipcRenderer.invoke('agent-files:list'),
  read: (file) => ipcRenderer.invoke('agent-files:read', file),
  save: (payload) => ipcRenderer.invoke('agent-files:save', payload),
  setEditorPane: (open) => ipcRenderer.invoke('agent-files:editor-pane', open),
  onReload: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('agent-files:reload', handler);
    return () => ipcRenderer.removeListener('agent-files:reload', handler);
  },
});
