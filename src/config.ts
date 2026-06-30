/**
 * Configuration: .env → defaults.
 *
 * LLM config is handled by the local AI CLI — no API key needed here.
 *
 * IMPORTANT: values that can be changed at runtime via the management UI
 * (AI_PROVIDER, MIMO_PATH, MIMO_MODEL, CLAUDE_PATH, CLAUDE_MODEL, etc.)
 * are exported as *functions* so they always read the latest process.env.
 * Module-level constants would freeze at import time and miss config updates.
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env file
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// --- Claude Code workspace ---
export const WORKSPACE_DIR = process.env.WORKSPACE_DIR?.trim() || "";

// --- WeChat iLink config ---
export const ILINK_BASE_URL =
  process.env.ILINK_BASE_URL?.trim() || "https://ilinkai.weixin.qq.com";

export const CDN_BASE_URL =
  process.env.CDN_BASE_URL?.trim() || "https://novac2c.cdn.weixin.qq.com/c2c";

// --- iLink constants ---
export const ILINK_APP_ID = "bot";
export const ILINK_APP_CLIENT_VERSION = 0x00010000;
export const CHANNEL_VERSION = "1.0.0";
export const DEFAULT_BOT_AGENT = "ClaudeWeChatBridge/1.2";
export const LONG_POLL_TIMEOUT_MS = 35_000;
export const API_TIMEOUT_MS = 15_000;
export const CONFIG_TIMEOUT_MS = 10_000;
export const BOT_TYPE = "3";

// --- AI Provider (functions — read process.env at call time) ---
export function getAIProvider(): string {
  return process.env.AI_PROVIDER?.trim().toLowerCase() || "claude";
}
export function getMimoPath(): string {
  return process.env.MIMO_PATH?.trim() || "";
}
export function getMimoModel(): string {
  return process.env.MIMO_MODEL?.trim() || "";
}
export function getClaudePath(): string {
  return process.env.CLAUDE_PATH?.trim() || "";
}
export function getClaudeModel(): string {
  return process.env.CLAUDE_MODEL?.trim() || "";
}

// --- Runtime tuning ---
export const MAX_CONSECUTIVE_FAILURES = 5;
export const RESTART_DELAY_MS = 3_000;
export const ERROR_RETRY_DELAY_MS = 10_000;
export const COOLDOWN_DELAY_MS = 30_000;
export const POLL_RETRY_DELAY_MS = 2_000;
export const TYPING_INTERVAL_MS = 2_500;
export const MAX_TURNS = 20;

export function resolveStateDir(): string {
  return path.resolve(__dirname, "..", "state");
}
