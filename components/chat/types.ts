import type { ChatMessage, ChatPerson, SidebarData, SidebarItem } from "@/lib/chat";
import type { ChannelInfo, ChannelPayload } from "@/lib/chat-payload";

/** A message on screen: the server's, or one still sending (or failed to). */
export type UiMessage = ChatMessage & {
  pending?: boolean;
  /** Why it didn't send; offers Retry / Discard. */
  failed?: string;
  /**
   * What to resend on Retry — with the id the composer gave the message
   * (`clientId`, 0104), so a resend of one that went through gets the
   * original back instead of posting it twice.
   */
  retry?: {
    body: string;
    replyToId: string | null;
    attachments: { path: string; name: string }[];
    clientId: string;
    /** A thread reply's root (0110), so a Retry lands in the same thread. */
    threadRootId?: string | null;
    /** "Ask about this": the lesson or assignment it links to. */
    about?: string | null;
  };
};

export type ChatViewerInfo = {
  id: string;
  name: string;
  staff: boolean;
  vetted: boolean;
};

/** What the right-hand side shows: a list, one thread (0110), or #help's open questions. */
export type Panel = "members" | "pins" | "search" | "thread" | "unanswered" | null;

export type { ChatMessage, ChatPerson, SidebarData, SidebarItem, ChannelInfo, ChannelPayload };
