// The single preload source. There used to be a .ts twin of this file that had
// to be kept in sync by hand; it drifted, so it is gone. contextIsolation stays
// on and nodeIntegration stays off: the renderer only ever sees this surface.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

function subscribe(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("automaDesktop", {
  // ---- local state, profile, resume ----
  getState: () => ipcRenderer.invoke("desktop:get-state"),
  saveOnboarding: (profile) => ipcRenderer.invoke("desktop:save-onboarding", profile),
  saveConfig: (config) => ipcRenderer.invoke("desktop:save-config", config),
  pickResume: () => ipcRenderer.invoke("desktop:pick-resume"),
  // File.path was removed in Electron 32, so a dropped file's real path can
  // only be resolved here, in the preload.
  pathForDroppedFile: (file) => webUtils.getPathForFile(file),
  setResumePath: (filePath) => ipcRenderer.invoke("desktop:set-resume-path", filePath),
  // The key crosses this bridge once, going in. It is never sent back.
  setOpenAiKey: (key) => ipcRenderer.invoke("desktop:set-openai-key", key),
  parseResume: () => ipcRenderer.invoke("desktop:parse-resume"),
  getProfile: () => ipcRenderer.invoke("profile:get"),
  getSetting: (key) => ipcRenderer.invoke("settings:get", key),
  setSetting: (key, value) => ipcRenderer.invoke("settings:set", key, value),

  // ---- job feed ----
  listJobs: (query) => ipcRenderer.invoke("jobs:list", query),
  getJob: (jobId) => ipcRenderer.invoke("jobs:get", jobId),
  jobFacets: () => ipcRenderer.invoke("jobs:facets"),
  setJobFeedback: (jobId, verdict) => ipcRenderer.invoke("jobs:feedback", jobId, verdict),
  syncJobs: (force) => ipcRenderer.invoke("jobs:sync", force),
  jobsStatus: () => ipcRenderer.invoke("jobs:status"),

  // ---- tracker ----
  listApplied: () => ipcRenderer.invoke("tracker:list"),
  appliedTimeline: (appliedId) => ipcRenderer.invoke("tracker:timeline", appliedId),
  moveApplied: (appliedId, stage, note) => ipcRenderer.invoke("tracker:move", appliedId, stage, note),
  setAppliedNotes: (appliedId, notes) => ipcRenderer.invoke("tracker:notes", appliedId, notes),

  // ---- runs ----
  listRuns: () => ipcRenderer.invoke("desktop:list-runs"),
  enqueueRun: (job) => ipcRenderer.invoke("desktop:enqueue-run", job),
  cancelRun: (runId) => ipcRenderer.invoke("desktop:cancel-run", runId),
  resumeRun: (runId) => ipcRenderer.invoke("desktop:resume-run", runId),
  clearLocalRuns: () => ipcRenderer.invoke("desktop:clear-local-runs"),
  runEvents: (runId, afterId) => ipcRenderer.invoke("runs:events", runId, afterId),

  // ---- embedded browser ----
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
  openAutomationBrowser: (url) => ipcRenderer.invoke("desktop:open-automation-browser", url),
  closeAutomationBrowser: () => ipcRenderer.invoke("desktop:close-automation-browser"),
  setBrowserDrawerBounds: (bounds) => ipcRenderer.invoke("desktop:set-browser-drawer-bounds", bounds),
  openRunBrowser: (runId) => ipcRenderer.invoke("desktop:open-run-browser", runId),
  closeRunBrowser: (runId) => ipcRenderer.invoke("desktop:close-run-browser", runId),

  // ---- push events ----
  onRunsUpdated: (listener) => subscribe("runs:updated", listener),
  onRunCompleted: (listener) => subscribe("run:completed", listener),
  onRunEvent: (listener) => subscribe("run:events", listener),
  onJobsUpdated: (listener) => subscribe("jobs:updated", listener)
});
