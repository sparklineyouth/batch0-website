import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ChatSends, type ChatMsg, type ChatView } from "./ai/chat-sends.ts";
import { ALREADY_ANSWERED, REPLY_IN_FLIGHT, replyFailedNotice } from "./ai/resend.ts";

// Run with `npm test`. The AI co-founder composer's sends (lib/ai/chat-sends.ts)
// against a stand-in panel and a server the test streams by hand. The panel
// isn't remounted between conversations, so a reply can still be streaming
// after the student leaves its conversation and comes back. That used to
// draw the reply over the question, and the "just answered" refusal used to
// hand the question back to be sent (and answered, and billed) again.

const user = (content: string): ChatMsg => ({ role: "user", content });
const bot = (content: string): ChatMsg => ({ role: "assistant", content });
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};

/** The panel's state, as React would hold it. */
function panel() {
  const p = { messages: [] as ChatMsg[], input: "", streaming: false, error: undefined as string | undefined, refreshes: 0 };
  const view: ChatView = {
    setMessages: (next) => void (p.messages = typeof next === "function" ? next(p.messages) : next),
    setInput: (next) => void (p.input = next(p.input)),
    setStreaming: (on) => void (p.streaming = on),
    setError: (message) => void (p.error = message),
    showError: (err) => void (p.error = err instanceof Error ? err.message : String(err)),
    refresh: () => void p.refreshes++,
  };
  return { p, view };
}

/** A 200 whose reply the test writes word by word, then ends. */
function streamingReply() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { status: 200 }),
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

const refusal = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A server that answers each POST with the next response in line. */
function server(...responses: Response[]) {
  const posts: { conversationId: string; message: string }[] = [];
  return {
    posts,
    post: async (body: { conversationId: string; message: string }) => {
      posts.push(body);
      const res = responses.shift();
      assert.ok(res, "no more responses queued");
      return res;
    },
  };
}

const EARLIER = [user("Earlier question"), bot("Earlier answer")];
const QUESTION = "How should I price?";

test("leaving a chat and coming back while its reply streams keeps the question, and the reply shows once saved", async () => {
  const { p, view } = panel();
  const reply = streamingReply();
  const srv = server(reply.response);
  const sends = new ChatSends(view, srv.post);
  sends.open("A", EARLIER);
  const sending = sends.send(QUESTION, p.messages);
  reply.write("Price on ");
  await settle();
  assert.deepEqual(p.messages, [...EARLIER, user(QUESTION), bot("Price on ")]);

  // To B: nothing of A's reply is drawn there, and B's composer is free.
  const inB = [user("B question"), bot("B answer")];
  sends.open("B", inB);
  reply.write("value");
  await settle();
  assert.deepEqual(p.messages, inB);
  assert.equal(p.streaming, false);

  // Back to A. Its transcript comes from the server, which saved the
  // question before the reply started and hasn't saved the reply yet.
  const reloaded = [...EARLIER, user(QUESTION)];
  sends.open("A", reloaded);
  assert.equal(p.streaming, true, "the composer waits for the reply, as it did before the student left");
  reply.write(", not cost.");
  await settle();
  assert.deepEqual(p.messages, reloaded, "the rest of the reply isn't drawn over the question");
  // A send now is held here; the server would refuse it (REPLY_IN_FLIGHT).
  await sends.send("And churn?", p.messages);
  assert.equal(srv.posts.length, 1);

  reply.end();
  await sending;
  assert.equal(p.streaming, false, "free again once the reply is saved");
  assert.equal(p.refreshes, 1);
  // The refresh brings the server's copy, reply included, and it's shown.
  const saved = [...reloaded, bot("Price on value, not cost.")];
  sends.serverCopy(saved);
  assert.deepEqual(p.messages, saved);
  // Once: a later copy doesn't replace the screen unasked.
  sends.serverCopy([...saved, bot("something else")]);
  assert.deepEqual(p.messages, saved);
});

test("a reply that finishes while another chat is open is fetched again when its chat is next opened", async () => {
  // The navigation back to A can read A's transcript just before the reply
  // is saved and arrive just after the send ended.
  const { p, view } = panel();
  const reply = streamingReply();
  const sends = new ChatSends(view, server(reply.response).post);
  sends.open("A", EARLIER);
  const sending = sends.send(QUESTION, p.messages);
  await settle();
  sends.open("B", []);
  reply.write("Price on value.");
  reply.end();
  await sending;
  assert.equal(p.refreshes, 1);
  sends.serverCopy([user("B, refreshed")]);
  assert.deepEqual(p.messages, [], "B's screen isn't replaced by that refresh");

  const stale = [...EARLIER, user(QUESTION)];
  sends.open("A", stale);
  assert.equal(p.streaming, false);
  assert.equal(p.refreshes, 2, "opening A asks for a fresh copy");
  const saved = [...stale, bot("Price on value.")];
  sends.serverCopy(saved);
  assert.deepEqual(p.messages, saved);
});

