export { runAutomation } from "./runner/orchestrator.js";
export { runProviderLoop } from "./runner/provider-loop.js";
export { detectPlatform } from "./core/platform-detector.js";
export type {
  ActiveAutomationPage,
  AIConfig,
  AshbyConfig,
  AdapterRunContext,
  AnswerSource,
  AnswerValue,
  ApplicationQuestion,
  AutomationConfig,
  BrowserConfig,
  CandidateProfile,
  FilledFieldRecord,
  JobRunResult,
  JobTarget,
  Platform,
  QuestionType,
  ReviewReceiptItem,
  ResolvedAnswer,
  RunMode,
  SubmissionReceipt,
  SubmissionReceiptItem
} from "./core/types.js";
export type { LoopProvider, ProviderLoopInput, ProviderLoopSummary } from "./runner/provider-loop.js";
