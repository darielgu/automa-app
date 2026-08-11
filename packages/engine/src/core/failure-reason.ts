import type { FailureReason, JobRunResult } from "./types.js";

function normalize(text: string): string {
  return String(text || "").toLowerCase();
}

function firstNonEmpty(items: Array<string | undefined>): string {
  for (const item of items) {
    const trimmed = String(item || "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function deriveFailureReason(result: JobRunResult): FailureReason | undefined {
  if (result.status === "applied" && result.submissionConfirmed) return undefined;
  const reason = firstNonEmpty([result.error, ...result.notes, result.submitOutcome, result.status]);
  const lowered = normalize(reason);

  if (
    result.submitOutcome === "blocked_bot_challenge" ||
    result.submitOutcome === "challenge_detected" ||
    /captcha|challenge_detected|bot_challenge/.test(lowered)
  ) {
    return {
      category: "bot_challenge",
      code: "bot_challenge_detected",
      userMessage: "A bot challenge blocked automatic submission.",
      action: "manual_apply",
      evidence: [reason]
    };
  }

  if (
    result.submitOutcome === "session_lost" ||
    /session_lost|target page, context or browser has been closed|browser has been closed/.test(lowered)
  ) {
    return {
      category: "session_lost",
      code: "browser_session_lost",
      userMessage: "The browser session was interrupted before submission could finish.",
      action: "retry",
      evidence: [reason]
    };
  }

  if (result.submitOutcome === "inactive_posting" || /inactive_or_unreachable|inactive_job_url|http_404|http_410/.test(lowered)) {
    return {
      category: "inactive_posting",
      code: "posting_inactive_or_unreachable",
      userMessage: "This job posting is inactive or unavailable.",
      action: "manual_apply",
      evidence: [reason]
    };
  }

  if (/unsupported_widget|no_adapter_matched|no adapter matched/.test(lowered)) {
    return {
      category: "unsupported_widget",
      code: "unsupported_form_widget",
      userMessage: "This application form includes unsupported controls.",
      action: "manual_apply",
      evidence: [reason]
    };
  }

  if (
    result.submitOutcome === "blocked_pre_submit_unresolved_required" ||
    /blocked_pre_submit_unresolved_required|required.*unresolved|submit_missing_required|required field/.test(lowered)
  ) {
    return {
      category: "required_missing",
      code: "required_fields_unresolved",
      userMessage: "Required questions could not be completed automatically.",
      action: "update_profile",
      evidence: [reason]
    };
  }

  if (
    result.submitOutcome === "validation_error" ||
    result.submitOutcome === "submit_validation_error" ||
    result.submitOutcome === "page_validation_error" ||
    /validation_errors_after_submit|validation_error|invalid/.test(lowered)
  ) {
    return {
      category: "validation_error",
      code: "form_validation_failed",
      userMessage: "The application form rejected one or more answers.",
      action: "update_profile",
      evidence: [reason]
    };
  }

  if (
    result.submitOutcome === "sign_in_failed" ||
    result.submitOutcome === "email_verification_required" ||
    result.submitOutcome === "account_creation_failed" ||
    /sign_in_failed|email_verification_required|account_creation_failed|verify email/.test(lowered)
  ) {
    return {
      category: "auth_issue",
      code: "auth_verification_required",
      userMessage: "Sign-in or verification is required before applying.",
      action: "verify_auth",
      evidence: [reason]
    };
  }

  if (result.submitOutcome === "submit_unavailable" || /submit_button_unavailable|submit_unavailable/.test(lowered)) {
    return {
      category: "submit_unavailable",
      code: "submit_action_unavailable",
      userMessage: "The submit action was unavailable at runtime.",
      action: "retry",
      evidence: [reason]
    };
  }

  return {
    category: "unknown",
    code: "unknown_submission_failure",
    userMessage: "The run failed for an uncategorized reason.",
    action: "retry",
    evidence: [reason || result.status]
  };
}

export function buildFailureSummary(reason: FailureReason | undefined): string | undefined {
  if (!reason) return undefined;
  return `${reason.userMessage} Next step: ${reason.action}.`;
}
