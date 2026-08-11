export type WorkdayAuthView = "create_account" | "sign_in" | "none";

export function normalizeWorkdayApplyUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const path = parsed.pathname;
  if (path.includes("/apply/applyManually")) return parsed.toString();

  if (path.includes("/apply")) {
    parsed.pathname = path.endsWith("/") ? `${path}applyManually` : `${path}/applyManually`;
    return parsed.toString();
  }

  if (path.includes("/job/")) {
    parsed.pathname = path.endsWith("/") ? `${path}apply/applyManually` : `${path}/apply/applyManually`;
    return parsed.toString();
  }

  return parsed.toString();
}

export function classifyWorkdayAuthView(markers: {
  authTitle?: string;
  hasEmailInput?: boolean;
  hasVerifyPassword: boolean;
  hasCreateAccountSubmit: boolean;
  hasSignInSubmit: boolean;
  hasPasswordInput: boolean;
  url?: string;
}): WorkdayAuthView {
  const title = String(markers.authTitle || "").toLowerCase();
  const url = String(markers.url || "").toLowerCase();
  if (title.includes("create account") || markers.hasVerifyPassword || markers.hasCreateAccountSubmit || url.includes("createaccount")) {
    return "create_account";
  }
  if (title.includes("sign in") || markers.hasSignInSubmit || ((markers.hasPasswordInput || markers.hasEmailInput) && (url.includes("/signin") || url.includes("/login")))) {
    return "sign_in";
  }
  return "none";
}

export function isKnownWorkdayApplicationStep(step: string): boolean {
  return !["unknown", "start", "sign_in", "create_account"].includes(step);
}
