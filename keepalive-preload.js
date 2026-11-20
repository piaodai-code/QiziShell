const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('keepalive', {
  boot: () => ipcRenderer.invoke('keepalive:boot'),
  setServer: (url) => ipcRenderer.invoke('keepalive:set-server', { url }),
  op: (op, platformId, payload) => ipcRenderer.invoke('keepalive:op', { op, platformId, payload }),
  saveGuide: (which) => ipcRenderer.invoke('keepalive:save-guide', { which }),
  onState: (callback) => subscribe('keepalive:state', callback),
  onLink: (callback) => subscribe('keepalive:link', callback),
  onRelay: (callback) => subscribe('keepalive:relay', callback),
});
