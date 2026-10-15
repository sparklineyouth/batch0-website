// ---------------------------------------------------------------------------
// batch0 Chat — message markup.
//
// A message body is plain text with a small, Discord-shaped markup:
//
//   **bold**  *italic* _italic_  ~~strike~~  ||spoiler||  `code`
//   ```lang            > quoted line
//   a code block       https://links.auto-link
//   ```                <@uuid> a mention   <#uuid> a channel   @everyone @here
//
// This module turns a body into a small tree that components/chat/markup.tsx
// renders as React elements — never as HTML, so nothing a person types can
// become markup in someone else's browser. It also owns the mention codec
// the composer uses (people see "@Maya Chen", the stored body says
// <@uuid>), the mention extraction the server trusts, and plain-text
// previews. Import-free, so `node --test` runs it as-is and both sides of
// the wire can use it.
// ---------------------------------------------------------------------------

export type Inline =
  | { t: "text"; v: string }
  | { t: "br" }
  | { t: "code"; v: string }
  | { t: "bold"; c: Inline[] }
  | { t: "italic"; c: Inline[] }
  | { t: "strike"; c: Inline[] }
  | { t: "spoiler"; c: Inline[] }
  | { t: "link"; href: string; v: string }
  | { t: "mention"; id: string }
  | { t: "channel"; id: string }
  | { t: "everyone"; v: "everyone" | "here" };

export type Block =
  | { t: "text"; c: Inline[] }
  | { t: "quote"; c: Inline[] }
  | { t: "codeblock"; lang: string | null; v: string };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MENTION_RE = new RegExp(`^<@(${UUID})>`, "i");
