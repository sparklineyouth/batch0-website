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
// <@uuid>), the mention extraction the server trusts, plain-text previews
// and the raw text "Copy text" and moderators read. Import-free, so
// `node --test` runs it as-is and both sides of the wire can use it.
//
// The parser is linear in the body's length. Every message on a page is
// parsed on the server (mention extraction) and in every reader's browser,
// so one crafted 4,000-character body must not cost more than any other:
// each line is indexed once (where code spans, escapes and marker runs are,
// where the next closer of each kind sits), and every lookup after that is
// a table read. lib/chat-format.test.ts times the adversarial shapes.
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
/** <@uuid> or <#uuid>, matched in place (sticky). Always this many characters. */
const TOKEN = new RegExp(`<([@#])(${UUID})>`, "iy");
const TOKEN_LEN = 39;
const SCHEME = /https?:\/\//iy;
/** The longest run of characters auto-linked; anything longer stays text. */
export const URL_MAX = 2048;
const MAX_DEPTH = 6;

const ESCAPABLE = /[*_~|`\\<>@#]/;
/** What may sit right before a link or an @everyone. */
const BOUNDARY = /[\s(\[{"'*_~|]/;
const WORDISH = /[\w-]/;
const ALNUM = /[A-Za-z0-9]/;
const SPACE = /\s/;
const URL_STOP = /[\s<>"]/;
const TRAILING = /[.,!?:;'"*_~|]/;
/** A line with none of these is plain text, which is most lines. */
const SPECIAL = /[\\`<@*_~|]|https?:\/\//i;

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

type Chunk =
  | { code: true; lang: string | null; v: string; first: number; last: number }
  | { code: false; line: number };

const FENCE_OPEN = /^```(.*)$/;
const FENCE_CLOSE = /^\s*```\s*$/;
const FENCE_LANG = /^([A-Za-z0-9_+-]{1,20})\s*$/;
/** "> quoted". Discord's rule: the space is required, so ">.<" and ">5 people" stay text. */
const QUOTE = /^> (.*)$/;

function splitLines(body: string): string[] {
  return (body ?? "").replace(/\r\n?/g, "\n").split("\n");
}

/**
 * A body's lines with the fenced code blocks pulled out. The next closing
 * fence is found from a table built back to front, so a body of unclosed
 * fences costs one pass, not one pass per fence.
 */
function chunkLines(lines: string[]): Chunk[] {
  const closing = new Int32Array(lines.length + 1).fill(-1);
  for (let i = lines.length - 1; i >= 0; i--) closing[i] = FENCE_CLOSE.test(lines[i]) ? i : closing[i + 1];
  const out: Chunk[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(FENCE_OPEN);
    if (fence) {
      const after = fence[1];
      // ```one line``` is a code block too.
      if (after.length > 3 && after.endsWith("```")) {
        out.push({ code: true, lang: null, v: after.slice(0, -3), first: i, last: i });
        continue;
      }
      // An unclosed fence stays text, as it does in Discord.
      const end = closing[i + 1];
      if (end !== -1) {
        const lang = after.match(FENCE_LANG)?.[1] ?? null;
        const opening = !lang && after.trim() ? [after] : [];
        out.push({ code: true, lang, v: [...opening, ...lines.slice(i + 1, end)].join("\n"), first: i, last: end });
        i = end;
        continue;
      }
    }
    out.push({ code: false, line: i });
  }
  return out;
}

/**
 * The body as blocks. `cut` says the body may have been cut off at its end
 * (a stored preview): a spoiler that runs into the cut then hides to the end
 * instead of showing as a literal "||" followed by its secret.
 */
export function parseBody(body: string, opts: { cut?: boolean } = {}): Block[] {
  return parse(body, !!opts.cut).blocks;
}

type Src = { s: string; raw: string; open: boolean };

