const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qizi', {
  checkConnection: () => ipcRenderer.invoke('openclaw:check'),
  loadHistory: () => ipcRenderer.invoke('openclaw:history'),
  chatStream: (payload, runId) => ipcRenderer.invoke('openclaw:chat', { ...payload, runId }),
  onChatDelta: (callback) => {
    const handler = (_event, payload) => {
      if (typeof payload === 'string') callback(payload, undefined);
      else callback(payload?.delta || '', payload?.runId, payload?.replace === true);
    };
    ipcRenderer.on('openclaw:delta', handler);
    return () => ipcRenderer.removeListener('openclaw:delta', handler);
  },
  onChatDone: (callback) => {
    const handler = (_event, payload) => {
      if (payload == null) callback(undefined);
      else if (typeof payload === 'object') callback(payload.runId, payload);
      else callback(undefined);
    };
    ipcRenderer.on('openclaw:done', handler);
    return () => ipcRenderer.removeListener('openclaw:done', handler);
  },
  onChatError: (callback) => {
    const handler = (_event, payload) => {
      if (typeof payload === 'string') callback(payload, undefined);
      else callback(payload?.error || '未知错误', payload?.runId);
    };
    ipcRenderer.on('openclaw:error', handler);
    return () => ipcRenderer.removeListener('openclaw:error', handler);
  },
  onGatewayStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('openclaw:gateway-status', handler);
    return () => ipcRenderer.removeListener('openclaw:gateway-status', handler);
  },
  onSessionChat: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('openclaw:session-chat', handler);
    return () => ipcRenderer.removeListener('openclaw:session-chat', handler);
  },
  onSessionChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('openclaw:session-changed', handler);
    return () => ipcRenderer.removeListener('openclaw:session-changed', handler);
  },
  abortChat: () => ipcRenderer.invoke('openclaw:abort'),
  getSessionKey: () => ipcRenderer.invoke('openclaw:getSessionKey'),
  listAgents: () => ipcRenderer.invoke('openclaw:agents:list'),
  forwardMessage: (payload) => ipcRenderer.invoke('openclaw:forward', payload),
  exportMessagesWord: (entries) => ipcRenderer.invoke('openclaw:export:word', { entries }),
  switchAgent: (agentId) => ipcRenderer.invoke('openclaw:session:switch', agentId),
  listModels: () => ipcRenderer.invoke('openclaw:models:list'),
  getCurrentModel: () => ipcRenderer.invoke('openclaw:models:current'),
  getSessionInfo: () => ipcRenderer.invoke('openclaw:session:info'),
  setModel: (qualifiedModel) => ipcRenderer.invoke('openclaw:models:set', qualifiedModel),
  normalizeImage: (dataUrl) => ipcRenderer.invoke('openclaw:normalize-image', dataUrl),
  pickImages: () => ipcRenderer.invoke('openclaw:pickImages'),
  pickFiles: () => ipcRenderer.invoke('openclaw:pickFiles'),
  captureScreenshot: () => ipcRenderer.invoke('openclaw:screenshot'),
  getSettings: () => ipcRenderer.invoke('openclaw:settings:get'),
  testGatewaySettings: (payload) => ipcRenderer.invoke('openclaw:settings:test', payload),
  saveSettings: (payload) => ipcRenderer.invoke('openclaw:settings:save', payload),
  openSettings: () => ipcRenderer.invoke('openclaw:open-settings'),
  openAbout: () => ipcRenderer.invoke('openclaw:open-about'),
  openUpdate: () => ipcRenderer.invoke('openclaw:open-update'),
  openControl: () => ipcRenderer.invoke('openclaw:open-control'),
  startMeeting: (config) => ipcRenderer.invoke('qizi-meeting:start', config),
  cancelMeeting: () => ipcRenderer.invoke('qizi-meeting:cancel'),
  getMeetingStatus: () => ipcRenderer.invoke('qizi-meeting:status'),
  listMeetingRecords: () => ipcRenderer.invoke('qizi-meeting:list-records'),
  loadMeetingHistory: (payload) => ipcRenderer.invoke('qizi-meeting:load-history', payload),
  exitMeeting: () => ipcRenderer.invoke('qizi-meeting:exit'),
  onMeetingEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('qizi-meeting:event', handler);
    return () => ipcRenderer.removeListener('qizi-meeting:event', handler);
  },
  quitApp: () => ipcRenderer.invoke('openclaw:quit'),
  onOpenSettings: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('openclaw:open-settings', handler);
    return () => ipcRenderer.removeListener('openclaw:open-settings', handler);
  },
  getSttStatus: () => ipcRenderer.invoke('openclaw:stt:status'),
  installStt: () => ipcRenderer.invoke('openclaw:stt:install'),
  uninstallStt: () => ipcRenderer.invoke('openclaw:stt:uninstall'),
  transcribeStt: (payload) => ipcRenderer.invoke('openclaw:stt:transcribe', payload),
  onSttProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('openclaw:stt:progress', handler);
    return () => ipcRenderer.removeListener('openclaw:stt:progress', handler);
  },
});
