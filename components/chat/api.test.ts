import test from "node:test";
import assert from "node:assert/strict";

// The address-bar bookkeeping in api.ts, against a stand-in window: Next
// isn't here, only location and history, which is all write() touches.
const loc = { pathname: "/chat", search: "", href: "http://localhost/chat" };
const writes: string[] = [];
const go = (url: string) => {
  const u = new URL(url, loc.href);
  loc.pathname = u.pathname;
  loc.search = u.search;
  loc.href = u.href;
};
const history = {
  replaceState: (_: unknown, __: string, url: string) => {
    writes.push(`replace ${url}`);
    go(url);
  },
  pushState: (_: unknown, __: string, url: string) => {
    writes.push(`push ${url}`);
    go(url);
  },
};
(globalThis as { window?: unknown }).window = { location: loc, history };
const { holdChatUrl, tracked, writeChatUrl } = await import("./api.ts");

test("writeChatUrl: written while the chat is mounted, from where it mounted and from /chat", () => {
  go("/dev/chat?view=channel");
  writes.length = 0;
  writeChatUrl("/chat?c=0");
  assert.deepEqual(writes, [], "before the chat mounts, nothing");
  const release = holdChatUrl();
  writeChatUrl("/chat?c=1");
  writeChatUrl("/chat?c=2", { push: true });
  assert.deepEqual(writes, ["replace /chat?c=1", "push /chat?c=2"]);
  release();
});

test("writeChatUrl: a write that comes due after a link out of chat leaves the next page's URL alone", async () => {
  go("/chat?c=1");
  writes.length = 0;
  const release = holdChatUrl();
  // The URL already belongs to another page (Next navigated) while a channel was loading.
  go("/community-guidelines");
  writeChatUrl("/chat?c=3");
  assert.deepEqual(writes, []);
  // Queued behind a server action, then the chat unmounts before it settles.
  go("/chat?c=1");
  let settle!: () => void;
  const action = tracked(new Promise<void>((r) => (settle = r)));
  writeChatUrl("/chat?c=4");
  assert.deepEqual(writes, [], "queued while the action is in flight");
  release();
  go("/dashboard");
  settle();
  await action;
  await new Promise((r) => setTimeout(r, 5));
  writeChatUrl("/chat?c=5");
  assert.deepEqual(writes, []);
  assert.equal(loc.pathname, "/dashboard");
});
