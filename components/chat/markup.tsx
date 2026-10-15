"use client";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { isJumboEmoji, parseBody, type Inline } from "@/lib/chat-format";

/**
 * A message body as React elements. lib/chat-format.ts parses; this renders.
 * Nothing here ever sets HTML: every string a person typed lands in a text
 * node, links are http(s) only (the parser refuses anything else) and open
 * in a new tab with no referrer and nofollow.
 */

const SITE = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");

/**
 * Inline chips sit in running text: no 36px touch-target floor (globals.css
 * gives every button one on coarse pointers), or each would push its line apart.
 */
const CHIP = "min-h-0 rounded px-0.5 font-medium";

/** Long unbroken tokens (a hash, a path) wrap instead of scrolling the list sideways. */
const WRAP = "whitespace-pre-wrap break-words [overflow-wrap:anywhere]";

export type MarkupContext = {
  viewerId: string;
  personName: (id: string) => string | null;
  channelName: (id: string) => string | null;
  onMention?: (id: string) => void;
  onChannel?: (id: string) => void;
};

/** What the inline renderers pass down: the context, and whether its controls are in the Tab order. */
type Env = { ctx: MarkupContext; tab: number | undefined };

/**
 * `tabbable` false takes its links, chips and spoilers out of the Tab order
 * (tabIndex -1; a click or tap still works): the message list is one Tab
 * stop, and a message's own controls join the order only while focus is in
 * that message.
 */
export function MessageMarkup({
  body,
  ctx,
  compact = false,
  tabbable = true,
}: {
  body: string;
  ctx: MarkupContext;
  compact?: boolean;
  tabbable?: boolean;
}) {
  // Parsed once per body, not on every render of the row around it.
  const blocks = useMemo(() => (!compact && isJumboEmoji(body) ? null : parseBody(body)), [body, compact]);
  if (!blocks) {
    return <p className="text-4xl leading-tight">{body.trim()}</p>;
  }
  const env: Env = { ctx, tab: tabbable ? undefined : -1 };
  return (
    <>
      {blocks.map((b, i) => {
        if (b.t === "codeblock") {
          return (
            <pre
              key={i}
              className="my-1 max-w-full overflow-x-auto whitespace-pre rounded-md border border-line bg-wash px-3 py-2 font-mono text-[13px] leading-relaxed text-ink"
            >
              <code>{b.v}</code>
            </pre>
          );
        }
        if (b.t === "quote") {
          return (
            <blockquote key={i} className={`my-0.5 border-l-2 border-line pl-3 text-ink-soft ${WRAP}`}>
              <InlineNodes nodes={b.c} env={env} />
            </blockquote>
          );
        }
        return (
          <p key={i} className={WRAP}>
            <InlineNodes nodes={b.c} env={env} />
          </p>
        );
      })}
    </>
  );
}

function InlineNodes({ nodes, env }: { nodes: Inline[]; env: Env }): ReactNode {
  return nodes.map((n, i) => <Fragment key={i}>{renderInline(n, env)}</Fragment>);
}

function renderInline(n: Inline, env: Env): ReactNode {
  const { ctx, tab } = env;
  switch (n.t) {
    case "text":
      return n.v;
    case "br":
      return <br />;
    case "code":
      return <code className="rounded border border-line bg-wash px-1 py-px font-mono text-[0.9em]">{n.v}</code>;
    case "bold":
      return (
        <strong className="font-semibold text-ink">
          <InlineNodes nodes={n.c} env={env} />
        </strong>
      );
    case "italic":
      return (
        <em>
          <InlineNodes nodes={n.c} env={env} />
        </em>
      );
    case "strike":
      return (
        <s>
          <InlineNodes nodes={n.c} env={env} />
        </s>
      );
    case "spoiler":
      return <Spoiler nodes={n.c} env={env} />;
    case "link": {
      // A link into batch0 itself (a staff-feed line, a shared lesson) stays
      // in this tab; anything else opens a new one with no referrer.
      // NEXT_PUBLIC_SITE_URL, not window.location, so the server render and
      // hydration agree.
      const internal = !!SITE && (n.href === SITE || n.href.startsWith(`${SITE}/`));
      return internal ? (
        <a href={n.href} tabIndex={tab} className="link-ink break-all">
          {n.v}
        </a>
      ) : (
        <a href={n.href} target="_blank" rel="noopener noreferrer nofollow ugc" tabIndex={tab} className="link-ink break-all">
          {n.v}
        </a>
      );
    }
    case "mention": {
      // Only people the server vetted for this message are named; any other
      // <@id> someone typed is "@unknown", and nothing to click.
      const name = ctx.personName(n.id);
      if (!name) return <span className={`${CHIP} bg-wash text-ink-faint`}>@unknown</span>;
      const self = n.id === ctx.viewerId;
      return (
        <button
          type="button"
          tabIndex={tab}
          onClick={() => ctx.onMention?.(n.id)}
          className={`${CHIP} ${self ? "bg-phosphor text-on-phosphor" : "bg-phosphor/20 text-ink hover:bg-phosphor/35"}`}
        >
          @{name}
        </button>
      );
    }
    case "channel": {
      const name = ctx.channelName(n.id);
      return name ? (
        <button
          type="button"
          tabIndex={tab}
          onClick={() => ctx.onChannel?.(n.id)}
          className={`${CHIP} bg-phosphor/20 text-ink hover:bg-phosphor/35`}
        >
          #{name}
        </button>
      ) : (
        <span className="rounded bg-wash px-0.5 text-ink-faint">#private-channel</span>
      );
    }
    case "everyone":
      return <span className="rounded bg-phosphor/20 px-0.5 font-medium text-ink">@{n.v}</span>;
  }
}

/**
 * What a hidden spoiler holds, as one flat string: the bar keeps the length
 * of what it hides, but nothing inside it is a link, a chip or a colour.
 */
function hiddenText(nodes: Inline[], ctx: MarkupContext): string {
  let out = "";
  for (const n of nodes) {
    switch (n.t) {
      case "text":
      case "code":
      case "link":
        out += n.v;
        break;
      case "br":
        out += " ";
        break;
      case "mention":
        out += `@${ctx.personName(n.id) ?? "unknown"}`;
        break;
      case "channel":
        out += `#${ctx.channelName(n.id) ?? "private-channel"}`;
        break;
      case "everyone":
        out += `@${n.v}`;
        break;
      default:
        out += hiddenText(n.c, ctx);
    }
  }
  return out;
}

/**
 * A spoiler. Hidden, it is inert text on a dark bar: a click (or Enter or
 * Space) only reveals it, so a hidden link can't be followed unseen and a
 * hidden mention can't be read off its colour. A span, not a <button>,
 * because it sits in running text and a revealed spoiler may hold buttons.
 */
function Spoiler({ nodes, env }: { nodes: Inline[]; env: Env }) {
  const [shown, setShown] = useState(false);
  if (shown) {
    return (
      <span className="rounded bg-wash px-0.5">
        <InlineNodes nodes={nodes} env={env} />
      </span>
    );
  }
  return (
    <span
      role="button"
      tabIndex={env.tab ?? 0}
      aria-label="Spoiler. Activate to reveal."
      onClick={(e) => {
        e.stopPropagation();
        setShown(true);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        setShown(true);
      }}
      className="cursor-pointer select-none rounded bg-ink px-0.5 text-transparent [text-shadow:none] hover:bg-ink/80"
    >
      {hiddenText(nodes, env.ctx)}
    </span>
  );
}