function parse(body: string, cut: boolean): { blocks: Block[]; openSpoiler: boolean } {
  const lines = splitLines(body);
  const lastLine = lines.length - 1;
  const state = { openSpoiler: false };
  const blocks: Block[] = [];
  let text: Src[] = [];
  let quote: Src[] = [];

  const inlineOf = (src: Src[]): Inline[] => {
    const out: Inline[] = [];
    src.forEach((l, i) => {
      if (i > 0) out.push({ t: "br" });
      for (const n of parseLine(l.s, l.open, state)) out.push(n);
    });
    // Blank lines off both ends: a message that ends in a newline shouldn't
    // render an empty line under itself.
    return trimBreaks(out);
  };
  const flushText = () => {
    if (text.length === 0) return;
    const c = inlineOf(text);
    if (c.length) blocks.push({ t: "text", c });
    text = [];
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    const c = inlineOf(quote);
    // Quote marks around nothing are just the characters someone typed.
    if (c.length) blocks.push({ t: "quote", c });
    else for (const q of quote) text.push({ s: q.raw, raw: q.raw, open: q.open });
    quote = [];
  };

  for (const chunk of chunkLines(lines)) {
    if (chunk.code) {
      flushQuote();
      flushText();
      blocks.push({ t: "codeblock", lang: chunk.lang, v: chunk.v });
      continue;
    }
    const line = lines[chunk.line];
    const open = cut && chunk.line === lastLine;
    const q = QUOTE.exec(line);
    // A bare ">" carries a quote on over an empty line.
    if (q || (quote.length > 0 && line.trim() === ">")) {
      flushText();
      quote.push({ s: q ? q[1] : "", raw: line, open });
      continue;
    }
    flushQuote();
    text.push({ s: line, raw: line, open });
  }
  flushQuote();
  flushText();
  return { blocks, openSpoiler: state.openSpoiler };
}

function trimBreaks(nodes: Inline[]): Inline[] {
  let start = 0;
  let end = nodes.length;
  while (start < end && isBlank(nodes[start])) start++;
  while (end > start && isBlank(nodes[end - 1])) end--;
  return start === 0 && end === nodes.length ? nodes : nodes.slice(start, end);
}

