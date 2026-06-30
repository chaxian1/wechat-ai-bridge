/**
 * Persistent state storage: credentials, sync buffer, context tokens.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config.ts";

// ---------------------------------------------------------------------------
// Auth credentials
// ---------------------------------------------------------------------------

export interface AuthData {
  botToken: string;
  ilinkBotId: string;
  baseUrl: string;
  ilinkUserId?: string;
}

function authPath(): string {
  return path.join(resolveStateDir(), "auth.json");
}

export function loadAuth(): AuthData | null {
  try {
    if (fs.existsSync(authPath())) {
      return JSON.parse(fs.readFileSync(authPath(), "utf-8")) as AuthData;
    }
  } catch {}
  return null;
}

export function saveAuth(data: AuthData): void {
  const dir = resolveStateDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(authPath(), JSON.stringify(data, null, 2), "utf-8");
}

export function hasAuth(): boolean {
  return loadAuth() !== null;
}

// ---------------------------------------------------------------------------
// get_updates_buf (sync cursor)
// ---------------------------------------------------------------------------

function syncPath(): string {
  return path.join(resolveStateDir(), "sync.json");
}

export function loadSyncBuf(): string {
  try {
    if (fs.existsSync(syncPath())) {
      const data = JSON.parse(fs.readFileSync(syncPath(), "utf-8"));
      return data.get_updates_buf ?? "";
    }
  } catch {}
  return "";
}

export function saveSyncBuf(buf: string): void {
  const dir = resolveStateDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(syncPath(), JSON.stringify({ get_updates_buf: buf }), "utf-8");
}

// ---------------------------------------------------------------------------
// Context tokens (per-user)
// ---------------------------------------------------------------------------

function contextTokensPath(): string {
  return path.join(resolveStateDir(), "context_tokens.json");
}

function loadContextTokens(): Record<string, string> {
  try {
    if (fs.existsSync(contextTokensPath())) {
      return JSON.parse(fs.readFileSync(contextTokensPath(), "utf-8"));
    }
  } catch {}
  return {};
}

function saveContextTokens(tokens: Record<string, string>): void {
  const dir = resolveStateDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(contextTokensPath(), JSON.stringify(tokens, null, 2), "utf-8");
}

export function getContextToken(userId: string): string | undefined {
  return loadContextTokens()[userId];
}

export function setContextToken(userId: string, token: string): void {
  const tokens = loadContextTokens();
  tokens[userId] = token;
  saveContextTokens(tokens);
}

/** Find which accounts have a contextToken for a recipient. */
export function findUserIdByContextToken(recipientId: string): string | undefined {
  const tokens = loadContextTokens();
  return tokens[recipientId];
}
