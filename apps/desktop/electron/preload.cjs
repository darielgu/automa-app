const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("automaDesktop", {
  getState: () => ipcRenderer.invoke("desktop:get-state"),
  saveOnboarding: (profile) => ipcRenderer.invoke("desktop:save-onboarding", profile),
  saveConfig: (config) => ipcRenderer.invoke("desktop:save-config", config),
  pickResume: () => ipcRenderer.invoke("desktop:pick-resume"),
  parseResume: () => ipcRenderer.invoke("desktop:parse-resume"),
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
  openAutomationBrowser: (url) => ipcRenderer.invoke("desktop:open-automation-browser", url),
  closeAutomationBrowser: () => ipcRenderer.invoke("desktop:close-automation-browser"),
  setBrowserDrawerBounds: (bounds) => ipcRenderer.invoke("desktop:set-browser-drawer-bounds", bounds),
  listRuns: () => ipcRenderer.invoke("desktop:list-runs"),
  openRunBrowser: (runId) => ipcRenderer.invoke("desktop:open-run-browser", runId),
  closeRunBrowser: (runId) => ipcRenderer.invoke("desktop:close-run-browser", runId),
  enqueueRun: (job) => ipcRenderer.invoke("desktop:enqueue-run", job),
  clearLocalRuns: () => ipcRenderer.invoke("desktop:clear-local-runs"),
  cancelRun: (runId) => ipcRenderer.invoke("desktop:cancel-run", runId),
  onRunsUpdated: (listener) => {
    const wrapped = (_event, runs) => listener(runs);
    ipcRenderer.on("runs:updated", wrapped);
    return () => ipcRenderer.removeListener("runs:updated", wrapped);
  },
  onRunCompleted: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("run:completed", wrapped);
    return () => ipcRenderer.removeListener("run:completed", wrapped);
  }
});
