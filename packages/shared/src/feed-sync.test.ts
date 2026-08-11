import test from "node:test";
import assert from "node:assert/strict";
import { classifyFeedSync } from "./feed-sync.js";

test("a dead network is not reported as being up to date", () => {
  // This is the bug this function exists to prevent: syncJobFeed resolves
  // normally when every fetch fails, so the caller sees zero new rows and used
  // to say "The feed returned nothing new."
  const verdict = classifyFeedSync(
    [
      { status: "error", error: "fetch failed" },
      { status: "error", error: "fetch failed" }
    ],
    0
  );
  assert.equal(verdict.tone, "error");
  assert.match(verdict.message, /internet connection/);
  assert.match(verdict.message, /already downloaded still works/);
});

test("a server failure names the server, not the network", () => {
  const verdict = classifyFeedSync([{ status: "error", error: "HTTP 503" }], 0);
  assert.equal(verdict.tone, "error");
  assert.match(verdict.message, /HTTP 503/);
  assert.doesNotMatch(verdict.message, /internet connection/);
});

test("one failing feed out of three is not a total failure", () => {
  const verdict = classifyFeedSync(
    [{ status: 200 }, { status: 304 }, { status: "error", error: "HTTP 500" }],
    12
  );
  assert.equal(verdict.tone, "neutral");
  assert.match(verdict.message, /1 of 3/);
});

test("asking again too soon is distinguishable from being up to date", () => {
  const throttled = classifyFeedSync([{ status: "skipped" }, { status: "skipped" }], 0);
  const current = classifyFeedSync([{ status: 304 }, { status: 304 }], 0);
  assert.match(throttled.message, /Checked recently/);
  assert.match(current.message, /Already up to date/);
  assert.notEqual(throttled.message, current.message);
});

test("new listings are counted", () => {
  const verdict = classifyFeedSync([{ status: 200 }], 1234);
  assert.equal(verdict.tone, "success");
  assert.match(verdict.message, /1,234 listings updated/);
});

test("an empty repo list is treated as success, never as offline", () => {
  // The Supabase mirror path returns no repos at all. Reading that as "every
  // feed failed" would show a network error to someone whose feed just worked.
  assert.equal(classifyFeedSync([], 0).tone, "success");
});
