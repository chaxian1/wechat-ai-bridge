/**
 * AES-128-ECB encryption/decryption for WeChat CDN media.
 * Ported from @tencent-weixin/openclaw-weixin (MIT).
 */
import crypto from "node:crypto";

const ALGO = "aes-128-ecb";

/** Encrypt plaintext buffer with AES-128-ECB (PKCS7 padding). */
export function aesEcbEncrypt(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) {
    throw new Error(`AES-128 requires a 16-byte key, got ${key.length}`);
  }
  const cipher = crypto.createCipheriv(ALGO, key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** Decrypt ciphertext buffer with AES-128-ECB (PKCS7 padding). */
export function aesEcbDecrypt(ciphertext: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) {
    throw new Error(`AES-128 requires a 16-byte key, got ${key.length}`);
  }
  const decipher = crypto.createDecipheriv(ALGO, key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
