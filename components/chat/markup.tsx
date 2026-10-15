"use client";
import { Fragment, useState, type ReactNode } from "react";
import { isJumboEmoji, parseBody, type Inline } from "@/lib/chat-format";

/**
 * A message body as React elements. lib/chat-format.ts parses; this renders.
 * Nothing here ever sets HTML: every string a person typed lands in a text
 * node, links are http(s) only (the parser refuses anything else) and open
 * in a new tab with no referrer and nofollow.
 */

const SITE = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");

export type MarkupContext = {
  viewerId: string;
  personName: (id: string) => string | null;
  channelName: (id: string) => string | null;
  onMention?: (id: string) => void;
  onChannel?: (id: string) => void;
};

export function MessageMarkup({ body, ctx, compact = false }: { body: string; ctx: MarkupContext; compact?: boolean }) {
  if (!compact && isJumboEmoji(body)) {
    return <p className="text-4xl leading-tight">{body.trim()}</p>;
  }
  const blocks = parseBody(body);
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
            <blockquote key={i} className="my-0.5 border-l-2 border-line pl-3 text-ink-soft">
              <InlineNodes nodes={b.c} ctx={ctx} />
            </blockquote>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap break-words">
            <InlineNodes nodes={b.c} ctx={ctx} />
          </p>
        );
      })}
    </>
  );
}

function InlineNodes({ nodes, ctx }: { nodes: Inline[]; ctx: MarkupContext }): ReactNode {
  return nodes.map((n, i) => <Fragment key={i}>{renderInline(n, ctx)}</Fragment>);
}

function renderInline(n: Inline, ctx: MarkupContext): ReactNode {
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
          <InlineNodes nodes={n.c} ctx={ctx} />
        </strong>
      );
    case "italic":
      return (
        <em>
          <InlineNodes nodes={n.c} ctx={ctx} />
        </em>
      );
    case "strike":
      return (
        <s>
          <InlineNodes nodes={n.c} ctx={ctx} />
        </s>
      );
    case "spoiler":
      return <Spoiler nodes={n.c} ctx={ctx} />;
    case "link": {
      // A link into batch0 itself (a staff-feed line, a shared lesson) stays
      // in this tab; anything else opens a new one with no referrer.
      // NEXT_PUBLIC_SITE_URL, not window.location, so the server render and
      // hydration agree.
      const internal = !!SITE && (n.href === SITE || n.href.startsWith(`${SITE}/`));
      return internal ? (
        <a href={n.href} className="link-ink break-all">
          {n.v}
        </a>
      ) : (
        <a href={n.href} target="_blank" rel="noopener noreferrer nofollow ugc" className="link-ink break-all">
          {n.v}
        </a>
      );
    }
    case "mention": {
      const name = ctx.personName(n.id);
      const self = n.id === ctx.viewerId;
      return (
        <button
          type="button"
          onClick={() => ctx.onMention?.(n.id)}
          className={`rounded px-0.5 font-medium ${
            self ? "bg-phosphor text-on-phosphor" : "bg-phosphor/20 text-ink hover:bg-phosphor/35"
          }`}
        >
          @{name ?? "unknown"}
        </button>
      );
    }
    case "channel": {
      const name = ctx.channelName(n.id);
      return name ? (
        <button
          type="button"
          onClick={() => ctx.onChannel?.(n.id)}
          className="rounded bg-phosphor/20 px-0.5 font-medium text-ink hover:bg-phosphor/35"
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

function Spoiler({ nodes, ctx }: { nodes: Inline[]; ctx: MarkupContext }) {
  const [shown, setShown] = useState(false);
  if (shown) {
    return (
      <span className="rounded bg-wash px-0.5">
        <InlineNodes nodes={nodes} ctx={ctx} />
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setShown(true)}
      aria-label="Spoiler. Click to reveal."
      className="rounded bg-ink px-0.5 text-transparent [text-shadow:none] hover:bg-ink/80"
    >
      <InlineNodes nodes={nodes} ctx={ctx} />
    </button>
  );
}
