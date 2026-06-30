/**
 * CDN upload pipeline for WeChat media (images, files, videos).
 * Ported from @tencent-weixin/openclaw-weixin/src/cdn/upload.ts (MIT).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { aesEcbEncrypt } from "./aes-ecb.ts";
import { getUploadUrl, UploadMediaType, type GetUploadUrlResp } from "../api/client.ts";

const UPLOAD_MAX_RETRIES = 3;

export interface UploadedFileInfo {
  filekey: string;
  fileSize: number;
  fileSizeCiphertext: number;
  /** AES-128 key as 32-char hex string */
  aeskey: string;
  downloadEncryptedQueryParam: string;
}

/**
 * Upload a local file to WeChat CDN.
 *
 * Pipeline (matches @tencent-weixin/openclaw-weixin):
 *   1. Read file, compute MD5
 *   2. Generate random filekey (16 bytes hex) and AES-128 key (16 bytes)
 *   3. AES-128-ECB encrypt file
 *   4. Call getUploadUrl to get CDN upload params
 *   5. POST encrypted file to CDN (with retries)
 *   6. Return CDN reference for sendMessage
 */
export async function uploadFileToCDN(params: {
  filePath: string;
  toUserId: string;
  baseUrl: string;
  token?: string;
  cdnBaseUrl: string;
}): Promise<UploadedFileInfo> {
  const { filePath, toUserId, baseUrl, token, cdnBaseUrl } = params;

  // 1. Read file
  const plaintext = fs.readFileSync(filePath);
  const fileSize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");

  // 2. Generate keys (matching openclaw-weixin)
  const aeskey = crypto.randomBytes(16);
  const aeskeyHex = aeskey.toString("hex");
  const filekey = crypto.randomBytes(16).toString("hex");

  // 3. Determine media type by extension
  const ext = path.extname(filePath).toLowerCase();
  let mediaType: number;
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) {
    mediaType = UploadMediaType.IMAGE;
  } else if ([".mp4", ".mov", ".avi", ".mkv"].includes(ext)) {
    mediaType = UploadMediaType.VIDEO;
  } else {
    mediaType = UploadMediaType.FILE;
  }

  // 4. AES-128-ECB encrypt & get padded size
  const ciphertext = aesEcbEncrypt(plaintext, aeskey);
  const fileSizeCiphertext = ciphertext.length;

  // 5. Get upload URL
  console.log("[CDN] 请求上传URL, 文件:", filePath, "大小:", fileSize, "类型:", mediaType);
  const uploadResp: GetUploadUrlResp = await getUploadUrl({
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize: fileSize,
    rawfilemd5,
    filesize: fileSizeCiphertext,
    no_need_thumb: true,
    aeskey: aeskeyHex,
    baseUrl,
    token,
  });

  // 6. Resolve CDN upload URL (matching buildCdnUploadUrl from openclaw-weixin)
  const uploadFullUrl = uploadResp.upload_full_url?.trim();
  const uploadParam = uploadResp.upload_param;
  let cdnUrl: string;
  if (uploadFullUrl) {
    cdnUrl = uploadFullUrl;
  } else if (uploadParam) {
    cdnUrl = `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
    console.warn("[CDN] 使用 upload_param 拼接上传 URL");
  } else {
    console.log("getUploadUrl 响应:", JSON.stringify(uploadResp, null, 2));
    throw new Error("getUploadUrl: upload_full_url and upload_param both empty");
  }

  // 7. POST encrypted file to CDN (with retries, matching openclaw-weixin)
  let downloadEncryptedQueryParam: string | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });

      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get("x-error-message") ?? (await res.text().catch(() => ""));
        console.warn(`[CDN] 客户端错误 attempt=${attempt} status=${res.status}: ${errMsg}`);
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
        console.warn(`[CDN] 服务端错误 attempt=${attempt} status=${res.status}: ${errMsg}`);
        throw new Error(`CDN upload server error: ${errMsg}`);
      }

      downloadEncryptedQueryParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadEncryptedQueryParam) {
        console.warn(`[CDN] 响应缺少 x-encrypted-param 头 attempt=${attempt}`);
        throw new Error("CDN upload response missing x-encrypted-param header");
      }

      console.log(`[CDN] 上传成功 attempt=${attempt}`);
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes("client error")) throw err;
      if (attempt < UPLOAD_MAX_RETRIES) {
        console.warn(`[CDN] attempt ${attempt} 失败, 重试...`, String(err));
      } else {
        console.error(`[CDN] ${UPLOAD_MAX_RETRIES} 次尝试全部失败:`, String(err));
      }
    }
  }

  if (!downloadEncryptedQueryParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
  }

  return {
    filekey,
    fileSize,
    fileSizeCiphertext,
    aeskey: aeskeyHex,
    downloadEncryptedQueryParam,
  };
}
