import test from "node:test";
import assert from "node:assert/strict";
import {
  composeMessage,
  cutBody,
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
  rawText,
  rebaseMentions,
  trimUrl,
  URL_MAX,
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
  // A bare ">" carries the quote over an empty line.
  assert.deepEqual(parseBody("> one\n>\n> three"), [
    { t: "quote", c: [{ t: "text", v: "one" }, { t: "br" }, { t: "br" }, { t: "text", v: "three" }] },
  ]);
});

test("a quote needs '> ': emoticons and '>5' stay text, and a lone '>' is never an empty message", () => {
  const text = (v: string) => [{ t: "text", c: [{ t: "text", v }] }];
  assert.deepEqual(parseBody(">.<"), text(">.<"));
  assert.deepEqual(parseBody(">:( sad"), text(">:( sad"));
  assert.deepEqual(parseBody(">5 people came"), text(">5 people came"));
  assert.deepEqual(parseBody(">"), text(">"));
  assert.deepEqual(parseBody("> \n>"), [{ t: "text", c: [{ t: "text", v: "> " }, { t: "br" }, { t: "text", v: ">" }] }]);
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
  // Someone the server didn't vet for this message reads as the message shows them.
  assert.equal(plainText(`<@${B}>`, names), "@unknown");
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

// ---------------------------------------------------------------------------
// Cost: one crafted body must cost what any other body costs
// ---------------------------------------------------------------------------

/**
 * Milliseconds for one full parse (what the server pays per message, and
 * each reader's browser): the best of a few runs, after a warm-up, so a GC
 * pause doesn't read as a slow parser.
 */
function parseMs(body: string): number {
  mentionedIds(body);
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const t = performance.now();
    mentionedIds(body);
    plainText(body);
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

const fill = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

test("adversarial bodies parse in linear time", () => {
  const shapes: Record<string, (n: number) => string> = {
    "a URL closed by thousands of parens": (n) => "https://x/" + ")".repeat(n - 10),
    "a URL of nested opens": (n) => fill("(https://", n),
    "italic openers that never close (a._)": (n) => fill("a._", n),
    "italic openers that never close ( *a)": (n) => fill(" *a", n),
    "italic openers that never close ((_a)": (n) => fill("(_a", n),
    "italic openers that never close ( _a)": (n) => fill(" _a", n),
    "pair openers with blank insides": (n) => fill("** ", n),
    "spoiler openers": (n) => fill("||x ", n),
    "one long run of stars": (n) => "*".repeat(n),
    "every marker nested": (n) => fill("**~~||*_", n),
    "escapes": (n) => fill("\\*", n),
    "code ticks": (n) => fill("`a", n),
    "unclosed fences": (n) => fill("```a\n", n),
    "@ everywhere": (n) => fill("(@everyonex", n),
  };
  for (const [name, make] of Object.entries(shapes)) {
    for (const n of [4000, 20000]) {
      const ms = parseMs(make(n));
      assert.ok(ms < 50, `${name}, ${n} chars: ${ms.toFixed(1)} ms`);
    }
  }
});

test("a 20,000-char URL of parens costs about what a 4,000-char one does, times five", () => {
  const small = Math.max(parseMs("https://x/" + ")".repeat(3990)), 0.2);
  const big = parseMs("https://x/" + ")".repeat(19990));
  // Quadratic would be 25x; allow generous noise above linear.
  assert.ok(big < small * 15, `4k: ${small.toFixed(2)} ms, 20k: ${big.toFixed(2)} ms`);
});

test("trimUrl balances parens the way it always has", () => {
  assert.equal(trimUrl("https://x/" + ")".repeat(3990)), "https://x/");
  assert.equal(trimUrl("https://x.com/a_(b)_(c))."), "https://x.com/a_(b)_(c)");
  assert.equal(trimUrl("https://x.com/q?a=1&b=(2)!"), "https://x.com/q?a=1&b=(2)");
});

test("an auto-link longer than URL_MAX stays text", () => {
  const long = "https://x.com/" + "a".repeat(URL_MAX);
  assert.deepEqual(parseInline(`see ${long} ok`), [{ t: "text", v: `see ${long} ok` }]);
  const fits = "https://x.com/" + "a".repeat(URL_MAX - 20);
  assert.deepEqual(parseInline(fits), [{ t: "link", href: fits, v: fits }]);
  // Nothing to link after the scheme: text.
  assert.deepEqual(parseInline("https://..."), [{ t: "text", v: "https://..." }]);
});

// ---------------------------------------------------------------------------
// Closers: code and escapes don't close emphasis
// ---------------------------------------------------------------------------

test("a marker inside inline code never closes the span around it", () => {
  assert.deepEqual(parseInline("||the fix is `if (a || b)` here||"), [
    { t: "spoiler", c: [{ t: "text", v: "the fix is " }, { t: "code", v: "if (a || b)" }, { t: "text", v: " here" }] },
  ]);
  assert.deepEqual(parseInline("**run `a**b` now**"), [
    { t: "bold", c: [{ t: "text", v: "run " }, { t: "code", v: "a**b" }, { t: "text", v: " now" }] },
  ]);
  assert.deepEqual(parseInline("*use `x*y` here*"), [
    { t: "italic", c: [{ t: "text", v: "use " }, { t: "code", v: "x*y" }, { t: "text", v: " here" }] },
  ]);
  assert.equal(plainText("||the fix is `if (a || b)` here||"), "▮▮▮");
});

test("an escaped marker is text, never a closer", () => {
  assert.deepEqual(parseInline("*a \\* b*"), [{ t: "italic", c: [{ t: "text", v: "a * b" }] }]);
  assert.deepEqual(parseInline("||a \\|| b||"), [{ t: "spoiler", c: [{ t: "text", v: "a || b" }] }]);
  assert.deepEqual(parseInline("_x\\_"), [{ t: "text", v: "_x_" }]);
});

test("the closing *** of bold-italic, and emphasis around links and mentions", () => {
  assert.deepEqual(parseInline("***both***"), [{ t: "bold", c: [{ t: "italic", c: [{ t: "text", v: "both" }] }] }]);
  assert.deepEqual(parseInline("**see https://x.com/a**"), [
    { t: "bold", c: [{ t: "text", v: "see " }, { t: "link", href: "https://x.com/a", v: "https://x.com/a" }] },
  ]);
  assert.deepEqual(parseInline(`_hi <@${A}>_`), [{ t: "italic", c: [{ t: "text", v: "hi " }, { t: "mention", id: A }] }]);
  assert.deepEqual(parseInline("_@everyone_"), [{ t: "italic", c: [{ t: "everyone", v: "everyone" }] }]);
});

// ---------------------------------------------------------------------------
// Previews and copies
// ---------------------------------------------------------------------------

const SECRET = "||" + "Bruce Willis was dead the whole time. ".repeat(8) + "||";

test("plainText of a stored preview cut mid-spoiler keeps the spoiler hidden", () => {
  const left140 = Array.from(SECRET).slice(0, 140).join(""); // what the sidebar column holds
  assert.match(plainText(left140), /^\|\|Bruce Willis/, "without the hint, an unclosed || is just text");
  assert.equal(plainText(left140, undefined, undefined, 80, { cut: true }), "▮▮▮");
  // ...and a cut through a mention drops the half token.
  assert.equal(plainText(`hi <@${A.slice(0, 10)}`, undefined, undefined, 80, { cut: true }), "hi");
});

test("cutBody cuts on a code point, never through a token, and closes a spoiler it cuts", () => {
  const cut = cutBody(SECRET, 300);
  assert.ok(cut.length <= 300);
  assert.equal(plainText(cut), "▮▮▮");
  const token = `${"x".repeat(280)} <@${A}> and more text after it`;
  assert.equal(cutBody(token, 300), `${"x".repeat(280)} `);
  const emoji = "a".repeat(297) + "🎉🎉";
  assert.ok(!/[\uD800-\uDBFF]$/.test(cutBody(emoji, 300)));
  assert.equal(cutBody("short", 300), "short");
});

test("plainText truncates by code points, never half an emoji", () => {
  const out = plainText("a".repeat(78) + "🎉🎉🎉", undefined, undefined, 80);
  assert.equal(out, "a".repeat(78) + "🎉…");
  assert.equal(plainText("a".repeat(78) + "🎉🎉", undefined, undefined, 80), "a".repeat(78) + "🎉🎉");
});

test("rawText keeps what was written — lines, code, spoilers — and names the mentions", () => {
  const names = (id: string) => (id === A ? "Maya" : null);
  const channels = (id: string) => (id === C ? "general" : null);
  const body = `hi <@${A}> and <@${B}> in <#${C}>\n||you are a jerk||\n\`<@${A}>\`\n\`\`\`py\nif x:\n    y(<@${A}>)\n\`\`\``;
  assert.equal(
    rawText(body, names, channels),
    `hi @Maya and @unknown in #general\n||you are a jerk||\n\`<@${A}>\`\n\`\`\`py\nif x:\n    y(<@${A}>)\n\`\`\``,
  );
  assert.equal(rawText("\\<@" + A + ">", names), "\\<@" + A + ">");
});

// ---------------------------------------------------------------------------
// The mention codec, by position
// ---------------------------------------------------------------------------

test("two people with the same name: each pick encodes where it was picked", () => {
  const both = [
    { id: A, name: "Alex Kim", start: 0 },
    { id: B, name: "Alex Kim", start: 14 },
  ];
  assert.equal(encodeMentions("@Alex Kim and @Alex Kim", both), `<@${A}> and <@${B}>`);
  // Picked A, deleted it, picked B in the same spot: B.
  assert.equal(encodeMentions("hi @Alex Kim", [{ id: A, name: "Alex Kim", start: 3 }, { id: B, name: "Alex Kim", start: 3 }]), `hi <@${B}>`);
  // The same without positions (an older caller): the later pick, still.
  assert.equal(encodeMentions("hi @Alex Kim", [{ id: A, name: "Alex Kim" }, { id: B, name: "Alex Kim" }]), `hi <@${B}>`);
});

test("editing a message re-encodes exactly the mentions it had", () => {
  const names = (id: string) => ({ [A]: "Sam", [B]: "Sam Lee" } as Record<string, string>)[id];
  const prefix = decodeMentions(`<@${A}> Lee and <@${B}>`, names);
  assert.equal(prefix.text, "@Sam Lee and @Sam Lee");
  assert.equal(encodeMentions(prefix.text, prefix.picked), `<@${A}> Lee and <@${B}>`);
  // A "@Sam" typed as text stays text.
  const literal = decodeMentions(`<@${A}> said @Sam is here`, names);
  assert.equal(encodeMentions(literal.text, literal.picked), `<@${A}> said @Sam is here`);
  // Text inserted in front without a rebase: each pick finds its own nearest "@Name".
  assert.equal(encodeMentions(`x ${prefix.text}`, prefix.picked), `x <@${A}> Lee and <@${B}>`);
});

test("rebaseMentions follows edits and drops a mention the edit broke", () => {
  const picked = [
    { id: A, name: "Sam", start: 0 },
    { id: B, name: "Dev", start: 9 },
  ];
  const text = "@Sam and @Dev";
  assert.equal(rebaseMentions(text, `${text}!`, picked, text.length + 1), picked, "typing after both: nothing moves");
  const front = rebaseMentions(text, `Hey ${text}`, picked, 4);
  assert.deepEqual(front.map((p) => p.start), [4, 13]);
  assert.equal(encodeMentions(`Hey ${text}`, front), `Hey <@${A}> and <@${B}>`);
  const broken = rebaseMentions(text, "@Sxam and @Dev", picked, 3);
  assert.deepEqual(broken, [{ id: B, name: "Dev", start: 10 }]);
  assert.equal(encodeMentions("@Sxam and @Dev", broken), `@Sxam and <@${B}>`);
  // "@" typed right in front of "@Sam": the caret says which "@" is new.
  assert.deepEqual(rebaseMentions("@Sam ", "@@Sam ", [{ id: A, name: "Sam", start: 0 }], 1), [{ id: A, name: "Sam", start: 1 }]);
  assert.deepEqual(rebaseMentions("@Sam", "@Sam!", [{ id: A, name: "Sam" }], 5), [{ id: A, name: "Sam" }]);
});

test("a name only matches whole, and not glued to a word", () => {
  const legacy = [{ id: A, name: "Sam" }];
  assert.equal(encodeMentions("@Sam, @Samantha, email@Sam, @Sam-x", legacy), `<@${A}>, @Samantha, email@Sam, @Sam-x`);
  assert.equal(encodeMentions("hi @Sam", [{ id: A, name: "Sam", start: 3 }]), `hi <@${A}>`);
  assert.equal(encodeMentions("hi x@Sam", [{ id: A, name: "Sam", start: 4 }]), "hi x@Sam");
});

test("composeMessage is what the server measures: encoded, then trimmed", () => {
  const text = `  ${"a".repeat(3950)} @Al @Al  `;
  const picked = [
    { id: A, name: "Al", start: 3953 },
    { id: B, name: "Al", start: 3957 },
  ];
  const body = composeMessage(text, picked);
  assert.ok(text.trim().length <= 4000);
  assert.equal(body, `${"a".repeat(3950)} <@${A}> <@${B}>`);
  assert.equal(body.length, 3950 + 1 + 39 + 1 + 39);
});

test("isJumboEmoji counts graphemes: flags, keycaps and ZWJ families; not text symbols", () => {
  for (const yes of ["🇺🇸", "🇺🇸🇬🇧", "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "1️⃣", "#️⃣", "👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦", "🏳️‍🌈", "🧑🏽‍💻", "™️", "🎉".repeat(10), "🎉\n🎉"]) {
    assert.equal(isJumboEmoji(yes), true, yes);
  }
  for (const no of ["™", "©", "®", "↔", "❤︎", "🎉".repeat(11), "#", "1", "*"]) {
    assert.equal(isJumboEmoji(no), false, no);
  }
});
