/**
 * Persistent reminders. Survives restarts.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveStateDir } from "../config.ts";

export interface Reminder {
  id: string;
  message: string;
  triggerAt: number;
  fromUserId: string;
  baseUrl: string;
  token: string;
  contextToken?: string;
}

// Current session context — set by monitor before processing messages
let currentCtx: { fromUserId: string; baseUrl: string; token: string; contextToken?: string } | null = null;

export function setReminderContext(ctx: typeof currentCtx): void {
  currentCtx = ctx;
}

export function getReminderContext(): typeof currentCtx {
  return currentCtx;
}

const REM_FILE = path.join(resolveStateDir(), "reminders.json");

function loadAll(): Reminder[] {
  try {
    if (fs.existsSync(REM_FILE)) return JSON.parse(fs.readFileSync(REM_FILE, "utf-8"));
  } catch {}
  return [];
}

function saveAll(list: Reminder[]): void {
  fs.mkdirSync(path.dirname(REM_FILE), { recursive: true });
  fs.writeFileSync(REM_FILE, JSON.stringify(list, null, 2), "utf-8");
}

export function addReminder(r: Omit<Reminder, "id">): Reminder {
  const id = `rem_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  const rem = { ...r, id };
  const all = loadAll();
  all.push(rem);
  saveAll(all);
  console.log(`⏰ [reminder] ${id}: "${r.message}" at ${new Date(r.triggerAt).toLocaleString("zh-CN")}`);
  return rem;
}

export function removeReminder(id: string): boolean {
  const all = loadAll();
  const idx = all.findIndex(r => r.id === id);
  if (idx === -1) return false;
  all.splice(idx, 1);
  saveAll(all);
  return true;
}

export function listReminders(): Reminder[] {
  return loadAll();
}

/** Get reminders that should fire now, and remove them from storage. */
export function popReadyReminders(now: number): Reminder[] {
  const all = loadAll();
  const ready = all.filter(r => r.triggerAt <= now);
  if (ready.length) saveAll(all.filter(r => r.triggerAt > now));
  return ready;
}
