import { test } from "node:test";
import assert from "node:assert/strict";
import { splitPostBody } from "./chat-post-split.ts";
import { MESSAGE_MAX } from "./chat-access.ts";
import { parseBody } from "./chat-format.ts";

const fits = (parts: string[], max: number) => {
  for (const p of parts) {
    assert.ok(p.length <= max, `${p.length} > ${max}: ${JSON.stringify(p)}`);
    assert.equal(p, p.trim(), "no part starts or ends with blank space");
    assert.ok(p.length > 0);
  }
};

const codeOf = (parts: string[]) =>
  parts.flatMap((p) => parseBody(p).flatMap((b) => (b.t === "codeblock" ? [b.v] : [])));

test("a body that fits is one message, trimmed; a blank one is none", () => {
  assert.deepEqual(splitPostBody("  short  "), ["short"]);
  assert.deepEqual(splitPostBody("x".repeat(MESSAGE_MAX)), ["x".repeat(MESSAGE_MAX)]);
  assert.deepEqual(splitPostBody("   \n\n  "), []);
  assert.deepEqual(splitPostBody("a\r\nb"), ["a\nb"]);
});

test("a long announcement is posted whole, broken between paragraphs", () => {
  const paras = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}: ` + "word ".repeat(150).trim());
  const body = `**Kickoff moved**\n\n${paras.join("\n\n")}`;
  assert.ok(body.length > 2 * MESSAGE_MAX);
  const parts = splitPostBody(body);
  assert.ok(parts.length >= 3);
  fits(parts, MESSAGE_MAX);
  assert.ok(parts[0].startsWith("**Kickoff moved**"));
  // Nothing lost, nothing added, and no paragraph split in two.
  assert.equal(parts.join("\n\n"), body);
});

test("without paragraphs it breaks between lines, then between words", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i} has some words`);
  const byLine = splitPostBody(lines.join("\n"), 60);
  fits(byLine, 60);
  assert.equal(byLine.join("\n"), lines.join("\n"));

  const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
  const byWord = splitPostBody(words, 30);
  fits(byWord, 30);
  assert.equal(byWord.join(" "), words);
});

test("a paragraph break early in the window doesn't waste the rest of the message", () => {
  const body = `Title\n\n${"word ".repeat(40).trim()}`;
  const parts = splitPostBody(body, 60);
  fits(parts, 60);
  assert.notEqual(parts[0], "Title", "a lone title would leave the message half empty");
  assert.equal(parts.join(" ").replace("Title ", "Title\n\n"), body);
});

test("one unbroken run is cut hard, never through an emoji", () => {
  const url = "https://example.com/" + "a".repeat(150);
  const parts = splitPostBody(url, 40);
  fits(parts, 40);
  assert.equal(parts.join(""), url);

  const emoji = "😀".repeat(50); // surrogate pairs, 100 code units
  const cut = splitPostBody(emoji, 33);
  fits(cut, 33);
  assert.equal(cut.join(""), emoji);
  for (const p of cut) assert.ok(!/[\ud800-\udbff]$/.test(p) && !/^[\udc00-\udfff]/.test(p), "a pair split in two");
});

test("a code block the break lands in is closed and reopened, so both halves render as code", () => {
  const code = Array.from({ length: 12 }, (_, i) => `  const x${i} = ${i};`).join("\n");
  const body = `Here's the snippet:\n\n\`\`\`ts\n${code}\n\`\`\`\n\nThat's all.`;
  const parts = splitPostBody(body, 120);
  fits(parts, 120);
  assert.ok(parts.length >= 3);
  // Every part's fences pair up, and the code reads back whole, indentation kept.
  for (const p of parts) {
    const blocks = parseBody(p);
    assert.ok(!blocks.some((b) => b.t !== "codeblock" && JSON.stringify(b).includes("```")), `a stray fence in ${JSON.stringify(p)}`);
  }
  assert.equal(codeOf(parts).join("\n"), code);
  assert.ok(parts.slice(1).some((p) => p.startsWith("```ts\n")), "the language carries on");
  assert.ok(parts.at(-1)!.endsWith("That's all."));
});

test("a break outside a code block wins over one inside it", () => {
  const code = "```\n" + "a b c d e f g h\n".repeat(2) + "```";
  const body = `${"intro ".repeat(8).trim()}\n${code}\n\n${"outro ".repeat(4).trim()}`;
  const parts = splitPostBody(body, 80);
  fits(parts, 80);
  assert.equal(codeOf(parts).join("\n"), "a b c d e f g h\na b c d e f g h");
  assert.ok(parts.every((p) => parseBody(p).filter((b) => b.t === "codeblock").length <= 1));
  assert.ok(!parts.some((p) => p.includes("```\n```")), "no empty code block");
});

test("a block that ends right at the break isn't reopened empty, and one starting at it moves on whole", () => {
  for (let pad = 0; pad < 40; pad++) {
    const body = `${"p".repeat(pad)} ${"q ".repeat(10)}\n\`\`\`\n${"code line\n".repeat(6)}\`\`\`\n${"tail ".repeat(12).trim()}`;
    const parts = splitPostBody(body, 64);
    fits(parts, 64);
    for (const p of parts) {
      for (const b of parseBody(p)) {
        if (b.t === "codeblock") assert.ok(b.v.trim().length > 0, `an empty code block (pad ${pad}): ${JSON.stringify(parts)}`);
      }
    }
    assert.equal(codeOf(parts).join("\n").replace(/\n+/g, "\n"), "code line\n".repeat(6).trim());
  }
});

test("an unclosed fence stays text: nothing to close or reopen", () => {
  const body = "```\n" + "loose words here ".repeat(10).trim();
  const parts = splitPostBody(body, 50);
  fits(parts, 50);
  assert.equal(parts.filter((p) => p.includes("```")).length, 1);
});
