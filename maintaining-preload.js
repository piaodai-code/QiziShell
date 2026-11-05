const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('maintaining', {
  boot: () => ipcRenderer.invoke('hermes:boot'),
  login: (payload) => ipcRenderer.invoke('hermes:login', payload),
  testConnection: (payload) => ipcRenderer.invoke('hermes:test', payload),
  send: (payload) => ipcRenderer.invoke('hermes:send', payload),
  abort: () => ipcRenderer.invoke('hermes:abort'),
  respond: (payload) => ipcRenderer.invoke('hermes:respond', payload),
  captureScreenshot: () => ipcRenderer.invoke('hermes:screenshot'),
  pickImages: () => ipcRenderer.invoke('hermes:pick-images'),
  pickFiles: () => ipcRenderer.invoke('hermes:pick-files'),
  exportMessagesWord: (entries) => ipcRenderer.invoke('openclaw:export:word', { entries }),
  onStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('hermes:status', handler);
    return () => ipcRenderer.removeListener('hermes:status', handler);
  },
  onHistory: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('hermes:history', handler);
    return () => ipcRenderer.removeListener('hermes:history', handler);
  },
  onStream: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('hermes:stream', handler);
    return () => ipcRenderer.removeListener('hermes:stream', handler);
  },
  onComplete: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('hermes:complete', handler);
    return () => ipcRenderer.removeListener('hermes:complete', handler);
  },
  onTurnError: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('hermes:turn-error', handler);
    return () => ipcRenderer.removeListener('hermes:turn-error', handler);
  },
  onRequest: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('hermes:request', handler);
    return () => ipcRenderer.removeListener('hermes:request', handler);
  },
  onActivity: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('hermes:activity', handler);
    return () => ipcRenderer.removeListener('hermes:activity', handler);
  },
});
