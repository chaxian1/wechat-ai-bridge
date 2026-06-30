/**
 * HTTP client for WeChat iLink Bot API.
 * Ported from @tencent-weixin/openclaw-weixin/src/api/api.ts (MIT).
 */
import crypto from "node:crypto";
import {
  ILINK_APP_ID,
  ILINK_APP_CLIENT_VERSION,
  CHANNEL_VERSION,
  DEFAULT_BOT_AGENT,
  API_TIMEOUT_MS,
  LONG_POLL_TIMEOUT_MS,
  CONFIG_TIMEOUT_MS,
} from "../config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BaseInfo {
  channel_version?: string;
  bot_agent?: string;
}

export interface GetUpdatesReq {
  get_updates_buf?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageReq {
  msg?: WeixinMessage;
}

export interface SendMessageResp {
  ret?: number;
  errmsg?: string;
}

export interface GetUploadUrlReq {
  filekey?: string;
  media_type?: number;
  to_user_id?: string;
  rawsize?: number;
  rawfilemd5?: string;
  filesize?: number;
  thumb_rawsize?: number;
  thumb_rawfilemd5?: string;
  thumb_filesize?: number;
  no_need_thumb?: boolean;
  aeskey?: string;
}

export interface GetUploadUrlResp {
  upload_param?: string;
  thumb_upload_param?: string;
  upload_full_url?: string;
}

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface SendTypingReq {
  ilink_user_id?: string;
  typing_ticket?: string;
  status?: number;
}

// Message types
export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const;
export const MessageItemType = {
  NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5,
  TOOL_CALL_START: 11, TOOL_CALL_RESULT: 12,
} as const;
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const;
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

export interface TextItem { text?: string }
export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}
export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}
export interface VoiceItem {
  media?: CDNMedia;
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  playtime?: number;
  text?: string;
}
export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}
export interface VideoItem {
  media?: CDNMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: CDNMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}
export interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}
export interface ToolCallStartItem {
  tool_name?: string;
  tool_call_id?: string;
}
export interface ToolCallResultItem {
  tool_name?: string;
  tool_call_id?: string;
  status?: string;
}
export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  tool_call_start_item?: ToolCallStartItem;
  tool_call_result_item?: ToolCallResultItem;
}
export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}

export type WeixinApiOptions = {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

export function buildCommonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

export function buildBaseInfo(): BaseInfo {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: DEFAULT_BOT_AGENT,
  };
}

export function classifyFetchError(err: unknown): {
  type: string;
  description: string;
  code?: string;
} {
  if (err instanceof Error && err.name === "AbortError") {
    return { type: "timeout", description: "request timeout" };
  }
  const cause = (err as any)?.cause;
  const causeCode = cause?.code ?? "";
  const causeStr = String(cause ?? err ?? "");

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(causeStr))
    return { type: "dns", description: "DNS resolution failed" };
  if (/ECONNREFUSED/i.test(causeStr))
    return { type: "tcp", description: "TCP connection refused" };
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ENETUNREACH/i.test(causeStr))
    return { type: "tcp", description: "TCP connection timeout or unreachable" };
  if (/SSL|TLS|CERT|DEPTH_ZERO/i.test(causeStr))
    return { type: "tls", description: "TLS handshake error" };
  return { type: "unknown", description: "network request failed" };
}

// ---------------------------------------------------------------------------
// HTTP Methods
// ---------------------------------------------------------------------------

export async function apiPostFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs?: number;
  label: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const headers = buildHeaders(params.token);

  const controller = params.timeoutMs != null ? new AbortController() : undefined;
  const t = controller != null ? setTimeout(() => controller?.abort(), params.timeoutMs) : undefined;

  let signal: AbortSignal | undefined = controller?.signal;
  if (params.abortSignal) {
    signal = params.abortSignal;
    if (controller) {
      params.abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers,
      body: params.body,
      signal,
    });
    if (t !== undefined) clearTimeout(t);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${text}`);
    }
    return text;
  } catch (err) {
    if (t !== undefined) clearTimeout(t);
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw err;
  }
}

export async function apiGetFetch(params: {
  baseUrl: string;
  endpoint: string;
  timeoutMs?: number;
  label: string;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const headers = buildCommonHeaders();

  const controller = params.timeoutMs ? new AbortController() : undefined;
  const t = controller ? setTimeout(() => controller?.abort(), params.timeoutMs) : undefined;

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: controller?.signal,
    });
    if (t !== undefined) clearTimeout(t);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${text}`);
    }
    return text;
  } catch (err) {
    if (t !== undefined) clearTimeout(t);
    if (err instanceof Error && err.name === "AbortError") return "";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// API Methods
// ---------------------------------------------------------------------------

/** Long-poll for incoming messages. */
export async function getUpdates(
  params: GetUpdatesReq & WeixinApiOptions & { abortSignal?: AbortSignal },
): Promise<GetUpdatesResp> {
  const timeout = params.timeoutMs ?? LONG_POLL_TIMEOUT_MS;
  try {
    const raw = await apiPostFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: params.get_updates_buf ?? "",
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: timeout,
      label: "getUpdates",
      abortSignal: params.abortSignal,
    });
    return JSON.parse(raw) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
    }
    throw err;
  }
}

/** Send a message to a user. */
export async function sendMessage(
  params: WeixinApiOptions & { body: SendMessageReq },
): Promise<SendMessageResp> {
  const raw = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? API_TIMEOUT_MS,
    label: "sendMessage",
  });
  const resp: SendMessageResp = JSON.parse(raw);
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
  }
  return resp;
}

/** Get CDN upload URL. */
export async function getUploadUrl(
  params: GetUploadUrlReq & WeixinApiOptions,
): Promise<GetUploadUrlResp> {
  const raw = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      filekey: params.filekey,
      media_type: params.media_type,
      to_user_id: params.to_user_id,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      thumb_rawsize: params.thumb_rawsize,
      thumb_rawfilemd5: params.thumb_rawfilemd5,
      thumb_filesize: params.thumb_filesize,
      no_need_thumb: params.no_need_thumb,
      aeskey: params.aeskey,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? API_TIMEOUT_MS,
    label: "getUploadUrl",
  });
  const parsed = JSON.parse(raw) as GetUploadUrlResp;
  if (!parsed.upload_full_url && !parsed.upload_param) {
    console.error("[getUploadUrl] 原始响应:", raw.slice(0, 500));
  }
  return parsed;
}

/** Get bot config (typing_ticket, etc.). */
export async function getConfig(
  params: WeixinApiOptions & { ilinkUserId: string; contextToken?: string },
): Promise<GetConfigResp> {
  const raw = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? CONFIG_TIMEOUT_MS,
    label: "getConfig",
  });
  return JSON.parse(raw) as GetConfigResp;
}

/** Send typing indicator. */
export async function sendTyping(
  params: WeixinApiOptions & { body: SendTypingReq },
): Promise<void> {
  await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? CONFIG_TIMEOUT_MS,
    label: "sendTyping",
  });
}
