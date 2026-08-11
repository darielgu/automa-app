import { contextBridge, ipcRenderer } from "electron";
import type { RunCompletionEvent, UserProfileInput } from "@automa/shared-types";
import type { DesktopAutomationConfig, DesktopBrowserDrawerBounds, ResumeParseDraft } from "../src/desktop-types.js";

contextBridge.exposeInMainWorld("automaDesktop", {
  getState: () => ipcRenderer.invoke("desktop:get-state"),
  saveOnboarding: (profile: UserProfileInput) => ipcRenderer.invoke("desktop:save-onboarding", profile),
  saveConfig: (config: DesktopAutomationConfig) => ipcRenderer.invoke("desktop:save-config", config),
  pickResume: () => ipcRenderer.invoke("desktop:pick-resume"),
  parseResume: (): Promise<ResumeParseDraft> => ipcRenderer.invoke("desktop:parse-resume"),
  openExternal: (url: string) => ipcRenderer.invoke("desktop:open-external", url),
  openAutomationBrowser: (url?: string) => ipcRenderer.invoke("desktop:open-automation-browser", url),
  closeAutomationBrowser: () => ipcRenderer.invoke("desktop:close-automation-browser"),
  setBrowserDrawerBounds: (bounds: DesktopBrowserDrawerBounds | null) => ipcRenderer.invoke("desktop:set-browser-drawer-bounds", bounds),
  listRuns: () => ipcRenderer.invoke("desktop:list-runs"),
  openRunBrowser: (runId: string) => ipcRenderer.invoke("desktop:open-run-browser", runId),
  closeRunBrowser: (runId: string) => ipcRenderer.invoke("desktop:close-run-browser", runId),
  enqueueRun: (job: {
    id: string;
    sourceUrl: string;
    title?: string;
    company?: string;
    location?: string;
    source?: string;
  }) => ipcRenderer.invoke("desktop:enqueue-run", job),
  clearLocalRuns: () => ipcRenderer.invoke("desktop:clear-local-runs"),
  cancelRun: (runId: string) => ipcRenderer.invoke("desktop:cancel-run", runId),
  resumeRun: (runId: string) => ipcRenderer.invoke("desktop:resume-run", runId),
  onRunsUpdated: (listener: (runs: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, runs: unknown) => listener(runs);
    ipcRenderer.on("runs:updated", wrapped);
    return () => ipcRenderer.removeListener("runs:updated", wrapped);
  },
  onRunCompleted: (listener: (payload: RunCompletionEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: RunCompletionEvent) => listener(payload);
    ipcRenderer.on("run:completed", wrapped);
    return () => ipcRenderer.removeListener("run:completed", wrapped);
  }
});