function isBlank(n: Inline): boolean {
  return n.t === "br" || (n.t === "text" && n.v.trim() === "");
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

/**
 * One line, indexed. Built lazily: a line with no backticks never builds the
 * code table, one with no "*" never builds the italic one. Every table is
 * one pass over the line; with them, each lookup the parser makes is O(1).
 */
type Line = {
  s: string;
  n: number;
  /** The line is the last of a body that may have been cut (see parseBody). */
  open: boolean;
  /** A spoiler ran into the cut. */
  openedSpoiler: boolean;
  /** Index of the next "`" at or after k, or -1. */
  tick(): Int32Array;
  /**
   * 1 where a character stands for itself: not inside a code span and not
   * part of a backslash escape. Only these can close emphasis, so a marker
   * inside `code` never closes the span around it.
   */
  free(): Uint8Array;
  /** Runs of one free character: where the run through k ends (exclusive) and starts. */
  runEnd(): Int32Array;
  runStart(): Int32Array;
  /** The next k' ≥ k where a free "**" / "~~" / "||" starts, or -1. */
  pair(ch: PairChar): Int32Array;
  /** The next index ≥ k that can close a single "*" or "_", or -1 (see italicClose). */
  italic(ch: "*" | "_"): Int32Array;
  /** The first non-space index ≥ k (n when there is none). */
  solid(): Int32Array;
  /** Where a URL starting before k must stop (whitespace, <, >, "). */
  urlStop(): Int32Array;
};

type PairChar = "*" | "~" | "|";
const PAIR_TYPE: Record<PairChar, "bold" | "strike" | "spoiler"> = { "*": "bold", "~": "strike", "|": "spoiler" };

function indexLine(s: string, open: boolean): Line {
  const n = s.length;
  let tick: Int32Array | null = null;
  let free: Uint8Array | null = null;
  let runEnd: Int32Array | null = null;
  let runStart: Int32Array | null = null;
  let solid: Int32Array | null = null;
  let urlStop: Int32Array | null = null;
  const pairs = new Map<string, Int32Array>();
  const italics = new Map<string, Int32Array>();

  const line: Line = {
    s,
    n,
    open,
    openedSpoiler: false,
    tick() {
      if (!tick) {
        tick = new Int32Array(n + 2).fill(-1);
        for (let k = n - 1; k >= 0; k--) tick[k] = s.charCodeAt(k) === 96 ? k : tick[k + 1];
      }
      return tick;
    },
    free() {
      if (!free) {
        free = new Uint8Array(n + 1);
        const t = line.tick();
        let k = 0;
        while (k < n) {
          const c = s[k];
          if (c === "\\" && k + 1 < n && ESCAPABLE.test(s[k + 1])) {
            k += 2;
            continue;
          }
          if (c === "`" && t[k + 1] > k + 1) {
            k = t[k + 1] + 1;
            continue;
          }
          free[k] = 1;
          k++;
        }
      }
      return free;
    },
    runEnd() {
      if (!runEnd) {
        const f = line.free();
        runEnd = new Int32Array(n + 1);
        runEnd[n] = n;
        for (let k = n - 1; k >= 0; k--) runEnd[k] = k + 1 < n && f[k] && f[k + 1] && s[k + 1] === s[k] ? runEnd[k + 1] : k + 1;
      }
      return runEnd;
    },
    runStart() {
      if (!runStart) {
        const f = line.free();
        runStart = new Int32Array(n + 1);
        for (let k = 0; k < n; k++) runStart[k] = k > 0 && f[k] && f[k - 1] && s[k - 1] === s[k] ? runStart[k - 1] : k;
      }
      return runStart;
    },
    pair(ch) {
      let p = pairs.get(ch);
      if (!p) {
        const f = line.free();
        p = new Int32Array(n + 3).fill(-1);
        for (let k = n - 2; k >= 0; k--) p[k] = f[k] && s[k] === ch && s[k + 1] === ch ? k : p[k + 1];
        pairs.set(ch, p);
      }
      return p;
    },
    italic(ch) {
      let it = italics.get(ch);
      if (!it) {
        const f = line.free();
        const re = line.runEnd();
        const rs = line.runStart();
        it = new Int32Array(n + 3).fill(-1);
        for (let k = n - 1; k >= 1; k--) {
          // Scanning for a closer steps over "**" (or "__") two at a time, so in
          // a run of markers only the last one of an odd-length run can close —
          // "***" closes an italic and the bold around it. It can't hug a space
          // on the inside, and "_" can't be glued to a word (snake_case_names).
          const closes =
            f[k] === 1 &&
            s[k] === ch &&
            re[k] === k + 1 &&
            (k + 1 - rs[k]) % 2 === 1 &&
            !SPACE.test(s[k - 1]) &&
            !(ch === "_" && k + 1 < n && ALNUM.test(s[k + 1]));
          it[k] = closes ? k : it[k + 1];
        }
        italics.set(ch, it);
      }
      return it;
    },
    solid() {
      if (!solid) {
        solid = new Int32Array(n + 1);
        solid[n] = n;
        for (let k = n - 1; k >= 0; k--) solid[k] = SPACE.test(s[k]) ? solid[k + 1] : k;
      }
      return solid;
    },
    urlStop() {
      if (!urlStop) {
        urlStop = new Int32Array(n + 1);
        urlStop[n] = n;
        for (let k = n - 1; k >= 0; k--) urlStop[k] = URL_STOP.test(s[k]) ? k : urlStop[k + 1];
      }
      return urlStop;
    },
  };
  return line;
}

function parseLine(s: string, open: boolean, state: { openSpoiler: boolean }): Inline[] {
  if (!s) return [];
  if (!SPECIAL.test(s)) return [{ t: "text", v: s }];
  const line = indexLine(s, open);
  const out = inline(line, 0, s.length, 0);
  if (line.openedSpoiler) state.openSpoiler = true;
  return out;
}

/** One line of inline markup. */
export function parseInline(s: string, depth = 0): Inline[] {
  if (!s) return [];
  if (!SPECIAL.test(s)) return [{ t: "text", v: s }];
  return inline(indexLine(s, false), 0, s.length, depth);
}

/**
 * The inline nodes of line.s[from, to). Emphasis recurses into the same line
 * with a narrower range, never into a copy, so the tables stay valid. Each
 * level reads each character once; nesting stops at MAX_DEPTH.
 */
function inline(line: Line, from: number, to: number, depth: number): Inline[] {
  const s = line.s;
  const out: Inline[] = [];
  let buf = "";
  let mark = from; // text from here up to i isn't in buf yet
  const emit = (at: number, node: Inline) => {
    buf += s.slice(mark, at);
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
    out.push(node);
  };

  let i = from;
  while (i < to) {
    const ch = s[i];

    if (ch === "\\" && i + 1 < to && ESCAPABLE.test(s[i + 1])) {
      buf += s.slice(mark, i) + s[i + 1];
      i += 2;
      mark = i;
      continue;
    }

    if (ch === "`") {
      const close = line.tick()[i + 1];
      if (close > i + 1 && close < to) {
        emit(i, { t: "code", v: s.slice(i + 1, close) });
        i = mark = close + 1;
        continue;
      }
    }

    if (ch === "<" && i + TOKEN_LEN <= to) {
      TOKEN.lastIndex = i;
      const m = TOKEN.exec(s);
      if (m) {
        const id = m[2].toLowerCase();
        emit(i, m[1] === "@" ? { t: "mention", id } : { t: "channel", id });
        i = mark = i + TOKEN_LEN;
        continue;
      }
    }

    // A link or an @everyone starts a word: "xhttps://" and "mail@here" are text.
    const boundary = (ch === "h" || ch === "H" || ch === "@") && (i === from || BOUNDARY.test(s[i - 1]));

    if (ch !== "@" && boundary) {
      const end = linkEnd(line, i, to);
      if (end > 0) {
        const href = s.slice(i, end);
        emit(i, { t: "link", href, v: href });
        i = mark = end;
        continue;
      }
      if (end < 0) {
        // Too long to be a link someone means: the whole run stays text.
        i = -end;
        continue;
      }
    }

    if (ch === "@" && boundary) {
      const word = s.startsWith("everyone", i + 1) ? "everyone" : s.startsWith("here", i + 1) ? "here" : null;
      const end = word ? i + 1 + word.length : 0;
      if (word && end <= to && (end === to || !WORDISH.test(s[end]))) {
        emit(i, { t: "everyone", v: word });
        i = mark = end;
        continue;
      }
    }

    if (depth < MAX_DEPTH) {
      if ((ch === "*" || ch === "~" || ch === "|") && i + 1 < to && s[i + 1] === ch) {
        const close = pairClose(line, i, ch, to);
        if (close !== -1) {
          emit(i, { t: PAIR_TYPE[ch], c: inline(line, i + 2, close, depth + 1) });
          i = mark = close + 2;
          continue;
        }
        if (ch === "|" && line.open && to === line.n && line.solid()[i + 2] < to) {
          line.openedSpoiler = true;
          emit(i, { t: "spoiler", c: inline(line, i + 2, to, depth + 1) });
          i = mark = to;
          continue;
        }
      }
      if (ch === "*" || ch === "_") {
        const close = italicClose(line, i, ch, from, to);
        if (close !== -1) {
          emit(i, { t: "italic", c: inline(line, i + 1, close, depth + 1) });
          i = mark = close + 1;
          continue;
        }
      }
    }

    i++;
  }
  buf += s.slice(mark, to);
  if (buf) out.push({ t: "text", v: buf });
  return out;
}

/**
 * Where "**" (or "~~", "||") opened at i closes inside the range: the first
 * free pair after it, extended to the end of its run ("***" closes bold AND
 * an italic inside it: the bold takes the last two), with something other
 * than spaces between. -1 when it doesn't close.
 */
function pairClose(line: Line, i: number, ch: PairChar, to: number): number {
  const c = line.pair(ch)[i + 2];
  if (c === -1 || c + 2 > to) return -1;
  const close = Math.min(line.runEnd()[c], to) - 2;
  if (close <= i + 2 || line.solid()[i + 2] >= close) return -1;
  return close;
}

/**
 * Closing index of a single-character italic opened at i, or -1. `_` must sit
 * on a word boundary so snake_case_names stay text; neither marker may hug a
 * space on the inside ("2 * 3 * 4" is arithmetic, not emphasis).
 *
 * The table holds closers for the line as a whole; the one thing a range
 * changes is a run of markers that the range's end cuts through (the closer
 * of the emphasis around this one), which is checked as the range sees it.
 */
function italicClose(line: Line, i: number, ch: "*" | "_", from: number, to: number): number {
  const s = line.s;
  const next = s[i + 1];
  if (i + 1 >= to || next === ch || SPACE.test(next)) return -1;
  if (ch === "_" && i > from && ALNUM.test(s[i - 1])) return -1;
  const k = i + 2;
  if (k >= to) return -1;
  const f = line.free();
  const cutRun = to < line.n && s[to] === ch && f[to] === 1 && s[to - 1] === ch && f[to - 1] === 1 ? line.runStart()[to - 1] : -1;
  const j = line.italic(ch)[k];
  if (j !== -1 && j < to && (cutRun === -1 || j < cutRun)) return j;
  if (cutRun >= k && (to - cutRun) % 2 === 1 && !SPACE.test(s[to - 2])) return to - 1;
  return -1;
}

/**
 * The end of an auto-link starting at i: past the trailing punctuation that
 * belongs to the sentence. 0 when this isn't a link, or -(end of the run)
 * when the run is longer than URL_MAX and should stay text.
 */
function linkEnd(line: Line, i: number, to: number): number {
  SCHEME.lastIndex = i;
  const scheme = SCHEME.exec(line.s);
  if (!scheme) return 0;
  const head = i + scheme[0].length;
  const stop = Math.min(line.urlStop()[i], to);
  if (stop <= head) return 0;
  if (stop - i > URL_MAX) return -stop;
  const end = trimUrlEnd(line.s, i, stop);
  return end > head ? end : 0;
}

/**
 * A URL as people type it in a sentence: trailing punctuation belongs to the
 * sentence, and a closing paren only belongs to the URL when it opened one.
 * Parens are counted once, so this is linear however many there are.
 */
function trimUrlEnd(s: string, start: number, end: number): number {
  let opens = 0;
  let closes = 0;
  for (let k = start; k < end; k++) {
    const c = s.charCodeAt(k);
    if (c === 40) opens++;
    else if (c === 41) closes++;
  }
  while (end > start) {
    const last = s[end - 1];
    if (TRAILING.test(last)) {
      end--;
    } else if (last === ")" && closes > opens) {
      closes--;
      end--;
    } else {
      break;
    }
  }
  return end;
}

export function trimUrl(raw: string): string {
  return raw.slice(0, trimUrlEnd(raw, 0, raw.length));
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
  const ids = new Set<string>();
  walk(parseBody(body), (n) => {
    if (n.t === "mention") ids.add(n.id);
  });
  return Array.from(ids);
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
  const ids = new Set<string>();
  walk(parseBody(body), (n) => {
    if (n.t === "channel") ids.add(n.id);
  });
  return Array.from(ids);
}

type NameOf = (id: string) => string | null | undefined;

/** What a cut can leave at the end of a body: half a <@id>, half a surrogate pair. */
const CUT_TAIL = /(?:<[@#][0-9a-f-]{0,36}|[\uD800-\uDBFF])$/i;

/**
 * One line of plain text for a sidebar preview or a reply quote: markup
 * dropped, mentions as names, spoilers hidden, newlines as spaces, at most
 * `max` characters (code points, so an emoji is never cut in half). For a
 * body that was stored cut short, pass `{ cut: true }` so a spoiler the cut
 * ran into stays hidden. For the text as written, use rawText.
 */
export function plainText(
  body: string,
  people: NameOf = () => null,
  channels: NameOf = () => null,
  max = 140,
  opts: { cut?: boolean } = {},
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
          parts.push(`@${people(n.id) ?? "unknown"}`);
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
  const source = opts.cut ? (body ?? "").replace(CUT_TAIL, "") : body;
  for (const b of parseBody(source, { cut: opts.cut })) {
    if (parts.length) parts.push(" ");
    if (b.t === "codeblock") parts.push(b.v);
    else inline(b.c);
  }
  return clip(parts.join("").replace(/\s+/g, " ").trim(), max);
}

/** At most `max` code points, with an ellipsis when cut. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const points = Array.from(s);
  if (points.length <= max) return s;
  return `${points.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

/**
 * A body cut to at most `max` UTF-16 units for a preview that is parsed
 * again later (a reply quote): cut on a code point, never through a <@id>
 * or <#id>, and a spoiler the cut runs into is closed, so the preview hides
 * what the message hides. A body that fits comes back unchanged.
 */
export function cutBody(body: string, max: number): string {
  const s = body ?? "";
  if (s.length <= max) return s;
  let end = Math.max(0, max - 2); // room for a closing "||"
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  const lt = s.lastIndexOf("<", end - 1);
  if (lt !== -1 && lt > end - TOKEN_LEN) {
    TOKEN.lastIndex = lt;
    if (TOKEN.test(s)) end = lt;
  }
  const head = s.slice(0, end);
  return parse(head, true).openSpoiler ? `${head}||` : head;
}

/**
 * The tokens of a body outside code, each replaced by what `swap` returns
 * (null keeps it). `at` is where the replacement starts in the output, which
 * is what lets decodeMentions hand back positions.
 */
function mapTokens(body: string, swap: (kind: "@" | "#", id: string, at: number) => string | null): string {
  const lines = splitLines(body);
  let out = "";
  for (const chunk of chunkLines(lines)) {
    if (chunk.code) {
      for (let i = chunk.first; i <= chunk.last; i++) out += (i > 0 ? "\n" : "") + lines[i];
      continue;
    }
    if (chunk.line > 0) out += "\n";
    const s = lines[chunk.line];
    if (!s.includes("<")) {
      out += s;
      continue;
    }
    const free = indexLine(s, false).free();
    let k = 0;
    let lt = s.indexOf("<");
    while (lt !== -1) {
      TOKEN.lastIndex = lt;
      const m = free[lt] === 1 ? TOKEN.exec(s) : null;
      if (m) {
        out += s.slice(k, lt);
        const piece = swap(m[1] as "@" | "#", m[2].toLowerCase(), out.length);
        out += piece ?? m[0];
        k = lt + TOKEN_LEN;
        lt = s.indexOf("<", k);
      } else {
        lt = s.indexOf("<", lt + 1);
      }
    }
    out += s.slice(k);
  }
  return out;
}

/**
 * The body as its author wrote it — markup, spoilers, line breaks and code
 * kept exactly — with <@id> and <#id> outside code turned into @Name and
 * #name. For "Copy text" and a moderator's transcript, where the preview
 * flattener would hide spoilered words and lose every line break.
 */
export function rawText(body: string, people: NameOf = () => null, channels: NameOf = () => null): string {
  return mapTokens(body, (kind, id) => (kind === "@" ? `@${people(id) ?? "unknown"}` : `#${channels(id) ?? "channel"}`));
}

// ---------------------------------------------------------------------------
// The composer's mention codec
// ---------------------------------------------------------------------------

/**
 * A person picked from the "@" autocomplete. `start` is where the "@Name"
 * sits in the composer's text: the codec encodes exactly that span, so two
 * people with the same name, or one name that starts another, can't swap.
 * Keep it current as the text changes with rebaseMentions. A pick without a
 * `start` falls back to matching "@Name" anywhere (the old behavior).
 */
export type PickedMention = { id: string; name: string; start?: number };

/** Letters, digits, "_" or "-": a name followed by one of these isn't the whole name. */
const NAME_CHAR = /^[\p{L}\p{N}_-]/u;
const WORD_BEFORE = /[\p{L}\p{N}_]$/u;

/**
 * What the composer sends: each picked "@Name" becomes <@id>.
 *  1. A pick whose "@Name" is still where it was picked encodes there; when
 *     two picks claim one spot (picked, deleted, picked someone else), the
 *     later one wins.
 *  2. A pick whose text moved without being rebased takes the nearest free
 *     "@Name" to where it was.
 *  3. A pick with no position claims every free "@Name", longest names
 *     first, so "@Sam Lee" isn't claimed by a "@Sam"; a name picked for two
 *     people goes to the later pick.
 * A name only matches whole: "@Samantha" is not "@Sam", nor is "x@Sam".
 */
export function encodeMentions(text: string, picked: readonly PickedMention[]): string {
  const named = picked.filter((p) => p.name);
  if (named.length === 0) return text;
  const taken: { start: number; end: number; id: string }[] = [];
  const fits = (p: PickedMention, at: number) => {
    const end = at + 1 + p.name.length;
    return (
      at >= 0 &&
      text.startsWith(`@${p.name}`, at) &&
      (at === 0 || !WORD_BEFORE.test(text.slice(Math.max(0, at - 2), at))) &&
      !NAME_CHAR.test(text.slice(end, end + 2)) &&
      taken.every((t) => end <= t.start || at >= t.end)
    );
  };
  const take = (p: PickedMention, at: number) => taken.push({ start: at, end: at + 1 + p.name.length, id: p.id });
  const occurrences = (name: string) => {
    const found: number[] = [];
    for (let at = text.indexOf(`@${name}`); at !== -1; at = text.indexOf(`@${name}`, at + 1)) found.push(at);
    return found;
  };

  const placed = named.filter((p) => typeof p.start === "number");
  const moved: PickedMention[] = [];
  for (let k = placed.length - 1; k >= 0; k--) {
    const p = placed[k];
    if (fits(p, p.start!)) take(p, p.start!);
    else moved.push(p);
  }
  for (const p of moved) {
    let best = -1;
    for (const at of occurrences(p.name)) {
      if (fits(p, at) && (best === -1 || Math.abs(at - p.start!) < Math.abs(best - p.start!))) best = at;
    }
    if (best !== -1) take(p, best);
  }
  const loose = new Map<string, PickedMention>();
  for (const p of named) if (typeof p.start !== "number") loose.set(p.name, p);
  for (const p of Array.from(loose.values()).sort((a, b) => b.name.length - a.name.length)) {
    for (const at of occurrences(p.name)) if (fits(p, at)) take(p, at);
  }

  taken.sort((a, b) => a.start - b.start);
  let out = "";
  let k = 0;
  for (const t of taken) {
    out += `${text.slice(k, t.start)}<@${t.id}>`;
    k = t.end;
  }
  return out + text.slice(k);
}

/**
 * The body the composer will send for this text: mentions encoded, then
 * trimmed — what the server measures against MESSAGE_MAX, so a counter on
 * this can't say a message fits that the server then refuses (each "@Al"
 * becomes 39 characters of <@uuid>).
 */
export function composeMessage(text: string, picked: readonly PickedMention[]): string {
  return encodeMentions(text, picked).trim();
}

/**
 * Keep picks in step with an edit of the composer's text, from `prev` to
 * `next` (one onChange). Picks before the edit stay, picks after it shift,
 * and a pick the edit touched is dropped: it isn't that "@Name" any more.
 * Pass the caret after the edit when there is one; it places an edit that
 * repeated characters make ambiguous ("@" typed in front of "@Sam").
 * Returns the same array when nothing moved.
 */
export function rebaseMentions(
  prev: string,
  next: string,
  picked: readonly PickedMention[],
  caret?: number,
): PickedMention[] {
  if (prev === next || !picked.some((p) => typeof p.start === "number")) return picked as PickedMention[];
  const shortest = Math.min(prev.length, next.length);
  const suffixMax = typeof caret === "number" ? Math.min(shortest, Math.max(0, next.length - caret)) : shortest;
  let suffix = 0;
  while (suffix < suffixMax && prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  let prefix = 0;
  while (prefix < shortest - suffix && prev[prefix] === next[prefix]) prefix++;
  const editEnd = prev.length - suffix; // the edit replaced prev[prefix, editEnd)
  const delta = next.length - prev.length;

  let changed = false;
  const out: PickedMention[] = [];
  for (const p of picked) {
    if (typeof p.start !== "number") {
      out.push(p);
      continue;
    }
    const end = p.start + 1 + p.name.length;
    if (end <= prefix) {
      out.push(p);
    } else if (p.start >= editEnd) {
      if (delta !== 0) changed = true;
      out.push(delta === 0 ? p : { ...p, start: p.start + delta });
    } else {
      changed = true;
    }
  }
  return changed ? out : (picked as PickedMention[]);
}

/**
 * The reverse, for editing a sent message: <@id> back to "@Name", with one
 * pick per mention at its position, so saving re-encodes exactly those
 * spans — never a "@Name" the author typed as text. An id nobody can name
 * stays as it was, so saving the edit can't silently drop a mention, and
 * so does a token inside code, which readers see as typed.
 */
export function decodeMentions(body: string, people: NameOf): { text: string; picked: PickedMention[] } {
  const picked: PickedMention[] = [];
  const text = mapTokens(body ?? "", (kind, id, at) => {
    if (kind !== "@") return null;
    const name = people(id);
    if (!name) return null;
    picked.push({ id, name, start: at });
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

// ---------------------------------------------------------------------------
// Jumbo emoji
// ---------------------------------------------------------------------------

/** One emoji as a grapheme: a flag, a keycap, or a pictograph with its modifiers and ZWJ parts. */
const EMOJI =
  /^(?:\p{Regional_Indicator}{2}|[#*0-9]️?⃣|\p{Extended_Pictographic}(?:[️\p{Emoji_Modifier}\u{E0020}-\u{E007F}]|‍\p{Extended_Pictographic})*)$/u;
/**
 * …that shows as a picture. ©, ™ or ↔ alone are text symbols (no
 * Emoji_Presentation); with U+FE0F, a skin tone, a ZWJ or a keycap they're emoji.
 */
const EMOJI_LOOK = /^\p{Emoji_Presentation}|^\p{Regional_Indicator}|[️⃣‍\p{Emoji_Modifier}]/u;
/** Graphemes where Intl.Segmenter is missing (older Firefox): close enough for emoji. */
const CLUSTER =
  /\p{Regional_Indicator}{2}|[#*0-9]️?⃣|\p{Extended_Pictographic}(?:[️\p{Emoji_Modifier}\u{E0020}-\u{E007F}]|‍\p{Extended_Pictographic})*|[\s\S]/gu;
const JUMBO_MAX = 10;

let segmenter: Intl.Segmenter | null | undefined;

function graphemes(s: string): string[] {
  if (segmenter === undefined) {
    segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  }
  if (segmenter) return Array.from(segmenter.segment(s), (x) => x.segment);
  return s.match(CLUSTER) ?? [];
}

/** A body that is nothing but a few emoji (up to ten) renders large, like Discord. */
export function isJumboEmoji(body: string): boolean {
  const trimmed = (body ?? "").trim();
  if (!trimmed || trimmed.length > 200) return false;
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(trimmed)) return false;
  let count = 0;
  for (const g of graphemes(trimmed)) {
    if (!g.trim()) continue;
    if (!EMOJI.test(g) || !EMOJI_LOOK.test(g)) return false;
    if (++count > JUMBO_MAX) return false;
  }
  return count > 0;
}
