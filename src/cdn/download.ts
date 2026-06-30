/**
 * CDN media download + decryption for inbound WeChat media.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { aesEcbDecrypt } from "./aes-ecb.ts";
import { silkToWav } from "../media/silk-transcode.ts";
import {
  type MessageItem,
  type CDNMedia,
  MessageItemType,
} from "../api/client.ts";

const DOWNLOAD_DIR = path.join(os.tmpdir(), "wechat-ai", "media-inbound");
const MAX_MEDIA_AGE_MS = 60 * 60 * 1000; // 1 hour

/** Clean up stale inbound media files older than MAX_MEDIA_AGE_MS. */
export function cleanupInboundMedia(): void {
  try {
    if (!fs.existsSync(DOWNLOAD_DIR)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(DOWNLOAD_DIR)) {
      const fp = path.join(DOWNLOAD_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > MAX_MEDIA_AGE_MS) fs.unlinkSync(fp);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** Download and decrypt a CDN media item. Returns local file path. */
export async function downloadMedia(params: {
  cdnBaseUrl: string;
  item: MessageItem;
}): Promise<{ filePath: string; mimeType: string; fileName?: string } | null> {
  const { cdnBaseUrl, item } = params;

  let media: CDNMedia | undefined;
  let mimeType: string;
  let fileName: string | undefined;

  switch (item.type) {
    case MessageItemType.IMAGE:
      media = item.image_item?.media;
      mimeType = "image/jpeg"; // WeChat default
      fileName = undefined;
      break;
    case MessageItemType.VIDEO:
      media = item.video_item?.media;
      mimeType = "video/mp4";
      fileName = undefined;
      break;
    case MessageItemType.FILE:
      media = item.file_item?.media;
      mimeType = "application/octet-stream";
      fileName = item.file_item?.file_name;
      break;
    case MessageItemType.VOICE:
      media = item.voice_item?.media;
      mimeType = "audio/silk";
      fileName = undefined;
      break;
    default:
      return null;
  }

  if (!media) return null;

  // Get AES key — try hex string aeskey first, then base64 media.aes_key
  let aesKey: Buffer | undefined;
  if (item.image_item?.aeskey) {
    aesKey = Buffer.from(item.image_item.aeskey, "hex");
  } else if (media.aes_key) {
    aesKey = Buffer.from(media.aes_key, "base64");
  }

  if (!aesKey || aesKey.length !== 16) {
    // Try hex decode
    const hexKey = item.image_item?.aeskey;
    if (hexKey) {
      aesKey = Buffer.from(hexKey, "hex");
    }
    if (!aesKey || aesKey.length !== 16) {
      console.warn("downloadMedia: no valid AES key, saving as-is");
    }
  }

  // Resolve download URL
  let downloadUrl: string;
  if (media.full_url) {
    downloadUrl = media.full_url;
  } else if (media.encrypt_query_param) {
    downloadUrl = `${cdnBaseUrl}/${media.encrypt_query_param}`;
  } else {
    return null;
  }

  // Download
  console.log(`📥 下载媒体: ${downloadUrl.slice(0, 80)}...`);
  const resp = await fetch(downloadUrl);
  if (!resp.ok) {
    console.warn(`下载失败: ${resp.status}`);
    return null;
  }

  let data = Buffer.from(await resp.arrayBuffer()) as Buffer;

  // Decrypt if we have a key
  if (aesKey && aesKey.length === 16) {
    try {
      data = aesEcbDecrypt(data, aesKey);
    } catch (err) {
      console.warn(`解密失败: ${String(err)}，使用原始数据`);
    }
  }

  // Save to temp dir
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const ext = path.extname(fileName ?? "") || guessExtension(mimeType);
  const outPath = path.join(DOWNLOAD_DIR, `media_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);
  fs.writeFileSync(outPath, data);

  console.log(`✅ 媒体已保存: ${outPath} (${data.length} bytes)`);

  // Best-effort cleanup of stale inbound media (runs once per download)
  cleanupInboundMedia();

  // Voice: transcode SILK to WAV for Claude to understand
  if (item.type === MessageItemType.VOICE && mimeType === "audio/silk") {
    const wav = await silkToWav(data);
    if (wav) {
      const wavPath = outPath.replace(/\.\w+$/, ".wav");
      fs.writeFileSync(wavPath, wav);
      console.log(`🎵 语音已转码为 WAV: ${wavPath}`);
      return { filePath: wavPath, mimeType: "audio/wav", fileName };
    }
    // Fall through: returns raw SILK if transcode fails
  }

  return { filePath: outPath, mimeType, fileName };
}

function guessExtension(mimeType: string): string {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return ".jpg";
  if (mimeType.includes("png")) return ".png";
  if (mimeType.includes("gif")) return ".gif";
  if (mimeType.includes("mp4")) return ".mp4";
  if (mimeType.includes("webp")) return ".webp";
  if (mimeType.includes("silk")) return ".silk";
  return ".bin";
}
