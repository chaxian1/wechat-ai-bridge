/**
 * Simple blocklist — single-user bot, just block unwanted senders.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config.ts";

const BLOCKLIST_FILE = path.join(resolveStateDir(), "blocklist.json");

function loadBlocklist(): string[] {
  try {
    if (fs.existsSync(BLOCKLIST_FILE)) return JSON.parse(fs.readFileSync(BLOCKLIST_FILE, "utf-8"));
  } catch {}
  return [];
}

function saveBlocklist(list: string[]): void {
  fs.mkdirSync(path.dirname(BLOCKLIST_FILE), { recursive: true });
  fs.writeFileSync(BLOCKLIST_FILE, JSON.stringify(list, null, 2), "utf-8");
}

export function isUserAllowed(userId: string): boolean {
  return !loadBlocklist().includes(userId);
}

export function listBlocked(): string[] {
  return loadBlocklist();
}

export function blockUser(userId: string): void {
  const list = loadBlocklist();
  if (!list.includes(userId)) { list.push(userId); saveBlocklist(list); }
}

export function unblockUser(userId: string): void {
  saveBlocklist(loadBlocklist().filter(id => id !== userId));
}
