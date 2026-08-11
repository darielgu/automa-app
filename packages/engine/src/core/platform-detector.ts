import type { Platform } from "./types.js";

export function hasGreenhouseUrlSignals(url: string): boolean {
  const normalized = url.toLowerCase();
  if (normalized.includes("greenhouse.io")) return true;
  // Automa's bundled demo application. It uses Greenhouse markup on purpose so
  // the real adapter drives it; a demo running through a special-case path
  // would prove nothing. Adapter selection goes through canHandle, which calls
  // this function, so the rule has to live here rather than in detectPlatform.
  if (normalized.includes("automa-practice") || normalized.includes("greenhouse-practice.html")) return true;
  try {
    const parsed = new URL(url);
    const ghJid = parsed.searchParams.get("gh_jid");
    const ghSrc = parsed.searchParams.get("gh_src") || "";
    if (ghJid && /^\d{6,}$/.test(ghJid.trim())) return true;
    if (/greenhouse/.test(ghSrc.toLowerCase())) return true;
  } catch {
    return normalized.includes("gh_jid=") || normalized.includes("gh_src=");
  }
  return false;
}

export function detectPlatform(url: string): Platform {
  const normalized = url.toLowerCase();

  // Automa's bundled practice applications, used only by the adapter test
  // harness. Each uses its platform's real markup so the genuine adapter drives
  // it; a fixture that ran through a special-case path would prove nothing.
  if (normalized.includes("lever-practice.html")) return "lever";
  if (normalized.includes("ashby-practice.html")) return "ashby";
  if (normalized.includes("workatastartup-practice.html")) return "workatastartup";
  if (normalized.includes("workday-practice.html")) return "workday";

  if (hasGreenhouseUrlSignals(url)) return "greenhouse";
  if (normalized.includes("lever.co")) return "lever";
  if (normalized.includes("myworkdayjobs.com") || normalized.includes("workday")) return "workday";
  if (normalized.includes("ashbyhq.com")) return "ashby";
  if (normalized.includes("workatastartup.com")) return "workatastartup";
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) return "generic";

  return "unknown";
}
