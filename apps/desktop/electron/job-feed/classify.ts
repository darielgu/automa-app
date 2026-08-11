// Pure, dependency-free, and shared by the renderer that shows the message and
// the tests that prove it. Kept out of app.tsx so it can be executed without a
// DOM, and out of job-feed-core because that file is vendored byte-identical
// into the Deno Edge Function and must stay free of app concerns.

/**
 * What a completed sync actually means, in words a person can act on.
 *
 * syncJobFeed resolves even when every feed failed -- it records the error and
 * carries on -- so "no new rows" alone cannot tell you whether you are up to
 * date or offline. Pulled out as a pure function because the three branches are
 * easy to get subtly wrong and impossible to test through a network stack.
 */
export function classifyFeedSync(
  repos: Array<{ status: number | "skipped" | "error"; error?: string }>,
  upserted: number
): { tone: "success" | "neutral" | "error"; message: string } {
  const failures = repos.filter((repo) => repo.status === "error" || repo.error);

  if (repos.length > 0 && failures.length === repos.length) {
    const reason = failures[0]?.error ?? "";
    // fetch() reports a dead network as a bare "fetch failed", so the message
    // text is the only signal available. Naming the connection is more useful
    // to a person than repeating a DNS error verbatim.
    const offline = /fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network/i.test(reason);
    return {
      tone: "error",
      message: offline
        ? "Could not reach the job lists. Check this Mac's internet connection \u2014 everything already downloaded still works."
        : `The job lists could not be read: ${reason || "the source did not respond"}.`
    };
  }

  if (failures.length) {
    return {
      tone: "neutral",
      message: `${failures.length} of ${repos.length} feeds could not be read. Showing what did arrive.`
    };
  }

  if (repos.length > 0 && repos.every((repo) => repo.status === "skipped")) {
    return { tone: "neutral", message: "Checked recently already \u2014 these lists change a few times a day." };
  }

  return {
    tone: "success",
    message: upserted ? `${upserted.toLocaleString()} listings updated.` : "Already up to date."
  };
}
