/**
 * Inbound message parsing: extract text, context_token, and media from WeixinMessage.
 */
import {
  type WeixinMessage,
  type MessageItem,
  MessageItemType,
} from "../api/client.ts";
import { getContextToken, setContextToken } from "../auth/store.ts";

export interface InboundMedia {
  /** Local file path after download & decrypt. */
  filePath?: string;
  /** Original filename (for file items). */
  fileName?: string;
  /** MIME type. */
  mimeType?: string;
  /** Media type enum value. */
  mediaType?: number;
}

export interface ParsedMessage {
  /** Sender's WeChat user ID (xxx@im.wechat) */
  fromUserId: string;
  /** Bot's ID (xxx@im.bot) */
  toUserId: string;
  /** Combined text content from all TEXT items. */
  text: string;
  /** Session context token. */
  contextToken?: string;
  /** Conversation session ID. */
  sessionId?: string;
  /** Message timestamp (server time). */
  createTimeMs?: number;
  /** Downloaded media, if any. */
  media?: InboundMedia;
  /** Raw message seq. */
  seq?: number;
  /** Raw message_id. */
  messageId?: number;
}

/** Extract plain text from a list of message items. */
export function extractText(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  return itemList
    .filter((i) => i.type === MessageItemType.TEXT)
    .map((i) => i.text_item?.text ?? "")
    .join("");
}

/** Check if a media item has downloadable CDN ref. */
function hasDownloadableMedia(m?: { encrypt_query_param?: string; full_url?: string }): boolean {
  return !!(m?.encrypt_query_param || m?.full_url);
}

/** Find the first downloadable media item in a message. */
export function findMediaItem(itemList?: MessageItem[]): {
  item: MessageItem;
  isRef: boolean;
} | null {
  if (!itemList?.length) return null;

  // Priority: IMAGE > VIDEO > FILE > VOICE (without text)
  for (const item of itemList) {
    if (item.type === MessageItemType.IMAGE && hasDownloadableMedia(item.image_item?.media))
      return { item, isRef: false };
    if (item.type === MessageItemType.VIDEO && hasDownloadableMedia(item.video_item?.media))
      return { item, isRef: false };
    if (item.type === MessageItemType.FILE && hasDownloadableMedia(item.file_item?.media))
      return { item, isRef: false };
    if (
      item.type === MessageItemType.VOICE &&
      hasDownloadableMedia(item.voice_item?.media) &&
      !item.voice_item?.text
    )
      return { item, isRef: false };
  }

  // Fallback: quoted message media
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.ref_msg?.message_item) {
      const refItem = item.ref_msg.message_item;
      if (
        (refItem.type === MessageItemType.IMAGE && hasDownloadableMedia(refItem.image_item?.media)) ||
        (refItem.type === MessageItemType.VIDEO && hasDownloadableMedia(refItem.video_item?.media)) ||
        (refItem.type === MessageItemType.FILE && hasDownloadableMedia(refItem.file_item?.media))
      ) {
        return { item: refItem, isRef: true };
      }
    }
  }

  return null;
}

/**
 * Parse a raw WeixinMessage into a structured ParsedMessage.
 * Also persists the context_token for the user.
 */
export function parseInboundMessage(
  msg: WeixinMessage,
): ParsedMessage {
  const fromUserId = msg.from_user_id ?? "";
  const toUserId = msg.to_user_id ?? "";
  const text = extractText(msg.item_list);
  const contextToken = msg.context_token;

  // Persist context token for future outbound messages
  if (contextToken && fromUserId) {
    setContextToken(fromUserId, contextToken);
  }

  return {
    fromUserId,
    toUserId,
    text,
    contextToken: contextToken || getContextToken(fromUserId),
    sessionId: msg.session_id,
    createTimeMs: msg.create_time_ms,
    seq: msg.seq,
    messageId: msg.message_id,
  };
}
