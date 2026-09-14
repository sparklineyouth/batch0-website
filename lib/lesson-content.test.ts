import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLessonMarkdown } from "./lesson-content.ts";

test("course worksheets render headings, lists, tables and safe source links", async () => {
  const html = await renderLessonMarkdown("## Your experiment\n\n- Interview a user\n\n| Signal | Count |\n| --- | --- |\n| Returned | 3 |\n\n[Source](https://www.ycombinator.com/library)");
  assert.match(html, /<h2>Your experiment<\/h2>/);
  assert.match(html, /<li>Interview a user<\/li>/);
  assert.match(html, /<table>/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("course content cannot inject scripts or executable links", async () => {
  const html = await renderLessonMarkdown('<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)\n\n<img src=x onerror=alert(1)>\n\n[workbook](/dashboard/resources)');
  assert.doesNotMatch(html, /<script|onerror|href="javascript:/i);
  assert.match(html, /href="\/dashboard\/resources"/);
});
