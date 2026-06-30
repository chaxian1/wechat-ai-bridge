/**
 * SILK audio transcoding for WeChat voice messages.
 * Ported from @tencent-weixin/openclaw-weixin/src/media/silk-transcode.ts (MIT).
 */

/** Default sample rate for Weixin voice messages. */
const SILK_SAMPLE_RATE = 24_000;

/**
 * Wrap raw pcm_s16le bytes in a WAV container.
 * Mono channel, 16-bit signed little-endian.
 */
function pcmBytesToWav(pcm: Uint8Array, sampleRate: number): Buffer {
  const pcmBytes = pcm.byteLength;
  const totalSize = 44 + pcmBytes;
  const buf = Buffer.allocUnsafe(totalSize);
  let offset = 0;

  buf.write("RIFF", offset); offset += 4;
  buf.writeUInt32LE(totalSize - 8, offset); offset += 4;
  buf.write("WAVE", offset); offset += 4;
  buf.write("fmt ", offset); offset += 4;
  buf.writeUInt32LE(16, offset); offset += 4; // fmt chunk size
  buf.writeUInt16LE(1, offset); offset += 2; // PCM format
  buf.writeUInt16LE(1, offset); offset += 2; // mono
  buf.writeUInt32LE(sampleRate, offset); offset += 4;
  buf.writeUInt32LE(sampleRate * 2, offset); offset += 4; // byte rate (mono 16-bit)
  buf.writeUInt16LE(2, offset); offset += 2; // block align
  buf.writeUInt16LE(16, offset); offset += 2; // bits per sample
  buf.write("data", offset); offset += 4;
  buf.writeUInt32LE(pcmBytes, offset); offset += 4;
  Buffer.from(pcm).copy(buf, offset);

  return buf;
}

/**
 * Try to transcode a SILK audio buffer to WAV using silk-wasm.
 * Returns a WAV Buffer on success, or null if silk-wasm is unavailable or decoding fails.
 */
export async function silkToWav(silkBuf: Buffer): Promise<Buffer | null> {
  try {
    // Dynamic import — silk-wasm is an optional ESM dependency
    const silkWasm = await import("silk-wasm");
    console.log(`🎵 silkToWav: 解码 ${silkBuf.length} 字节 SILK 音频`);
    const result = await silkWasm.decode(silkBuf, SILK_SAMPLE_RATE);
    console.log(`🎵 silkToWav: 解码完成 时长=${result.duration}ms PCM=${result.data.byteLength} 字节`);
    const wav = pcmBytesToWav(result.data, SILK_SAMPLE_RATE);
    console.log(`🎵 silkToWav: WAV 大小=${wav.length} 字节`);
    return wav;
  } catch (err) {
    console.warn(`⚠️ silkToWav: 转码失败, 将使用原始 SILK: ${String(err)}`);
    return null;
  }
}
