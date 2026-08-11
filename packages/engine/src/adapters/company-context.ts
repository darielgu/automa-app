function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripHtmlTags(value: string): string {
  return value
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function isLikelyNoiseLink(url: URL, text: string): boolean {
  const normalizedText = text.toLowerCase();
  const urlText = `${url.hostname}${url.pathname}`.toLowerCase();
  const noiseTokens = [
    "privacy",
    "terms",
    "login",
    "signin",
    "sign-in",
    "cookie",
    "contact",
    "help",
    "support",
    "legal",
    "careers",
    "jobs",
    "apply",
    "linkedin",
    "twitter",
    "x.com",
    "instagram",
    "facebook",
    "youtube"
  ];
  return noiseTokens.some((token) => normalizedText.includes(token) || urlText.includes(token));
}

export function htmlToText(html: string): string {
  return normalizeWhitespace(decodeBasicHtmlEntities(stripHtmlTags(html || "")));
}

export function collectCompanyInfoLinksFromHtml(html: string, baseUrl: string): string[] {
  const anchorRegex = /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'<>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  const links: Array<{ href: string; score: number; index: number }> = [];
  const seen = new Set<string>();
  const companySignals = [
    "about",
    "company",
    "mission",
    "product",
    "platform",
    "who we are",
    "what we do",
    "our story"
  ];

  let match: RegExpExecArray | null = null;
  let index = 0;
  while ((match = anchorRegex.exec(html)) !== null) {
    const hrefRaw = (match[1] || match[2] || match[3] || "").trim();
    if (!hrefRaw || hrefRaw.startsWith("#") || hrefRaw.startsWith("javascript:")) continue;

    let resolved: URL;
    try {
      resolved = new URL(hrefRaw, baseUrl);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(resolved.protocol)) continue;

    const linkText = htmlToText(match[4] || "");
    if (!linkText) continue;
    if (isLikelyNoiseLink(resolved, linkText)) continue;

    const joined = `${linkText} ${resolved.pathname}`.toLowerCase();
    let score = 0;
    for (const token of companySignals) {
      if (joined.includes(token)) score += 2;
    }
    if (resolved.origin === new URL(baseUrl).origin) score += 1;
    if (score <= 0) continue;

    const key = `${resolved.origin}${resolved.pathname}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ href: resolved.toString(), score, index });
    index += 1;
  }

  return links
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 5)
    .map((item) => item.href);
}

export function extractCompanyDirectionContextFromText(text: string, company?: string): string | undefined {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length >= 40 && line.length <= 220);

  if (!lines.length) return undefined;

  const companyToken = company?.trim() ? company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
  const companyRegex = companyToken ? new RegExp(`\\b${companyToken}\\b`, "i") : null;
  const directionRegex =
    /(mission|platform|infrastructure|developers|developer|product|procurement|workflow|automation|software|customers|scale|founded|build|building)/i;
  const skipRegex =
    /(privacy|terms|contact|save|view job|my profile|jobs by|remote jobs|internships|events|copyright)/i;

  const scored = lines
    .map((line, index) => {
      if (skipRegex.test(line)) return null;
      let score = 0;
      if (directionRegex.test(line)) score += 2;
      if (companyRegex?.test(line)) score += 1;
      if (line.length >= 60 && line.length <= 170) score += 1;
      if (score === 0) return null;
      return { line, score, index };
    })
    .filter((entry): entry is { line: string; score: number; index: number } => Boolean(entry))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (!scored.length) return undefined;

  const selected: string[] = [];
  const seen = new Set<string>();
  for (const item of scored) {
    const normalized = item.line.toLowerCase();
    if (seen.has(normalized)) continue;
    selected.push(item.line);
    seen.add(normalized);
    if (selected.length >= 3) break;
  }

  const context = normalizeWhitespace(selected.join(" "));
  if (!context) return undefined;
  return context.length > 420 ? `${context.slice(0, 417).trim()}...` : context;
}
