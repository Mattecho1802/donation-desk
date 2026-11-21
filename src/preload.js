// The only bridge between the window and the main process.
// Each function returns { ok: result } or { error: message }.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (arg) => ipcRenderer.invoke(channel, arg);

contextBridge.exposeInMainWorld('api', {
  state: call('app:state'),
  setup: call('app:setup'),
  login: call('app:login'),
  logout: call('app:logout'),
  listDonors: call('donors:list'),
  createDonor: call('donors:create'),
  updateDonor: call('donors:update'),
  eraseDonor: call('donors:erase'),
});
