const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qiziMeetingHelp', {
  copyText(text) {
    return ipcRenderer.invoke('qizi-meeting:help:copy', String(text || ''));
  },
});
