import type { DesktopAutomationConfig, RunOutcome, UserProfileInput } from "@automa/shared-types";

export type { DesktopAutomationConfig } from "@automa/shared-types";

export interface DesktopResumeRecord {
  fileName: string;
  filePath: string;
  mimeType: string;
  selectedAt: string;
  extractedText?: string;
}

export interface ResumeParseDraft {
  profile: UserProfileInput;
  extractedText: string;
  warnings: string[];
}

export interface DesktopBrowserDrawerBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopRendererState {
  onboarding?: UserProfileInput;
  resume?: DesktopResumeRecord;
  runs: RunOutcome[];
  config: DesktopAutomationConfig;
}
