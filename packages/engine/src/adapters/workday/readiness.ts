import type { Page } from "playwright-core";
import { classifyWorkdayAuthView, isKnownWorkdayApplicationStep, type WorkdayAuthView } from "./entry.js";
import { detectWorkdayStep, hasVisibleWorkdayApplicationShell, isFirstActionableWorkdayStepReady, type WorkdayStep } from "./schema.js";

export type WorkdayReadyState =
  | "create_account"
  | "sign_in"
  | "application_loading"
  | "application_step"
  | "unknown";

export interface WorkdayReadyProbe {
  state: WorkdayReadyState;
  authView: WorkdayAuthView;
  step: WorkdayStep;
  stepReady: boolean;
  hasApplicationShell: boolean;
  hasLoadingIndicator: boolean;
  hasAuthError: boolean;
  hasVerificationGate: boolean;
  verificationEvidence?: string;
  url: string;
}

export type WorkdayAuthResolution =
  | { status: "continue" }
  | { status: "success" }
  | { status: "loading" }
  | { status: "failed"; reason: "sign_in_failed" | "account_creation_failed" | "email_verification_required" };

export function classifyWorkdayReadyState(markers: {
  authView: WorkdayAuthView;
  currentStep: WorkdayStep | string;
  hasApplicationShell: boolean;
  hasLoadingIndicator: boolean;
  url?: string;
  stepReady?: boolean;
}): WorkdayReadyState {
  const url = String(markers.url || "").toLowerCase();
  if (markers.authView === "create_account") return "create_account";
  if (markers.authView === "sign_in") return "sign_in";
  if (isKnownWorkdayApplicationStep(markers.currentStep) && (markers.stepReady ?? true)) return "application_step";
  if (markers.hasApplicationShell || markers.hasLoadingIndicator || url.includes("/apply")) return "application_loading";
  return "unknown";
}

export function resolveWorkdayAuthResolution(
  action: "sign_in" | "create_account",
  probe: Pick<WorkdayReadyProbe, "state" | "hasAuthError" | "hasVerificationGate">,
  deadlineReached: boolean
): WorkdayAuthResolution {
  if (probe.state === "application_step") return { status: "success" };
  if (probe.hasVerificationGate) return { status: "failed", reason: "email_verification_required" };
  if (action === "create_account" && probe.state === "sign_in") return { status: "success" };

  if (probe.state === action) {
    if (probe.hasAuthError) {
      return {
        status: "failed",
        reason: action === "sign_in" ? "sign_in_failed" : "account_creation_failed"
      };
    }
    if (deadlineReached) {
      return {
        status: "failed",
        reason: action === "sign_in" ? "sign_in_failed" : "account_creation_failed"
      };
    }
    return { status: "continue" };
  }

  if (probe.state === "application_loading" || probe.state === "unknown") {
    return deadlineReached ? { status: "loading" } : { status: "continue" };
  }

  if (deadlineReached) return { status: "loading" };
  return { status: "continue" };
}

export function summarizeWorkdayReadyProbe(probe: WorkdayReadyProbe): string {
  return `state=${probe.state}:auth=${probe.authView}:step=${probe.step}:step_ready=${probe.stepReady}:shell=${probe.hasApplicationShell}:loading=${probe.hasLoadingIndicator}:auth_error=${probe.hasAuthError}:verify_gate=${probe.hasVerificationGate}`;
}

async function hasAnyVisible(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const visible = await page.locator(selector).first().isVisible().catch(() => false);
    if (visible) return true;
  }
  return false;
}

export async function containsWorkdayAuthError(page: Page): Promise<boolean> {
  const text = (await page
    .locator("div[data-automation-id='errorMessage'], [data-automation-id*='error'], [role='alert']")
    .allInnerTexts()
    .catch(() => [] as string[]))
    .join(" ")
    .toLowerCase();
  return /account does not exist|account already exists|invalid username|invalid email|invalid password|incorrect password|unable to create|try again/.test(text);
}

export async function detectWorkdayVerificationGate(page: Page): Promise<{
  detected: boolean;
  evidence?: string;
}> {
  const rawText = await page
    .locator("main, body, [role='alert'], [data-automation-id*='message'], [data-automation-id*='notification']")
    .allInnerTexts()
    .catch(() => [] as string[]);
  const normalized = rawText
    .map((value) => value.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);

  const patterns = [
    /verify your e-?mail/,
    /verify (?:your )?email address/,
    /check your (?:e-?mail|inbox)/,
    /confirmation e-?mail/,
    /activation e-?mail/,
    /activate your account/,
    /confirm your e-?mail/,
    /before you can sign in/,
    /before signing in/,
    /we (?:have )?sent .*e-?mail/,
    /email .*verification/
  ];

  const evidence = normalized.find((value) => patterns.some((pattern) => pattern.test(value)));
  return evidence ? { detected: true, evidence } : { detected: false };
}

export async function probeWorkdayReadyState(page: Page): Promise<WorkdayReadyProbe> {
  const url = page.url();
  const authTitle = await page.locator("h3#authViewTitle").first().innerText().catch(() => "");
  const hasEmailInput = await page.locator("input[data-automation-id='email']").first().isVisible().catch(() => false);
  const hasPasswordInput = await page.locator("input[data-automation-id='password']").first().isVisible().catch(() => false);
  const hasVerifyPassword = await page.locator("input[data-automation-id='verifyPassword']").first().isVisible().catch(() => false);
  const hasCreateAccountSubmit = await page.locator("button[data-automation-id='createAccountSubmitButton']").first().isVisible().catch(() => false);
  const hasSignInSubmit = await page.locator("button[data-automation-id='signInSubmitButton']").first().isVisible().catch(() => false);
  const step = await detectWorkdayStep(page).catch(() => "unknown" as WorkdayStep);
  const stepReady = await isFirstActionableWorkdayStepReady(page, step).catch(() => false);
  const hasApplicationShell = await hasVisibleWorkdayApplicationShell(page).catch(() => false);
  const hasLoadingIndicator = await hasAnyVisible(page, [
    "[aria-busy='true']",
    "[role='progressbar']",
    "[data-automation-id='loadingScreen']",
    "[data-automation-id='pageLoadingIndicator']",
    "[data-automation-id*='spinner']",
    "[data-automation-id*='loading']"
  ]);
  const hasAuthError = await containsWorkdayAuthError(page);
  const verificationGate = await detectWorkdayVerificationGate(page);

  let authView = classifyWorkdayAuthView({
    authTitle,
    hasEmailInput,
    hasVerifyPassword,
    hasCreateAccountSubmit,
    hasSignInSubmit,
    hasPasswordInput,
    url
  });
  if (authView === "none" && (step === "sign_in" || step === "create_account")) {
    authView = step;
  }

  return {
    state: classifyWorkdayReadyState({
      authView,
      currentStep: step,
      hasApplicationShell,
      hasLoadingIndicator,
      url,
      stepReady
    }),
    authView,
    step,
    stepReady,
    hasApplicationShell,
    hasLoadingIndicator,
    hasAuthError,
    hasVerificationGate: verificationGate.detected,
    verificationEvidence: verificationGate.evidence,
    url
  };
}
