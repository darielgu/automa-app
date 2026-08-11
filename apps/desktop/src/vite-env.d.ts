/// <reference types="vite/client" />

import type { RunCompletionEvent } from "@automa/shared-types";
import type { DesktopAutomationConfig, DesktopBrowserDrawerBounds, DesktopResumeRecord, ResumeParseDraft } from "./desktop-types.js";

declare global {
  interface Window {
    automaDesktop: {
      getState: () => Promise<unknown>;
      saveOnboarding: (profile: unknown) => Promise<unknown>;
      saveConfig: (config: DesktopAutomationConfig) => Promise<DesktopAutomationConfig>;
      pickResume: () => Promise<DesktopResumeRecord | null>;
      parseResume: () => Promise<ResumeParseDraft>;
      openExternal: (url: string) => Promise<void>;
      openAutomationBrowser: (url?: string) => Promise<void>;
      closeAutomationBrowser: () => Promise<void>;
      setBrowserDrawerBounds: (bounds: DesktopBrowserDrawerBounds | null) => Promise<void>;
      listRuns: () => Promise<unknown>;
      openRunBrowser: (runId: string) => Promise<void>;
      closeRunBrowser: (runId: string) => Promise<void>;
      enqueueRun: (job: {
        id: string;
        sourceUrl: string;
        title?: string;
        company?: string;
        location?: string;
        source?: string;
      }) => Promise<unknown>;
      cancelRun: (runId: string) => Promise<void>;
      resumeRun: (runId: string) => Promise<void>;
      onRunsUpdated: (listener: (runs: unknown) => void) => () => void;
      onRunCompleted: (listener: (payload: RunCompletionEvent) => void) => () => void;
    };
  }
}

export {};
