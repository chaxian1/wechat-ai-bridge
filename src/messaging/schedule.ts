/**
 * Scheduled tasks (cron-like). Persisted to disk.
 * Each task has a cron expression, a prompt, and target user info.
 * The monitor checks every 30s and fires matching tasks.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveStateDir } from "../config.ts";

export interface ScheduledTask {
  id: string;
  cron: string;        // "*/5 * * * *" or "0 9 * * 1-5"
  prompt: string;      // what to send to Claude
  fromUserId: string;  // target WeChat user
  baseUrl: string;
  token: string;
  contextToken?: string;
  lastRun?: number;
  createdAt: number;
}

const TASKS_FILE = path.join(resolveStateDir(), "schedule.json");

function loadTasks(): ScheduledTask[] {
  try { if (fs.existsSync(TASKS_FILE)) return JSON.parse(fs.readFileSync(TASKS_FILE, "utf-8")); } catch {}
  return [];
}

function saveTasks(tasks: ScheduledTask[]): void {
  fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true });
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), "utf-8");
}

/** Basic cron matcher (minute hour dom month dow). */
function cronMatches(cron: string, now: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const current = [now.getMinutes(), now.getHours(), now.getDate(), now.getMonth() + 1, now.getDay()];
  for (let i = 0; i < 5; i++) {
    if (!fieldMatches(parts[i], current[i])) return false;
  }
  return true;
}

function fieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const [range, step] = part.split("/");
      const s = parseInt(step);
      if (isNaN(s) || s <= 0) continue;
      if (range === "*") { if (value % s === 0) return true; }
      else { const [lo, hi] = range.split("-").map(Number); if (value >= lo && value <= hi && (value - lo) % s === 0) return true; }
    } else if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number);
      if (value >= lo && value <= hi) return true;
    } else {
      if (parseInt(part) === value) return true;
    }
  }
  return false;
}

/** Get tasks that should fire now. Returns them and updates lastRun. */
export function popReadyTasks(now: Date): ScheduledTask[] {
  const tasks = loadTasks();
  const ready = tasks.filter(t => {
    if (!cronMatches(t.cron, now)) return false;
    // Don't re-fire within the same minute
    if (t.lastRun && (now.getTime() - t.lastRun) < 60_000) return false;
    return true;
  });
  if (ready.length) {
    for (const t of ready) t.lastRun = now.getTime();
    saveTasks(tasks);
  }
  return ready;
}

export function addTask(t: Omit<ScheduledTask, "id" | "createdAt">): ScheduledTask {
  const task: ScheduledTask = { ...t, id: crypto.randomUUID().slice(0, 8), createdAt: Date.now() };
  const tasks = loadTasks();
  tasks.push(task);
  saveTasks(tasks);
  return task;
}

export function cancelTask(id: string): boolean {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return false;
  tasks.splice(idx, 1);
  saveTasks(tasks);
  return true;
}

export function listTasks(): ScheduledTask[] {
  return loadTasks();
}
