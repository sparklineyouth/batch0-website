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
  retry?: { body: string; replyToId: string | null; attachments: { path: string; name: string }[]; clientId: string };
};

export type ChatViewerInfo = {
  id: string;
  name: string;
  staff: boolean;
  vetted: boolean;
};

export type Panel = "members" | "pins" | "search" | null;

export type { ChatMessage, ChatPerson, SidebarData, SidebarItem, ChannelInfo, ChannelPayload };
