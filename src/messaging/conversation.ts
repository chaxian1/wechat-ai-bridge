/**
 * Per-user conversation memory. Stores recent exchanges as JSON.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir, MAX_TURNS } from "../config.ts";

interface Turn {
  role: "user" | "assistant";
  content: string;
  ts: number;
}

interface Conversation {
  userId: string;
  turns: Turn[];
}

const CONV_DIR = path.join(resolveStateDir(), "conversations");

function convPath(userId: string): string {
  // Sanitize user ID for filename
  const safe = userId.replace(/[<>:"/\\|?*@]/g, "_");
  return path.join(CONV_DIR, `${safe}.json`);
}

function loadConv(userId: string): Conversation {
  try {
    if (fs.existsSync(convPath(userId))) {
      return JSON.parse(fs.readFileSync(convPath(userId), "utf-8"));
    }
  } catch {}
  return { userId, turns: [] };
}

function saveConv(conv: Conversation): void {
  fs.mkdirSync(CONV_DIR, { recursive: true });
  fs.writeFileSync(convPath(conv.userId), JSON.stringify(conv), "utf-8");
}

/** Add a user message and return recent conversation history. */
export function addUserMessage(userId: string, text: string): Turn[] {
  const conv = loadConv(userId);
  conv.turns.push({ role: "user", content: text, ts: Date.now() });
  if (conv.turns.length > MAX_TURNS) conv.turns = conv.turns.slice(-MAX_TURNS);
  saveConv(conv);
  return conv.turns;
}

/** Add an assistant response. */
export function addAssistantMessage(userId: string, text: string): void {
  const conv = loadConv(userId);
  conv.turns.push({ role: "assistant", content: text, ts: Date.now() });
  if (conv.turns.length > MAX_TURNS) conv.turns = conv.turns.slice(-MAX_TURNS);
  saveConv(conv);
}

/** Load recent conversation turns for a user. */
export function getConversation(userId: string): Turn[] {
  return loadConv(userId).turns;
}

/** Clear conversation for a user. */
export function clearConversation(userId: string): void {
  try { fs.unlinkSync(convPath(userId)); } catch {}
}

/** List all known user IDs (sanitized filenames). */
export function listConversationUsers(): string[] {
  try {
    if (!fs.existsSync(CONV_DIR)) return [];
    return fs.readdirSync(CONV_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => f.replace(".json", ""));
  } catch { return []; }
}
