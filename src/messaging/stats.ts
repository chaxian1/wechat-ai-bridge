/**
 * Runtime statistics. Persisted to disk for cross-process access.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config.ts";

interface RuntimeStats {
  messagesIn: number; messagesOut: number; llmCalls: number;
  toolCalls: number; totalLatencyMs: number; totalTokens: number;
  lastError: string; startTime: number;
  // Current task
  currentTask: string; currentProvider: string; currentStartTime: number;
  currentTools: string[];
}

const STATS_FILE = path.join(resolveStateDir(), "stats.json");

function load(): RuntimeStats {
  const defaults: RuntimeStats = {
    messagesIn:0,messagesOut:0,llmCalls:0,toolCalls:0,totalLatencyMs:0,totalTokens:0,
    lastError:"",startTime:Date.now(),
    currentTask:"",currentProvider:"",currentStartTime:0,currentTools:[]
  };
  try {
    if (fs.existsSync(STATS_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(STATS_FILE, "utf-8"));
      return { ...defaults, ...loaded };
    }
  } catch {}
  return defaults;
}

function save(s: RuntimeStats): void {
  fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
  fs.writeFileSync(STATS_FILE, JSON.stringify(s), "utf-8");
}

function update(fn: (s: RuntimeStats) => void): void {
  const s = load();
  fn(s);
  save(s);
}

export function recordMessageIn(): void { update(s => s.messagesIn++); }
export function recordMessageOut(): void { update(s => s.messagesOut++); }
export function recordLlmCall(latencyMs: number): void { update(s => { s.llmCalls++; s.totalLatencyMs += latencyMs; }); }
export function recordToolCall(): void { update(s => s.toolCalls++); }
export function recordTokens(count: number): void { update(s => { s.totalTokens += count; }); }
export function recordError(msg: string): void { update(s => s.lastError = msg); }

export function startTask(prompt: string, provider: string): void {
  update(s => {
    s.currentTask = prompt.slice(0, 100);
    s.currentProvider = provider;
    s.currentStartTime = Date.now();
    s.currentTools = [];
  });
}

export function addTaskTool(toolName: string): void {
  update(s => { s.currentTools.push(toolName); });
}

export function endTask(): void {
  update(s => {
    s.currentTask = "";
    s.currentProvider = "";
    s.currentStartTime = 0;
    s.currentTools = [];
  });
}

/** Reset volatile fields on bridge restart — keeps counters, clears error & startTime. */
export function resetForRestart(): void {
  update(s => { s.lastError = ""; s.startTime = Date.now(); });
}

export function getStats() {
  const stats = load();
  const avgLatency = stats.llmCalls ? Math.round(stats.totalLatencyMs / stats.llmCalls) : 0;
  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
  const mem = process.memoryUsage();
  const cpuUsage = process.cpuUsage();
  return {
    ...stats,
    avgLatencyMs: avgLatency,
    uptimeSeconds: uptime,
    memoryMB: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
    memoryTotalMB: Math.round(mem.heapTotal / 1024 / 1024 * 10) / 10,
    cpuUserMs: Math.round(cpuUsage.user / 1000),
    cpuSystemMs: Math.round(cpuUsage.system / 1000),
    currentDuration: stats.currentStartTime ? Math.floor((Date.now() - stats.currentStartTime) / 1000) : 0,
  };
}

export function clearStats(): void {
  save({ messagesIn:0,messagesOut:0,llmCalls:0,toolCalls:0,totalLatencyMs:0,totalTokens:0,lastError:"",startTime:Date.now(),
    currentTask:"",currentProvider:"",currentStartTime:0,currentTools:[] });
}
