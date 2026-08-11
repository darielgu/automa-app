import test from "node:test";
import assert from "node:assert/strict";
import {
  collectCompanyInfoLinksFromHtml,
  extractCompanyDirectionContextFromText,
  htmlToText
} from "./company-context.js";

test("collectCompanyInfoLinksFromHtml prefers company/about/product links", () => {
  const html = `
    <html>
      <body>
        <a href="/jobs">Open Roles</a>
        <a href="/about">About Us</a>
        <a href="https://example.com/product">Product</a>
        <a href="https://linkedin.com/company/example">LinkedIn</a>
      </body>
    </html>
  `;

  const links = collectCompanyInfoLinksFromHtml(html, "https://example.com/careers/engineering");
  assert.deepEqual(links.slice(0, 2), ["https://example.com/about", "https://example.com/product"]);
});

test("extractCompanyDirectionContextFromText returns direction-rich summary", () => {
  const context = extractCompanyDirectionContextFromText(
    [
      "Omnea is building AI-native procurement workflows for finance and operations teams.",
      "The product helps customers automate purchasing, approvals, and supplier coordination at scale.",
      "Privacy policy and terms."
    ].join("\n"),
    "Omnea"
  );

  assert.ok(context);
  assert.match(context ?? "", /building ai-native procurement workflows/i);
  assert.doesNotMatch(context ?? "", /privacy policy/i);
});

test("htmlToText strips scripts/styles and keeps readable content", () => {
  const text = htmlToText(`
    <html>
      <style>.hidden { display:none }</style>
      <script>console.log("ignore me")</script>
      <body><h1>About Example</h1><p>We build software for operations teams.</p></body>
    </html>
  `);

  assert.match(text, /About Example/i);
  assert.match(text, /build software for operations teams/i);
  assert.doesNotMatch(text, /ignore me/i);
});