const CHANNEL_RE = new RegExp(`^<#(${UUID})>`, "i");
const URL_RE = /^https?:\/\/[^\s<>"]+/i;
const EVERYONE_RE = /^@(everyone|here)(?![\w-])/;
const MAX_DEPTH = 6;

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export function parseBody(body: string): Block[] {
  const lines = (body ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let text: string[] = [];
  let quote: string[] = [];

  const flushText = () => {
    if (text.length === 0) return;
    blocks.push({ t: "text", c: inlineLines(text) });
    text = [];
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    blocks.push({ t: "quote", c: inlineLines(quote) });
    quote = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const after = fence[1];
      // ```one line``` is a code block too.
      if (after.length > 3 && after.endsWith("```")) {
        flushText();
        flushQuote();
        blocks.push({ t: "codeblock", lang: null, v: after.slice(0, -3) });
        continue;
      }
      // An unclosed fence stays text, as it does in Discord.
      const end = lines.findIndex((l, j) => j > i && /^\s*```\s*$/.test(l));
      if (end !== -1) {
        flushText();
        flushQuote();
        const lang = after.match(/^([A-Za-z0-9_+-]{1,20})\s*$/)?.[1] ?? null;
        const opening = !lang && after.trim() ? [after] : [];
        blocks.push({ t: "codeblock", lang, v: [...opening, ...lines.slice(i + 1, end)].join("\n") });
        i = end;
        continue;
      }
    }
    const q = line.match(/^>\s?(.*)$/);
    if (q && !line.startsWith(">>>")) {
      flushText();
      quote.push(q[1]);
      continue;
    }
    flushQuote();
    text.push(line);
  }
  flushText();
  flushQuote();
  // Trim blank lines off both ends of text blocks: a message that ends in a
  // newline shouldn't render an empty line under itself.
  return blocks
    .map((b) => (b.t === "codeblock" ? b : { ...b, c: trimBreaks(b.c) }))
    .filter((b) => b.t === "codeblock" || b.c.length > 0);
}

function inlineLines(lines: string[]): Inline[] {
  const out: Inline[] = [];
  lines.forEach((l, i) => {
    if (i > 0) out.push({ t: "br" });
    out.push(...parseInline(l, 0));
  });
  return out;
}

function trimBreaks(nodes: Inline[]): Inline[] {
  let start = 0;
  let end = nodes.length;
  while (start < end && isBlank(nodes[start])) start++;
  while (end > start && isBlank(nodes[end - 1])) end--;
  return nodes.slice(start, end);
}

function isBlank(n: Inline): boolean {
  return n.t === "br" || (n.t === "text" && n.v.trim() === "");
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

const PAIRS: { open: string; type: "bold" | "strike" | "spoiler" }[] = [
  { open: "**", type: "bold" },
  { open: "~~", type: "strike" },
  { open: "||", type: "spoiler" },
];

export function parseInline(s: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const push = (n: Inline) => {
    if (buf) {
      out.push({ t: "text", v: buf });
      buf = "";
    }
    out.push(n);
  };

  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const rest = s.slice(i);

    if (ch === "\\" && i + 1 < s.length && /[*_~|`\\<>@#]/.test(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      const close = s.indexOf("`", i + 1);
      if (close > i + 1) {
        push({ t: "code", v: s.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    if (ch === "<") {
      const m = rest.match(MENTION_RE);
      if (m) {
        push({ t: "mention", id: m[1].toLowerCase() });
        i += m[0].length;
        continue;
      }
      const c = rest.match(CHANNEL_RE);
      if (c) {
        push({ t: "channel", id: c[1].toLowerCase() });
        i += c[0].length;
        continue;
      }
    }

    if ((ch === "h" || ch === "H") && (i === 0 || /[\s(\[{"'*_~|]/.test(s[i - 1]))) {
      const u = rest.match(URL_RE);
      if (u) {
        const href = trimUrl(u[0]);
        push({ t: "link", href, v: href });
        i += href.length;
        continue;
      }
    }

    if (ch === "@" && (i === 0 || /[\s(\[{"'*_~|]/.test(s[i - 1]))) {
      const e = rest.match(EVERYONE_RE);
      if (e) {
        push({ t: "everyone", v: e[1] as "everyone" | "here" });
        i += e[0].length;
        continue;
      }
    }

    if (depth < MAX_DEPTH) {
      const pair = PAIRS.find((p) => rest.startsWith(p.open));
      if (pair) {
        let close = s.indexOf(pair.open, i + pair.open.length);
        // "***" closes bold AND an italic inside it: the bold takes the last two.
        while (close !== -1 && s[close + pair.open.length] === pair.open[0]) close++;
        if (close > i + pair.open.length) {
          const inner = s.slice(i + pair.open.length, close);
          if (inner.trim()) {
            push({ t: pair.type, c: parseInline(inner, depth + 1) });
            i = close + pair.open.length;
            continue;
          }
        }
      }
      if (ch === "*" || ch === "_") {
        const italic = matchItalic(s, i, ch);
        if (italic !== null) {
          push({ t: "italic", c: parseInline(s.slice(i + 1, italic), depth + 1) });
          i = italic + 1;
          continue;
        }
      }
    }

    buf += ch;
    i++;
  }
  if (buf) out.push({ t: "text", v: buf });
  return out;
}

/**
 * Closing index of a single-character italic, or null. `_` must sit on a
 * word boundary so snake_case_names stay text; neither marker may hug a
 * space on the inside ("2 * 3 * 4" is arithmetic, not emphasis).
 */
function matchItalic(s: string, i: number, ch: "*" | "_"): number | null {
  if (s[i + 1] === ch || s[i + 1] === undefined || /\s/.test(s[i + 1])) return null;
  if (ch === "_" && i > 0 && /[A-Za-z0-9]/.test(s[i - 1])) return null;
  for (let j = i + 2; j < s.length; j++) {
    if (s[j] !== ch) continue;
    if (s[j + 1] === ch) {
      j++;
      continue;
    }
    if (/\s/.test(s[j - 1])) continue;
    if (ch === "_" && j + 1 < s.length && /[A-Za-z0-9]/.test(s[j + 1])) continue;
    return j;
  }
  return null;
}

/**
 * A URL as people type it in a sentence: trailing punctuation belongs to the
 * sentence, and a closing paren only belongs to the URL when it opened one.
 */
export function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url[url.length - 1];
    if (/[.,!?:;'"*_~|]/.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ")") {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (closes > opens) {
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return url;
}

// ---------------------------------------------------------------------------
// What a body says: mentions, previews
// ---------------------------------------------------------------------------

function walk(blocks: Block[], visit: (n: Inline) => void) {
  const go = (nodes: Inline[]) => {
    for (const n of nodes) {
      visit(n);
      if ("c" in n) go(n.c);
    }
  };
  for (const b of blocks) if (b.t !== "codeblock") go(b.c);
}

/** The people a body mentions, in order, once each. Code is never a mention. */
export function mentionedIds(body: string): string[] {
  const ids: string[] = [];
  walk(parseBody(body), (n) => {
    if (n.t === "mention" && !ids.includes(n.id)) ids.push(n.id);
  });
  return ids;
}

/** Does the body ping @everyone or @here (outside code)? */
export function mentionsEveryone(body: string): boolean {
  let found = false;
  walk(parseBody(body), (n) => {
    if (n.t === "everyone") found = true;
  });
  return found;
}

/** The channels a body links to. */
export function linkedChannelIds(body: string): string[] {
  const ids: string[] = [];
  walk(parseBody(body), (n) => {
    if (n.t === "channel" && !ids.includes(n.id)) ids.push(n.id);
  });
  return ids;
}

type NameOf = (id: string) => string | null | undefined;

/**
 * One line of plain text for a sidebar preview or a reply quote: markup
 * dropped, mentions as names, spoilers hidden, newlines as spaces.
 */
export function plainText(
  body: string,
  people: NameOf = () => null,
  channels: NameOf = () => null,
  max = 140,
): string {
  const parts: string[] = [];
  const inline = (nodes: Inline[]) => {
    for (const n of nodes) {
      switch (n.t) {
        case "text":
        case "code":
          parts.push(n.v);
          break;
        case "br":
          parts.push(" ");
          break;
        case "link":
          parts.push(n.v);
          break;
        case "mention":
          parts.push(`@${people(n.id) ?? "someone"}`);
          break;
        case "channel":
          parts.push(`#${channels(n.id) ?? "channel"}`);
          break;
        case "everyone":
          parts.push(`@${n.v}`);
          break;
        case "spoiler":
          parts.push("▮▮▮");
          break;
        default:
          inline(n.c);
      }
    }
  };
  for (const b of parseBody(body)) {
    if (parts.length) parts.push(" ");
    if (b.t === "codeblock") parts.push(b.v);
    else inline(b.c);
  }
  const flat = parts.join("").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

// ---------------------------------------------------------------------------
// The composer's mention codec
// ---------------------------------------------------------------------------

export type PickedMention = { id: string; name: string };

/**
 * What the composer sends: each "@Name" the person picked from the
 * autocomplete becomes <@id>. Longest names first, so "@Sam Lee" isn't
 * claimed by a "@Sam" picked in the same message, and a name only matches
 * as a whole word.
 */
export function encodeMentions(text: string, picked: readonly PickedMention[]): string {
  let out = text;
  const unique = Array.from(new Map(picked.map((p) => [p.id, p])).values()).sort(
    (a, b) => b.name.length - a.name.length,
  );
  for (const p of unique) {
    if (!p.name) continue;
    const re = new RegExp(`@${escapeRegExp(p.name)}(?![\\p{L}\\p{N}_-])`, "gu");
    out = out.replace(re, `<@${p.id}>`);
  }
  return out;
}

/**
 * The reverse, for editing a sent message: <@id> back to "@Name", with the
 * picks to re-encode it on save. An id nobody can name stays as it was, so
 * saving the edit can't silently drop a mention.
 */
export function decodeMentions(body: string, people: NameOf): { text: string; picked: PickedMention[] } {
  const picked: PickedMention[] = [];
  const text = body.replace(new RegExp(`<@(${UUID})>`, "gi"), (whole, id: string) => {
    const name = people(id.toLowerCase());
    if (!name) return whole;
    if (!picked.some((p) => p.id === id.toLowerCase())) picked.push({ id: id.toLowerCase(), name });
    return `@${name}`;
  });
  return { text, picked };
}

/**
 * The "@que" being typed at the caret, for the autocomplete: from the last
 * "@" that starts a word up to the caret, with no newline in between.
 */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/[\s(\[{"']/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/[\n]/.test(query) || query.length > 40) return null;
  // Two spaces in a row, or a space before anything was typed, ends it.
  if (/^\s|\s\s/.test(query)) return null;
  return { start: at, query };
}

/** A body that is nothing but a few emoji renders large, like Discord. */
export function isJumboEmoji(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > 64) return false;
  if (!/^(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s*)+$/u.test(trimmed)) {
    return false;
  }
  const count = (trimmed.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  return count <= 10;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
