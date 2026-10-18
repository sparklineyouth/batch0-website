// ---------------------------------------------------------------------------
// The AI co-founder's composer (app/dashboard/ai/ai-chat.tsx): what a send
// does to the panel, outside React so `node --test` can drive it.
//
// The panel isn't remounted when the student picks another conversation (?c=
// only changes its props), so a send can outlive the visit that started it:
// the student opens another chat, or another and then this one again, while
// the reply is still streaming. A send used to decide "still on screen?" by
// comparing conversation ids, so after A → B → A it drew the rest of A's reply
// over the last bubble of A's freshly loaded transcript, which is the
// question (saved before the reply starts, while the reply isn't saved yet),
// and the question disappeared until a reload. It also left the composer free
// while that reply was still streaming. Now a send belongs to one visit, and
// what it may still do once that visit is over is decided here.
// ---------------------------------------------------------------------------

import { REFUSAL_CODE } from "./resend.ts";

export type ChatMsg = { role: "user" | "assistant"; content: string };

/** The panel's state setters, and a way to re-read the page (router.refresh). */
export type ChatView = {
  setMessages(next: ChatMsg[] | ((prev: ChatMsg[]) => ChatMsg[])): void;
  setInput(next: (current: string) => string): void;
  setStreaming(on: boolean): void;
  setError(message: string | undefined): void;
  /** A send failed or was refused; the panel words it (getActionError). */
  showError(err: unknown): void;
  refresh(): void;
};

/** POST /api/ai/chat. */
export type PostChat = (body: { conversationId: string; message: string }) => Promise<Response>;

export class ChatSends {
  /** Bumped by every open(). A send draws only into the visit it started in. */
  private visit = 0;
  private conversationId = "";
  /**
   * The composer is busy: a send from this visit is running, or this
   * conversation's reply is still streaming to a send from an earlier visit.
   * Set at once, unlike the panel's `streaming` state, which only reads true
   * after a render: two Enter presses inside one frame both got past that.
   */
  private busy = false;
  /** Conversations a send from this panel is waiting on a reply for. */
  private readonly replying = new Set<string>();
  /**
   * Conversations whose reply finished while another conversation was open.
   * The next visit may have loaded its transcript before the reply was saved.
   */
  private readonly answeredAway = new Set<string>();
  /** Show the server's copy of the conversation when it next arrives. */
  private wantServerCopy = false;

  private readonly view: ChatView;
  private readonly post: PostChat;

  constructor(view: ChatView, post: PostChat) {
    this.view = view;
    this.post = post;
  }

  /** A conversation was opened, or opened again: its transcript as the server had it. */
  open(conversationId: string, messages: ChatMsg[]): void {
    this.visit++;
    this.conversationId = conversationId;
    this.wantServerCopy = false;
    // Back on a conversation whose reply is still streaming from an earlier
    // visit: the composer waits for it, as it did before the student left.
    // The server would refuse a send meanwhile anyway (REPLY_IN_FLIGHT).
    this.busy = this.replying.has(conversationId);
    this.view.setMessages(messages);
    this.view.setStreaming(this.busy);
    this.view.setError(undefined);
    if (this.answeredAway.delete(conversationId)) this.takeServerCopy();
  }

  /**
   * A copy of the conversation arrived from the server (router.refresh gives
   * the panel new props). It replaces what's on screen only when a send asked
   * for it. Otherwise the screen stays as it is, because it can hold more
   * than the server saved: the over-the-free-tier note, or a failed reply and
   * its "Send your message again". Not while a send is drawing, which would
   * then write its reply over the copy's last bubble. The flag waits for that
   * send's own refresh instead.
   */
  serverCopy(messages: ChatMsg[]): void {
    if (!this.wantServerCopy || this.busy) return;
    this.wantServerCopy = false;
    this.view.setMessages(messages);
  }

  private takeServerCopy(): void {
    this.wantServerCopy = true;
    this.view.refresh();
  }

  async send(input: string, onScreen: ChatMsg[]): Promise<void> {
    const text = input.trim();
    if (!text || this.busy) return;
    this.busy = true;
    const view = this.view;
    const visit = this.visit;
    const conversationId = this.conversationId;
    const shown = () => this.visit === visit;
    this.replying.add(conversationId);
    view.setError(undefined);
    view.setInput(() => "");
    view.setMessages([...onScreen, { role: "user", content: text }, { role: "assistant", content: "" }]);
    view.setStreaming(true);

    let streamed = false;
    let refresh = false;
    try {
      const res = await this.post({ conversationId, message: text });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        if (shown()) {
          view.setMessages(onScreen);
          if (data?.code === REFUSAL_CODE.alreadyAnswered) {
            // Another send of this question (another tab) saved its reply
            // while this one waited. Both are saved, so show them. Putting the
            // words back would invite a send that saves the question again and
            // pays for a second answer.
            this.wantServerCopy = true;
            refresh = true;
          } else {
            // Every other refusal comes before the question is saved (the
            // hourly limit, a reply still streaming in another tab, …), so
            // the words go back in the box to send later.
            view.setInput((current) => current || text);
          }
        }
        throw new Error(data?.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assembled = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        assembled += decoder.decode(value, { stream: true });
        // Read to the end even when the student has moved on: the server
        // saves the reply either way, and this send still owes its refresh.
        if (!shown()) continue;
        view.setMessages((prev) => {
          const out = [...prev];
          out[out.length - 1] = { role: "assistant", content: assembled };
          return out;
        });
      }
      streamed = true;
      refresh = true;
    } catch (err) {
      if (shown()) view.showError(err);
    } finally {
      this.replying.delete(conversationId);
      const here = this.conversationId === conversationId;
      // The visit on screen is waiting on this send if it started it, or if
      // it is this conversation opened again (open() made it busy).
      if (shown() || here) {
        this.busy = false;
        view.setStreaming(false);
      }
      if (streamed && !shown()) {
        // The reply landed after the visit on screen, or the next one to open
        // this conversation, loaded its transcript.
        if (here) this.wantServerCopy = true;
        else this.answeredAway.add(conversationId);
      }
      // After `busy` is cleared, so the copy it brings can be shown.
      if (refresh) view.refresh();
    }
  }
}
