/**
 * Send media files (image/video/file) to a WeChat user.
 */
import {
  type MessageItem,
  type WeixinMessage,
  MessageItemType,
  MessageState,
  MessageType,
  sendMessage,
} from "../api/client.ts";
import { uploadFileToCDN, type UploadedFileInfo } from "../cdn/upload.ts";
import path from "node:path";
import crypto from "node:crypto";
import { setContextToken } from "../auth/store.ts";

function generateClientId(): string {
  return `claude-wechat_${crypto.randomBytes(8).toString("hex")}`;
}

function buildMedia(uploaded: UploadedFileInfo) {
  return {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: Buffer.from(uploaded.aeskey, "ascii").toString("base64"),
    encrypt_type: 1,
  };
}

/** Send a text message. Retries once without contextToken on -2 error. */
export async function sendTextMessage(params: {
  to: string;
  text: string;
  baseUrl: string;
  token?: string;
  contextToken?: string;
  runId?: string;
}): Promise<string> {
  const clientId = generateClientId();

  async function trySend(ct: string | undefined): Promise<string> {
    const msg: WeixinMessage & { context_token?: string } = {
      from_user_id: "",
      to_user_id: params.to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: params.text } }],
      run_id: params.runId,
    };
    if (ct) msg.context_token = ct;
    await sendMessage({ baseUrl: params.baseUrl, token: params.token, body: { msg } });
    return clientId;
  }

  try {
    return await trySend(params.contextToken);
  } catch (err: unknown) {
    const msg = (err as Error).message || String(err);
    if (msg.includes("ret=-2") && params.contextToken) {
      setContextToken(params.to, "");
      console.log("⚠️  [send] ret=-2, contextToken 已清除");
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Generic media sender (unifies image / file / video)
// ---------------------------------------------------------------------------

type MediaParams = {
  to: string;
  filePath: string;
  text?: string;
  baseUrl: string;
  token?: string;
  cdnBaseUrl: string;
  contextToken?: string;
  runId?: string;
};

async function sendMediaMessage(
  params: MediaParams,
  buildItem: (uploaded: UploadedFileInfo) => MessageItem,
): Promise<string> {
  const uploaded = await uploadFileToCDN({
    filePath: params.filePath,
    toUserId: params.to,
    baseUrl: params.baseUrl,
    token: params.token,
    cdnBaseUrl: params.cdnBaseUrl,
  });

  const items: MessageItem[] = [];
  if (params.text) {
    items.push({ type: MessageItemType.TEXT, text_item: { text: params.text } });
  }
  items.push(buildItem(uploaded));

  let lastClientId = "";
  for (const item of items) {
    lastClientId = generateClientId();
    await sendMessage({
      baseUrl: params.baseUrl,
      token: params.token,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: params.to,
          client_id: lastClientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [item],
          context_token: params.contextToken,
          run_id: params.runId,
        },
      },
    });
  }
  return lastClientId;
}

/** Send an image to a user. */
export function sendImageMessage(params: MediaParams): Promise<string> {
  return sendMediaMessage(params, (u) => ({
    type: MessageItemType.IMAGE,
    image_item: { media: buildMedia(u), mid_size: u.fileSizeCiphertext },
  }));
}

/** Send a file attachment to a user. */
export function sendFileMessage(params: MediaParams): Promise<string> {
  return sendMediaMessage(params, (u) => ({
    type: MessageItemType.FILE,
    file_item: { media: buildMedia(u), file_name: path.basename(params.filePath), len: String(u.fileSize) },
  }));
}

/** Send a video to a user. */
export function sendVideoMessage(params: MediaParams): Promise<string> {
  return sendMediaMessage(params, (u) => ({
    type: MessageItemType.VIDEO,
    video_item: { media: buildMedia(u), video_size: u.fileSizeCiphertext },
  }));
}
