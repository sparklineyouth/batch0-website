import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeMentions,
  encodeMentions,
  isJumboEmoji,
  linkedChannelIds,
  mentionedIds,
  mentionQueryAt,
  mentionsEveryone,
  parseBody,
  parseInline,
  plainText,
  trimUrl,
} from "./chat-format.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

test("plain text is one text block of one text node", () => {
  assert.deepEqual(parseBody("hello world"), [{ t: "text", c: [{ t: "text", v: "hello world" }] }]);
});

test("newlines become breaks inside one block, and edge blank lines go", () => {
  assert.deepEqual(parseBody("\n\none\ntwo\n\n"), [
    { t: "text", c: [{ t: "text", v: "one" }, { t: "br" }, { t: "text", v: "two" }] },
  ]);
});

test("bold, italic, strike and spoiler nest", () => {
  assert.deepEqual(parseInline("**bold *and italic*** ~~gone~~ ||secret||"), [
    { t: "bold", c: [{ t: "text", v: "bold " }, { t: "italic", c: [{ t: "text", v: "and italic" }] }] },
    { t: "text", v: " " },
    { t: "strike", c: [{ t: "text", v: "gone" }] },
    { t: "text", v: " " },
    { t: "spoiler", c: [{ t: "text", v: "secret" }] },
  ]);
});

test("snake_case and arithmetic are not emphasis", () => {
  assert.deepEqual(parseInline("use snake_case_names"), [{ t: "text", v: "use snake_case_names" }]);
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ t: "text", v: "2 * 3 * 4" }]);
  assert.deepEqual(parseInline("_real italic_"), [{ t: "italic", c: [{ t: "text", v: "real italic" }] }]);
});

test("inline code wins over everything inside it", () => {
  assert.deepEqual(parseInline("run `**not bold** <@" + A + ">` now"), [
    { t: "text", v: "run " },
    { t: "code", v: `**not bold** <@${A}>` },
    { t: "text", v: " now" },
  ]);
});

test("escapes keep markup characters literal", () => {
  assert.deepEqual(parseInline("\\*not italic\\*"), [{ t: "text", v: "*not italic*" }]);
});

test("links auto-link and give trailing punctuation back to the sentence", () => {
  assert.deepEqual(parseInline("see https://batch0.org/program."), [
    { t: "text", v: "see " },
    { t: "link", href: "https://batch0.org/program", v: "https://batch0.org/program" },
    { t: "text", v: "." },
  ]);
  assert.equal(trimUrl("https://en.wikipedia.org/wiki/Foo_(bar))"), "https://en.wikipedia.org/wiki/Foo_(bar)");
  assert.equal(trimUrl("https://x.com/a)"), "https://x.com/a");
});

test("only http(s) links are links", () => {
  assert.deepEqual(parseInline("javascript:alert(1)"), [{ t: "text", v: "javascript:alert(1)" }]);
  assert.deepEqual(parseInline("ftp://x"), [{ t: "text", v: "ftp://x" }]);
});

test("a URL glued to a word is not linked", () => {
  assert.deepEqual(parseInline("xhttps://evil"), [{ t: "text", v: "xhttps://evil" }]);
});

test("mentions, channel links and @everyone parse", () => {
  assert.deepEqual(parseInline(`hey <@${A}> see <#${C}> @everyone`), [
    { t: "text", v: "hey " },
    { t: "mention", id: A },
    { t: "text", v: " see " },
    { t: "channel", id: C },
    { t: "text", v: " " },
    { t: "everyone", v: "everyone" },
  ]);
  assert.deepEqual(parseInline("mail@everyone.com"), [{ t: "text", v: "mail@everyone.com" }]);
});

test("code fences make code blocks with an optional language", () => {
  assert.deepEqual(parseBody("before\n```ts\nconst x = 1;\n**y**\n```\nafter"), [
    { t: "text", c: [{ t: "text", v: "before" }] },
    { t: "codeblock", lang: "ts", v: "const x = 1;\n**y**" },
    { t: "text", c: [{ t: "text", v: "after" }] },
  ]);
  assert.deepEqual(parseBody("```one liner```"), [{ t: "codeblock", lang: null, v: "one liner" }]);
});

test("an unclosed fence stays text", () => {
  assert.deepEqual(parseBody("```\nnot closed"), [
    { t: "text", c: [{ t: "text", v: "```" }, { t: "br" }, { t: "text", v: "not closed" }] },
  ]);
});

test("quotes group consecutive > lines", () => {
  assert.deepEqual(parseBody("> one\n> two\nreply"), [
    { t: "quote", c: [{ t: "text", v: "one" }, { t: "br" }, { t: "text", v: "two" }] },
    { t: "text", c: [{ t: "text", v: "reply" }] },
  ]);
});

test("mentionedIds ignores code and dedupes", () => {
  assert.deepEqual(mentionedIds(`<@${A}> and <@${B}> and <@${A}> \`<@${C}>\`\n\`\`\`\n<@${C}>\n\`\`\``), [A, B]);
});

test("mentionsEveryone ignores code", () => {
  assert.equal(mentionsEveryone("ping @here"), true);
  assert.equal(mentionsEveryone("`@everyone`"), false);
  assert.equal(mentionsEveryone("no ping"), false);
});

test("linkedChannelIds", () => {
  assert.deepEqual(linkedChannelIds(`go to <#${C}>`), [C]);
});

test("plainText resolves names, hides spoilers and truncates", () => {
  const names = (id: string) => (id === A ? "Maya" : null);
  assert.equal(plainText(`**hi** <@${A}> ||the twist||\nline two`, names), "hi @Maya ▮▮▮ line two");
  assert.equal(plainText(`<@${B}>`, names), "@someone");
  assert.equal(plainText("x".repeat(200), names, undefined, 10), "xxxxxxxxx…");
});

test("encodeMentions turns picked @Names into ids, longest first, whole words only", () => {
  const picked = [
    { id: A, name: "Sam" },
    { id: B, name: "Sam Lee" },
  ];
  assert.equal(encodeMentions("@Sam Lee and @Sam, not @Samantha", picked), `<@${B}> and <@${A}>, not @Samantha`);
});

test("decodeMentions round-trips through encodeMentions", () => {
  const names = (id: string) => ({ [A]: "Maya Chen", [B]: "Dev" } as Record<string, string>)[id];
  const body = `hi <@${A}> and <@${B}>! <@${C}>`;
  const { text, picked } = decodeMentions(body, names);
  assert.equal(text, `hi @Maya Chen and @Dev! <@${C}>`);
  assert.equal(encodeMentions(text, picked), body);
});

test("mentionQueryAt finds the @query at the caret", () => {
  assert.deepEqual(mentionQueryAt("hello @ma", 9), { start: 6, query: "ma" });
  assert.deepEqual(mentionQueryAt("@", 1), { start: 0, query: "" });
  assert.equal(mentionQueryAt("email@x", 7), null);
  assert.equal(mentionQueryAt("@ma\nx", 5), null);
  assert.deepEqual(mentionQueryAt("@Maya Ch", 8), { start: 0, query: "Maya Ch" });
});

test("isJumboEmoji", () => {
  assert.equal(isJumboEmoji("🎉"), true);
  assert.equal(isJumboEmoji("🔥 🚀"), true);
  assert.equal(isJumboEmoji("👍🏽"), true);
  assert.equal(isJumboEmoji("❤️"), true);
  assert.equal(isJumboEmoji("nice 🎉"), false);
  assert.equal(isJumboEmoji("123"), false);
  assert.equal(isJumboEmoji(""), false);
});
