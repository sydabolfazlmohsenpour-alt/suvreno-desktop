'use strict';
// پلِ امن بین سایتِ سوورنو و نسخه‌ی دسکتاپ (مثل SuvrenoNative در اپ اندروید)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('SuvrenoDesktop', {
  isDesktop: true,
  version: ipcRenderer.sendSync('sd:version'),
  setAlwaysOnTop: (v) => ipcRenderer.invoke('sd:aot', !!v),
  toggleMini: () => ipcRenderer.invoke('sd:mini'),
  notify: (title, body) => ipcRenderer.invoke('sd:notify', String(title || ''), String(body || '')),
  // ایجنت دسکتاپ
  agentAvailable: () => true,
  agentState: () => ipcRenderer.invoke('sd:agent-state'),
  agentStart: (code, task) => ipcRenderer.invoke('sd:agent-start', String(code || ''), String(task || '')),
  agentStop: () => ipcRenderer.invoke('sd:agent-stop'),
  agentReply: (text) => ipcRenderer.invoke('sd:agent-reply', String(text || '')),
  agentForget: () => ipcRenderer.invoke('sd:agent-forget'),
  pickWorkspace: () => ipcRenderer.invoke('sd:agent-pick'),
  openUrl: (u) => ipcRenderer.invoke('sd:open-url', String(u || ''))
});