test("the 'just answered' refusal shows the saved reply and doesn't hand the question back", async () => {
  const { p, view } = panel();
  const srv = server(refusal(409, { error: ALREADY_ANSWERED, code: "already_answered" }));
  const sends = new ChatSends(view, srv.post);
  // This tab's reply failed; the student sends the question again, as the
  // notice says, but another tab already did and got the answer saved.
  const onScreen = [...EARLIER, user(QUESTION), bot(replyFailedNotice(0))];
  sends.open("A", onScreen);
  p.input = QUESTION;
  await sends.send(p.input, p.messages);
  assert.equal(p.input, "", "the words don't go back in the box: sending them would be a new question");
  assert.deepEqual(p.messages, onScreen, "this send's bubbles come back off");
  assert.match(p.error ?? "", /just answered/);
  assert.equal(p.streaming, false);
  assert.equal(p.refreshes, 1, "and the conversation is fetched again");
  const saved = [...EARLIER, user(QUESTION), bot("Price on value.")];
  sends.serverCopy(saved);
  assert.deepEqual(p.messages, saved, "showing the reply the other tab got");
});

test("a refusal that saved nothing puts the words back and leaves the screen alone", async () => {
  for (const [status, body] of [
    [409, { error: REPLY_IN_FLIGHT, code: "reply_in_flight" }],
    [429, { error: "You've hit the hourly chat limit. Try again later." }],
  ] as const) {
    const { p, view } = panel();
    const sends = new ChatSends(view, server(refusal(status, body)).post);
    sends.open("A", EARLIER);
    p.input = QUESTION;
    await sends.send(p.input, p.messages);
    assert.equal(p.input, QUESTION, `${status}: the words are back to send later`);
    assert.deepEqual(p.messages, EARLIER);
    assert.equal(p.error, body.error);
    assert.equal(p.streaming, false);
    assert.equal(p.refreshes, 0);
    sends.serverCopy([user("unasked")]);
    assert.deepEqual(p.messages, EARLIER);
  }
});

test("Enter pressed twice in one frame sends once", async () => {
  const { p, view } = panel();
  const reply = streamingReply();
  const srv = server(reply.response);
  const sends = new ChatSends(view, srv.post);
  sends.open("A", []);
  const first = sends.send(QUESTION, p.messages);
  // The panel's `streaming` hasn't re-rendered yet; the second press sees
  // the same input and the same transcript.
  const second = sends.send(QUESTION, []);
  reply.write("Price on value.");
  reply.end();
  await Promise.all([first, second]);
  assert.equal(srv.posts.length, 1);
  assert.deepEqual(p.messages, [user(QUESTION), bot("Price on value.")]);
});

test("a send in one chat leaves another chat's composer alone", async () => {
  const { p, view } = panel();
  const inA = streamingReply();
  const inB = streamingReply();
  const srv = server(inA.response, inB.response);
  const sends = new ChatSends(view, srv.post);
  sends.open("A", []);
  const a = sends.send("About A", p.messages);
  await settle();
  sends.open("B", []);
  const b = sends.send("About B", p.messages);
  await settle();
  assert.equal(srv.posts.length, 2, "A's reply streaming doesn't hold up a message in B");
  inA.write("A's reply");
  inA.end();
  await a;
  assert.equal(p.streaming, true, "A's reply ending doesn't free B's composer mid-reply");
  inB.write("B's reply");
  inB.end();
  await b;
  assert.equal(p.streaming, false);
  assert.deepEqual(p.messages, [user("About B"), bot("B's reply")]);
});

test("a reply that ends normally keeps what streamed, notes and failure notices included", async () => {
  const { p, view } = panel();
  const reply = streamingReply();
  const sends = new ChatSends(view, server(reply.response).post);
  sends.open("A", []);
  const sending = sends.send(QUESTION, p.messages);
  const streamed = "Start with" + replyFailedNotice("Start with".length);
  reply.write(streamed);
  reply.end();
  await sending;
  assert.equal(p.refreshes, 1);
  // The server saved only the question; its copy must not wipe the notice
  // that tells the student to send it again.
  sends.serverCopy([user(QUESTION)]);
  assert.deepEqual(p.messages, [user(QUESTION), bot(streamed)]);
});

test("the panel drives every send through ChatSends and feeds it each server copy", () => {
  const src = readFileSync(new URL("../app/dashboard/ai/ai-chat.tsx", import.meta.url), "utf8");
  assert.match(src, /sends\.open\(conversationId, initialMessages\);[\s\S]*?\}, \[conversationId\]\);/);
  assert.match(src, /sends\.serverCopy\(initialMessages\);[\s\S]*?\}, \[sends, initialMessages\]\);/);
  assert.match(src, /void sends\.send\(input, messages\)/);
  // No send of its own beside it.
  assert.doesNotMatch(src, /fetch\("\/api\/ai\/chat"[\s\S]*fetch\("\/api\/ai\/chat"/);
  assert.doesNotMatch(src, /shownRef|sendingRef/);
});
