import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSafeMarkdown } from "./markdown-safe.ts";

// Challenge descriptions and rules are written by staff who aren't all full
// admins and rendered with dangerouslySetInnerHTML on public pages for minors.
// These are the ways a script link could get through.

test("javascript: links are stripped, whatever the spelling", async () => {
  for (const md of [
    "[x](javascript:alert(1))",
    "[x][r]\n\n[r]: JaVaScRiPt:alert(1)",
    "[x](  javascript:alert(1))",
    "<javascript:alert(1)>",
  ]) {
    const html = await renderSafeMarkdown(md);
    // The link's visible TEXT may still read "javascript:…"; what matters is
    // that no href/src carries it.
    assert.doesNotMatch(html, /(href|src)="[^"]*javascript:/i, md);
  }
});

test("data: and vbscript: URLs are stripped", async () => {
  const html = await renderSafeMarkdown("[a](data:text/html,<script>alert(1)</script>) [b](vbscript:msgbox)");
  assert.doesNotMatch(html, /(href|src)="[^"]*(data:|vbscript:)/i);
});

test("raw HTML never renders", async () => {
  const html = await renderSafeMarkdown('<img src=x onerror="alert(1)"><script>alert(1)</script>');
  assert.doesNotMatch(html, /<img|<script|onerror/i);
});

test("safe links survive, opening in a new tab", async () => {
  const html = await renderSafeMarkdown("[site](https://batch0.org) and [mail](mailto:hi@batch0.org)");
  assert.match(html, /href="https:\/\/batch0\.org"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /href="mailto:hi@batch0\.org"/);
});

test("headings keep their anchors", async () => {
  const html = await renderSafeMarkdown("## Hi there");
  assert.match(html, /id="hi-there"/);
  assert.match(html, /class="heading-anchor"/);
});

test("single newlines are line breaks (legacy plain-text descriptions)", async () => {
  const html = await renderSafeMarkdown("Prize: $500\nDeadline: Friday");
  assert.match(html, /Prize: \$500<br>/);
});

test("code blocks keep their newlines untouched", async () => {
  const html = await renderSafeMarkdown("```\na\nb\n```");
  assert.match(html, /<code>a\nb\n<\/code>/);
});
