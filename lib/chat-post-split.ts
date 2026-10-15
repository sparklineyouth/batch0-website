// ---------------------------------------------------------------------------
// A post from outside the composer (an announcement cross-post) can be longer
// than one chat message. Rather than cut it and link to a page some of the
// channel's readers can't open (mentors, investors and accepted applicants
// read #announcements; a cohort's mentors read its channel), postToChannel
// (lib/chat-post.ts) posts the whole text as consecutive messages, split here.
//
// Pure and import-free but for the limit, so `node --test` runs it as is.
// ---------------------------------------------------------------------------

import { MESSAGE_MAX } from "./chat-access.ts";

/** Where a body may break, best first: a paragraph, a line, a word. */
const BREAKS = ["\n\n", "\n", " "] as const;

/** A fenced code block as lib/chat-format.ts reads one: its opener and closer lines. */
type Fence = { openStart: number; openEnd: number; closeStart: number; closeEnd: number; reopen: string };

const FENCE_OPEN = /^```(.*)$/;
const FENCE_CLOSE = /^\s*```\s*$/;
const FENCE_LANG = /^([A-Za-z0-9_+-]{1,20})\s*$/;
const CLOSE = "\n```";

/**
 * The fenced code blocks in a body, by offset. Same rule as chat-format's
 * chunkLines: a fence only counts when a closing fence follows it, and
 * "```one line```" is a block of its own that a line break can't fall inside.
 */
function fences(text: string, max: number): Fence[] {
  const lines = text.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  const end = (i: number) => starts[i] + lines[i].length;
  const out: Fence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(FENCE_OPEN);
    if (!open || (open[1].length > 3 && open[1].endsWith("```"))) continue;
    let j = i + 1;
    while (j < lines.length && !FENCE_CLOSE.test(lines[j])) j++;
    if (j >= lines.length) continue; // unclosed: just text
    // The next part reopens the block with its language, so its highlighting
    // carries on. Free text after an opener is already in the first part.
    const lang = open[1].match(FENCE_LANG)?.[1] ?? "";
    const reopen = 3 + lang.length + 1 < max / 8 ? "```" + lang : "```";
    out.push({ openStart: starts[i], openEnd: end(i), closeStart: starts[j], closeEnd: end(j), reopen });
    i = j;
  }
  return out;
}

/** The fence a cut at `at` would land inside: the head would hold its opener, not its closer. */
function fenceAround(list: Fence[], at: number): Fence | null {
  return list.find((f) => f.openStart < at && at < f.closeEnd) ?? null;
}

/** One message's worth off the front of `text` (longer than `max`), and what's left. */
function cutOnce(text: string, max: number): { head: string; tail: string } {
  const list = fences(text, max);
  const room = max - CLOSE.length; // space to close a code block the cut lands in
  const floor = Math.floor(room / 2); // a break earlier than this wastes half a message

  // The best break in the second half of the window, preferring one that
  // isn't inside a code block; a code block longer than that gets closed and
  // reopened around the cut.
  let cut: { headEnd: number; tailStart: number } | null = null;
  let inside: { headEnd: number; tailStart: number } | null = null;
  for (const sep of BREAKS) {
    for (let i = text.lastIndexOf(sep, room); i >= floor; i = text.lastIndexOf(sep, i - 1)) {
      const here = { headEnd: i, tailStart: i + sep.length };
      if (!fenceAround(list, i)) {
        cut = here;
        break;
      }
      inside ??= here;
    }
    if (cut) break;
  }
  if (!cut) cut = inside;
  if (!cut) {
    // One unbroken run (a long link, say): a hard cut, never through the
    // middle of a surrogate pair.
    let at = room;
    const c = text.charCodeAt(at - 1);
    if (c >= 0xd800 && c <= 0xdbff) at -= 1;
    cut = { headEnd: at, tailStart: at };
  }

  const fence = fenceAround(list, cut.headEnd);
  if (!fence) {
    return { head: text.slice(0, cut.headEnd).trimEnd(), tail: text.slice(cut.tailStart).trimStart() };
  }
  // Nothing of the block's body would be in this part: move its opener on.
  if (cut.headEnd <= fence.openEnd && text.slice(0, fence.openStart).trim()) {
    return { head: text.slice(0, fence.openStart).trimEnd(), tail: text.slice(fence.openStart) };
  }
  const head = text.slice(0, cut.headEnd).trimEnd() + CLOSE;
  // Nothing of it would be left for the next part: this part's close is its close.
  if (cut.tailStart >= fence.closeStart) return { head, tail: text.slice(fence.closeEnd).trimStart() };
  // Inside the block: keep the code's own indentation, drop only blank lines.
  return { head, tail: `${fence.reopen}\n${text.slice(cut.tailStart).replace(/^\n+/, "")}` };
}

/**
 * A body as the messages that carry it, each at most `max` characters:
 * trimmed, and when it's longer than one message, broken at the last
 * paragraph break that fits (then a line break, then a space; one unbroken
 * run is cut hard). A code block a break lands in is closed at the end of one
 * message and reopened at the start of the next, so both still render as
 * code. Empty for a blank body.
 */
export function splitPostBody(raw: string, max: number = MESSAGE_MAX): string[] {
  const cap = Math.max(16, Math.floor(max));
  let rest = raw.replace(/\r\n?/g, "\n").trim();
  const parts: string[] = [];
  while (rest.length > cap) {
    const { head, tail } = cutOnce(rest, cap);
    // Every cut takes at least a quarter of a message, so this always ends;
    // the guard is for a fence rule that someday doesn't.
    if (!head || tail.length >= rest.length) {
      parts.push(rest.slice(0, cap));
      rest = rest.slice(cap).trimStart();
      continue;
    }
    parts.push(head);
    rest = tail;
  }
  if (rest) parts.push(rest);
  return parts;
}
