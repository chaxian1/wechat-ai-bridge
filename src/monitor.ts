/**
 * Main poll loop: getUpdates → Claude Code CLI → sendMessage.
 * All messages are delegated to the local `claude` CLI.
 */
import { getUpdates, sendTyping, getConfig, TypingStatus } from "./api/client.ts";
import { loadSyncBuf, saveSyncBuf, getContextToken, setContextToken } from "./auth/store.ts";
import { parseInboundMessage, findMediaItem } from "./messaging/inbound.ts";
import { downloadMedia } from "./cdn/download.ts";
import { streamAI, getAISystemPrompt, compactSession, getAIProvider } from "./ai-provider.ts";
import { sendTextMessage, sendImageMessage, sendFileMessage, sendVideoMessage } from "./messaging/send-media.ts";
import { StreamingMarkdownFilter } from "./messaging/markdown-filter.ts";
import { splitMessage } from "./messaging/message-splitter.ts";
import { clearConversation } from "./messaging/conversation.ts";
import { popReadyReminders, setReminderContext } from "./messaging/reminders.ts";
import { popReadyTasks } from "./messaging/schedule.ts";
import { isUserAllowed } from "./auth/users.ts";
import { recordMessageIn, recordMessageOut, recordLlmCall, recordToolCall, recordTokens, recordError, resetForRestart, startTask, addTaskTool, endTask } from "./messaging/stats.ts";
import { CDN_BASE_URL, LONG_POLL_TIMEOUT_MS, resolveStateDir, WORKSPACE_DIR, MAX_CONSECUTIVE_FAILURES, RESTART_DELAY_MS, ERROR_RETRY_DELAY_MS, COOLDOWN_DELAY_MS, POLL_RETRY_DELAY_MS, TYPING_INTERVAL_MS } from "./config.ts";

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

const MIN_SEND_INTERVAL_MS = 2500; // 2.5 seconds between sends to same user
const nextSendTime = new Map<string, number>();

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function rateLimitedSend(
  fn: () => Promise<void>,
  uid: string,
): Promise<void> {
  const now = Date.now();
  const lastSend = nextSendTime.get(uid) ?? 0;
  const waitMs = Math.max(0, lastSend + MIN_SEND_INTERVAL_MS - now);
  if (waitMs > 0) await sleep(waitMs);
  try {
    await fn();
  } finally {
    nextSendTime.set(uid, Date.now());
  }
}
import type { AuthData } from "./auth/store.ts";
import type { PermissionRequest, PermissionDecision } from "./claude/client.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Session store: userId → { sessions[], activeIndex } (for --resume and /resume command)
const SESSIONS_PATH = path.join(resolveStateDir(), "cc-sessions.json");

interface SessionEntry {
  sessionId: string;
  createdAt: number;
  lastActiveAt: number;
  preview: string;    // first 50 chars of opening message
  turnCount: number;
}

interface UserSessions {
  sessions: SessionEntry[];
  activeIndex: number; // -1 = no active session
  permissionMode?: 'bypass' | 'approve';
  model?: string;
  effort?: string;
  quickCommands?: Record<string, string>;
  loops?: LoopEntry[];
}

type SessionsStore = Record<string, UserSessions>;

function loadSessions(): SessionsStore {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf-8"));
    if (typeof raw !== "object" || raw === null) return {};
    // Migrate old format: Record<string, string> → SessionsStore
    const store: SessionsStore = {};
    for (const [uid, val] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof val === "string") {
        store[uid] = { sessions: [{ sessionId: val, createdAt: 0, lastActiveAt: Date.now(), preview: "(旧会话)", turnCount: 0 }], activeIndex: 0 };
      } else if (typeof val === "object" && val !== null && "sessions" in val) {
        store[uid] = val as UserSessions;
      }
    }
    return store;
  } catch { return {}; }
}

function saveSessions(s: SessionsStore): void {
  try { fs.mkdirSync(path.dirname(SESSIONS_PATH), { recursive: true }); } catch { /* ignore */ }
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(s), "utf-8");
}

function getActiveSessionId(sessions: SessionsStore, uid: string): string | undefined {
  const u = sessions[uid];
  if (!u || u.activeIndex < 0 || u.activeIndex >= u.sessions.length) return undefined;
  return u.sessions[u.activeIndex].sessionId;
}

function getPermissionMode(sessions: SessionsStore, uid: string): 'bypass' | 'approve' {
  return sessions[uid]?.permissionMode ?? 'bypass';
}

function setPermissionMode(sessions: SessionsStore, uid: string, mode: 'bypass' | 'approve'): void {
  if (!sessions[uid]) sessions[uid] = { sessions: [], activeIndex: -1 };
  sessions[uid].permissionMode = mode;
  saveSessions(sessions);
}

// ---------------------------------------------------------------------------
// Loop (scheduled task) types and registry
// ---------------------------------------------------------------------------

interface LoopEntry {
  id: string;
  prompt: string;
  intervalMs: number;
  nextFireAt: number;
}

// Active loop timers: `${uid}-${loopId}` → setTimeout handle
const loopTimers = new Map<string, ReturnType<typeof setTimeout>>();

function getUserLoops(sessions: SessionsStore, uid: string): LoopEntry[] {
  return sessions[uid]?.loops ?? [];
}

function addUserLoop(sessions: SessionsStore, uid: string, loop: LoopEntry): void {
  if (!sessions[uid]) sessions[uid] = { sessions: [], activeIndex: -1 };
  if (!sessions[uid].loops) sessions[uid].loops = [];
  sessions[uid].loops!.push(loop);
  saveSessions(sessions);
}

function removeUserLoop(sessions: SessionsStore, uid: string, loopId: string): boolean {
  const loops = sessions[uid]?.loops;
  if (!loops) return false;
  const idx = loops.findIndex(l => l.id === loopId);
  if (idx === -1) return false;
  loops.splice(idx, 1);
  saveSessions(sessions);
  return true;
}

function removeAllUserLoops(sessions: SessionsStore, uid: string): void {
  if (sessions[uid]) sessions[uid].loops = [];
  saveSessions(sessions);
}

function scheduleLoop(
  uid: string,
  loop: LoopEntry,
  auth: AuthData,
  sessions: SessionsStore,
  onFire: (uid: string, prompt: string, auth: AuthData) => Promise<void>,
): void {
  const delay = Math.max(0, loop.nextFireAt - Date.now());
  const key = `${uid}-${loop.id}`;
  const existing = loopTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    loopTimers.delete(key);
    await onFire(uid, loop.prompt, auth);
    // Reschedule
    loop.nextFireAt = Date.now() + loop.intervalMs;
    saveSessions(sessions);
    scheduleLoop(uid, loop, auth, sessions, onFire);
  }, delay);

  loopTimers.set(key, timer);
}

function restoreLoops(
  sessions: SessionsStore,
  auth: AuthData,
  onFire: (uid: string, prompt: string, auth: AuthData) => Promise<void>,
): void {
  for (const [uid, userSessions] of Object.entries(sessions)) {
    for (const loop of userSessions.loops ?? []) {
      scheduleLoop(uid, loop, auth, sessions, onFire);
    }
  }
}

function parseInterval(str: string): number | null {
  const match = str.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  if (!match) return null;
  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const ms = unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
  return Math.round(val * ms);
}

function formatInterval(ms: number): string {
  if (ms >= 86400000) return `${(ms / 86400000).toFixed(1)}天`;
  if (ms >= 3600000) return `${(ms / 3600000).toFixed(1)}小时`;
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}分钟`;
  return `${(ms / 1000).toFixed(0)}秒`;
}

// ---------------------------------------------------------------------------
// Permission request handling
// ---------------------------------------------------------------------------

// Pending permission requests: userId → { request, resolve, timeout }
const pendingPermissions = new Map<string, {
  request: PermissionRequest;
  resolve: (decision: PermissionDecision) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();

const PERMISSION_TIMEOUT_MS = 60_000; // 60 seconds to respond

/**
 * Create a permission request handler for a specific user.
 * Returns a callback to pass to streamAI's onPermissionRequest.
 */
function createPermissionHandler(
  uid: string,
  auth: AuthData,
): (req: PermissionRequest) => Promise<PermissionDecision> {
  return async (req: PermissionRequest): Promise<PermissionDecision> => {
    // Build a human-readable description of what the tool wants to do
    const toolDesc = describeToolRequest(req.toolName, req.toolInput);
    const message = `🔐 需要你的授权:\n\n工具: ${req.toolName}\n操作: ${toolDesc}\n\n回复 y 允许 / n 拒绝 (60秒超时自动拒绝)`;

    // Send request to user via WeChat
    await sendTextMessage({
      to: uid,
      text: message,
      baseUrl: auth.baseUrl,
      token: auth.botToken,
      contextToken: getContextToken(uid),
    }).catch(() => {});

    // Wait for user response
    return new Promise<PermissionDecision>((resolve) => {
      const timeout = setTimeout(() => {
        pendingPermissions.delete(uid);
        sendTextMessage({
          to: uid,
          text: "⏰ 授权超时，已自动拒绝",
          baseUrl: auth.baseUrl,
          token: auth.botToken,
          contextToken: getContextToken(uid),
        }).catch(() => {});
        resolve("deny");
      }, PERMISSION_TIMEOUT_MS);

      pendingPermissions.set(uid, { request: req, resolve, timeout });
    });
  };
}

/**
 * Try to resolve a pending permission request for a user.
 * Returns true if the message was handled as a permission response.
 */
function tryResolvePermission(uid: string, text: string): boolean {
  const pending = pendingPermissions.get(uid);
  if (!pending) return false;

  const normalized = text.trim().toLowerCase();
  if (normalized === "y" || normalized === "yes" || normalized === "允许" || normalized === "是") {
    clearTimeout(pending.timeout);
    pendingPermissions.delete(uid);
    pending.resolve("allow");
    return true;
  }
  if (normalized === "n" || normalized === "no" || normalized === "拒绝" || normalized === "否") {
    clearTimeout(pending.timeout);
    pendingPermissions.delete(uid);
    pending.resolve("deny");
    return true;
  }

  // If not a clear y/n, treat as new message (cancel pending permission)
  clearTimeout(pending.timeout);
  pendingPermissions.delete(uid);
  pending.resolve("deny");
  return false;
}

/**
 * Generate a human-readable description of a tool request.
 */
function describeToolRequest(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return `执行命令: ${input.command || input.cmd || JSON.stringify(input)}`;
    case "Write":
      return `写入文件: ${input.file_path || input.path || "?"}`;
    case "Edit":
      return `编辑文件: ${input.file_path || input.path || "?"}`;
    case "Read":
      return `读取文件: ${input.file_path || input.path || "?"}`;
    case "glob":
      return `搜索文件: ${input.pattern || JSON.stringify(input)}`;
    case "grep":
      return `搜索内容: ${input.pattern || JSON.stringify(input)}`;
    default:
      return JSON.stringify(input).slice(0, 200);
  }
}

function addSessionEntry(sessions: SessionsStore, uid: string, sessionId: string, preview: string): void {
  if (!sessions[uid]) sessions[uid] = { sessions: [], activeIndex: -1 };
  const u = sessions[uid];
  const existing = u.sessions.find(s => s.sessionId === sessionId);
  if (existing) {
    existing.lastActiveAt = Date.now();
    existing.turnCount++;
    u.activeIndex = u.sessions.indexOf(existing);
  } else {
    u.sessions.unshift({ sessionId, createdAt: Date.now(), lastActiveAt: Date.now(), preview: preview.slice(0, 50), turnCount: 1 });
    u.activeIndex = 0;
    if (u.sessions.length > 20) u.sessions = u.sessions.slice(0, 20);
  }
}

export interface MonitorOptions {
  auth: AuthData;
  /** Optional log callback — all console output is forwarded here. */
  onLog?: (line: string) => void;
}

/**
 * Start the main long-poll + process loop.
 * Returns when aborted or on fatal error.
 */
export async function startMonitor(
  opts: MonitorOptions,
  abortSignal: AbortSignal,
): Promise<void> {
  const { auth } = opts;
  const baseUrl = auth.baseUrl;
  const token = auth.botToken;

  // Override console methods to capture all output
  let _origLog: typeof console.log = console.log.bind(console);
  let _origWarn: typeof console.warn = console.warn.bind(console);
  let _origError: typeof console.error = console.error.bind(console);

  if (opts.onLog) {
    const _log = opts.onLog;
    _origLog = console.log.bind(console);
    _origWarn = console.warn.bind(console);
    _origError = console.error.bind(console);
    console.log = (...args: any[]) => { _log(args.map(String).join(' ')); };
    console.warn = (...args: any[]) => { _log(`[WARN] ${args.map(String).join(' ')}`); };
    console.error = (...args: any[]) => { _log(`[ERR] ${args.map(String).join(' ')}`); };
  }

  try {

  // --- Active Claude Code processes per user (for interrupt) ---
  const activeControllers = new Map<string, { abort: () => void; kill: () => void }>();

  // When monitor is stopped externally, force-kill all active Claude processes
  abortSignal.addEventListener("abort", () => {
    for (const [uid, ctrl] of activeControllers) {
      const pname = getAIProvider() === "mimo" ? "MiMoCode" : "Claude Code";
      console.log(`⏹️ Monitor 关闭，强制终止用户 ${uid} 的 ${pname}`);
      ctrl.kill();
      ctrl.abort();
    }
    activeControllers.clear();
  }, { once: true });

  const sessions = loadSessions();

  console.log(`🚀 Bot 已启动 (${auth.ilinkBotId})`);
  console.log(`   用户 ID: ${auth.ilinkUserId || "(未知)"}`);
  resetForRestart();

  // Notify owner — works if session is already active (e.g. after restart)
  if (auth.ilinkUserId) {
    try {
      const providerName = getAIProvider() === "mimo" ? "MiMoCode" : "Claude Code";
      await sendTextMessage({
        to: auth.ilinkUserId,
        text: `✅ 桥接已启动 (${providerName})`,
        baseUrl, token,
      });
    } catch { /* best-effort — fails on cold start (no session yet) */ }
  }

  // Restore scheduled loops
  restoreLoops(sessions, auth, async (uid, prompt, auth) => {
    console.log(`⏰ 定时任务触发: ${prompt.slice(0, 40)}`);
    await sendTextMessage({ to: uid, text: `⏰ 定时任务: ${prompt}`, baseUrl: auth.baseUrl, token: auth.botToken, contextToken: getContextToken(uid) }).catch(() => {});
  });

  // Resume sync cursor
  let getUpdatesBuf = loadSyncBuf();
  if (getUpdatesBuf) {
    console.log(`📋 恢复同步游标 (${getUpdatesBuf.length} bytes)`);
  }

  let nextTimeoutMs = LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (!abortSignal.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        abortSignal,
      });

      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);
      if (isApiError) {
        consecutiveFailures++;
        console.warn(
          `⚠️ getUpdates 错误: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        );
        if (resp.errcode === -14) {
          console.error("❌ Token 已过期，请重新登录。");
          break;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`❌ 连续 ${MAX_CONSECUTIVE_FAILURES} 次失败，等待 ${COOLDOWN_DELAY_MS / 1000}s 后重试...`);
          consecutiveFailures = 0;
          await sleep(COOLDOWN_DELAY_MS, abortSignal);
        } else {
          await sleep(POLL_RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }
      consecutiveFailures = 0;

      if (resp.get_updates_buf) {
        saveSyncBuf(resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      const msgs = resp.msgs ?? [];
      if (msgs.length > 0) {
        console.log(`📨 收到 ${msgs.length} 条新消息`);
      }

      // Fire reminders
      const ready = popReadyReminders(Date.now());
      for (const rem of ready) {
        const to = rem.fromUserId;
        console.log(`🔔 触发提醒: ${rem.message}`);
        try {
          await sendTextMessage({
            to, text: `🔔 提醒: ${rem.message}`,
            baseUrl: rem.baseUrl || baseUrl, token: rem.token || token,
            contextToken: rem.contextToken || getContextToken(to),
          });
        } catch (err) { console.error(`提醒失败: ${String(err)}`); }
      }

      // Fire scheduled tasks
      const cronReady = popReadyTasks(new Date());
      for (const t of cronReady) {
        console.log(`⏰ 定时任务触发: ${t.prompt.slice(0, 40)}`);
        try {
          await sendTextMessage({
            to: t.fromUserId, text: `⏰ 定时任务: ${t.prompt}`,
            baseUrl: t.baseUrl || baseUrl, token: t.token || token,
            contextToken: t.contextToken || getContextToken(t.fromUserId),
          });
        } catch (err) { console.error(`定时任务失败: ${String(err)}`); }
      }

      // Process messages
      for (const msg of msgs) {
        if (abortSignal.aborted) break;

        const parsed = parseInboundMessage(msg);
        const uid = parsed.fromUserId;

        // Check blocklist
        if (!isUserAllowed(uid)) {
          console.log(`🚫 已屏蔽用户: ${uid}`);
          try {
            await sendTextMessage({ to: uid, text: "⚠️ 你已被屏蔽，无法使用此 Bot。", baseUrl, token });
          } catch { /* best-effort */ }
          continue;
        }

        // ---- Priority commands: handle immediately, bypass queue ----
        // These commands must be processed even while another message is being handled

        // /stop — interrupt running AI
        if (parsed.text.trim() === "/stop") {
          const ctrl = activeControllers.get(uid);
          if (ctrl) {
            ctrl.kill();
            ctrl.abort();
            activeControllers.delete(uid);
            console.log(`⏹️ 用户 ${uid} 中断了 ${getAIProvider() === "mimo" ? "MiMoCode" : "Claude Code"}`);
            await sendTextMessage({ to: uid, text: "⏹️ 已停止", baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
          } else {
            await sendTextMessage({ to: uid, text: "当前没有正在处理的任务", baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
          }
          continue;
        }

        // /clear — clear conversation
        if (parsed.text.trim() === "/clear") {
          clearConversation(uid);
          if (sessions[uid]) sessions[uid].activeIndex = -1;
          saveSessions(sessions);
          await sendTextMessage({ to: uid, text: "✅ 会话已清空（历史会话仍可通过 /resume 恢复）", baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
          continue;
        }

        // Permission response (y/n) — resolve pending authorization
        if (tryResolvePermission(uid, parsed.text)) {
          console.log(`✅ 用户 ${uid} 已响应授权请求`);
          continue;
        }

        setReminderContext({
          fromUserId: uid,
          baseUrl,
          token: token ?? "",
          contextToken: parsed.contextToken,
        });

        recordMessageIn();
        console.log(
          `💬 [${uid}] ${parsed.text.slice(0, 50)}${parsed.text.length > 50 ? "..." : ""}`,
        );

        // ---- /resume command ----
        if (parsed.text.trim().startsWith("/resume")) {
          const arg = parsed.text.trim().slice(7).trim();
          const userSessions = sessions[uid];
          if (!userSessions || userSessions.sessions.length === 0) {
            await sendTextMessage({ to: uid, text: "📋 暂无历史会话", baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
          } else if (!arg) {
            const lines = userSessions.sessions.slice(0, 15).map((s, i) => {
              const active = i === userSessions.activeIndex ? " *当前*" : "";
              const ts = new Date(s.lastActiveAt).toLocaleString("zh-CN");
              return `${i + 1}. ${ts} | ${s.preview.slice(0, 30)} (${s.turnCount}轮)${active}`;
            });
            await sendTextMessage({ to: uid, text: `📋 历史会话 (最近15个):\n${lines.join("\n")}\n\n回复 /resume 序号 切换会话`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
          } else {
            const idx = parseInt(arg, 10);
            if (!isNaN(idx) && idx >= 1 && idx <= userSessions.sessions.length) {
              userSessions.activeIndex = idx - 1;
              saveSessions(sessions);
              await sendTextMessage({ to: uid, text: `✅ 已切换到会话 #${idx}: ${userSessions.sessions[idx - 1].preview.slice(0, 40)}`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            } else {
              const kw = arg.toLowerCase();
              const matches = userSessions.sessions
                .map((s, i) => ({ ...s, displayIndex: i + 1 }))
                .filter(s => s.preview.toLowerCase().includes(kw));
              if (matches.length === 0) {
                await sendTextMessage({ to: uid, text: `未找到包含"${arg}"的会话`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
              } else if (matches.length === 1) {
                userSessions.activeIndex = matches[0].displayIndex - 1;
                saveSessions(sessions);
                await sendTextMessage({ to: uid, text: `✅ 已切换到会话: ${matches[0].preview.slice(0, 40)}`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
              } else {
                const lines = matches.slice(0, 10).map(s => `${s.displayIndex}. ${s.preview.slice(0, 40)}`);
                await sendTextMessage({ to: uid, text: `找到多个匹配:\n${lines.join("\n")}\n\n回复 /resume 序号 切换`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
              }
            }
          }
          continue;
        }

        // ---- /compact command ----
        if (parsed.text.trim() === "/compact") {
          const sid = getActiveSessionId(sessions, uid);
          if (!sid) {
            await sendTextMessage({ to: uid, text: "当前没有活跃会话，无需压缩", baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
          } else {
            await sendTextMessage({ to: uid, text: "🔄 正在压缩上下文...", baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            const modelOverride = getAIProvider() === "mimo"
              ? (process.env.MIMO_MODEL?.trim() || undefined)
              : (process.env.CLAUDE_MODEL?.trim() || undefined);
            const ok = await compactSession(sid, WORKSPACE_DIR || process.cwd(), modelOverride);
            if (ok) {
              await sendTextMessage({ to: uid, text: "✅ 上下文已压缩", baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            } else {
              await sendTextMessage({ to: uid, text: "⚠️ 压缩失败，请稍后重试", baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            }
          }
          continue;
        }

        // ---- /mode command — switch permission mode (Claude only) ----
        if (parsed.text.trim().startsWith("/mode")) {
          if (getAIProvider() !== "claude") {
            await sendTextMessage({ to: uid, text: "⚠️ 权限模式仅支持 Claude Code", baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            continue;
          }
          const arg = parsed.text.trim().slice(5).trim().toLowerCase();
          const cur = getPermissionMode(sessions, uid);

          if (!arg) {
            const curLabel = cur === "approve" ? "accept（逐个 y/n 确认）" : "bypass（全自动）";
            await sendTextMessage({
              to: uid,
              text: `🔐 权限模式\n\n当前: ${curLabel}\n\n切换:\n/mode bypass — 全自动\n/mode accept — 每个操作需确认`,
              baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid),
            });
            continue;
          }

          if (arg === "bypass" || arg === "b") {
            setPermissionMode(sessions, uid, "bypass");
            await sendTextMessage({ to: uid, text: "✅ 已切换为 bypass 模式\n全自动执行，不再询问", baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            continue;
          }

          if (arg === "accept" || arg === "a") {
            setPermissionMode(sessions, uid, "approve");
            await sendTextMessage({
              to: uid,
              text: "✅ 已切换为 accept 模式\n\n之后 Claude 执行工具会推送到微信\n回复 y 批准 / n 拒绝（60秒超时自动拒绝）",
              baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid),
            });
            continue;
          }

          await sendTextMessage({ to: uid, text: "用法: /mode bypass 或 /mode accept", baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
          continue;
        }

        // ---- /model command — switch AI model ----
        if (parsed.text.trim().startsWith("/model")) {
          const arg = parsed.text.trim().slice(6).trim();
          if (!arg) {
            const cur = sessions[uid]?.model || process.env[getAIProvider() === "mimo" ? "MIMO_MODEL" : "CLAUDE_MODEL"] || "默认";
            await sendTextMessage({ to: uid, text: `🤖 当前模型: ${cur}\n\n切换: /model <模型名>`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            continue;
          }
          if (!sessions[uid]) sessions[uid] = { sessions: [], activeIndex: -1 };
          sessions[uid].model = arg;
          saveSessions(sessions);
          await sendTextMessage({ to: uid, text: `✅ 模型已切换为: ${arg}\n下次对话生效`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
          continue;
        }

        // ---- /effort command — control thinking depth (Claude only) ----
        if (parsed.text.trim().startsWith("/effort")) {
          if (getAIProvider() !== "claude") {
            await sendTextMessage({ to: uid, text: "⚠️ /effort 仅支持 Claude Code", baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            continue;
          }
          const levels = ["low", "medium", "high", "xhigh", "max"];
          const arg = parsed.text.trim().slice(7).trim().toLowerCase();
          if (!arg) {
            const cur = sessions[uid]?.effort || "high";
            const list = levels.map(l => l === cur ? `▶ ${l}` : `  ${l}`).join("\n");
            await sendTextMessage({ to: uid, text: `🧠 思考深度\n\n${list}\n\n切换: /effort <级别>`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            continue;
          }
          if (!levels.includes(arg)) {
            await sendTextMessage({ to: uid, text: `无效级别，可选: ${levels.join(", ")}`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            continue;
          }
          if (!sessions[uid]) sessions[uid] = { sessions: [], activeIndex: -1 };
          sessions[uid].effort = arg;
          saveSessions(sessions);
          await sendTextMessage({ to: uid, text: `✅ 思考深度已设为: ${arg}`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
          continue;
        }

        // ---- /goal command — goal-driven loop (pass-through to Claude) ----
        if (parsed.text.trim().startsWith("/goal")) {
          const arg = parsed.text.trim().slice(5).trim();
          let claudePrompt = "/goal";
          if (arg) claudePrompt = `/goal ${arg}`;
          // Forward to processOneMessage with modified prompt
          parsed.text = claudePrompt;
          // Fall through to normal message processing
        }

        // ---- /loop command — scheduled tasks ----
        if (parsed.text.trim().startsWith("/loop")) {
          const arg = parsed.text.trim().slice(5).trim();
          if (!arg) {
            const loops = getUserLoops(sessions, uid);
            if (loops.length === 0) {
              await sendTextMessage({ to: uid, text: "📋 暂无定时任务\n\n创建: /loop 5m <提示词>\n停止: /loop stop <id>", baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            } else {
              const lines = loops.map(l => {
                const remaining = Math.max(0, l.nextFireAt - Date.now());
                return `${l.id.slice(0, 8)} | ${formatInterval(l.intervalMs)} | ${l.prompt.slice(0, 30)} | 下次: ${formatInterval(remaining)}后`;
              });
              await sendTextMessage({ to: uid, text: `📋 定时任务:\n${lines.join("\n")}\n\n停止: /loop stop <id>`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            }
            continue;
          }

          // Stop a loop
          if (arg.startsWith("stop")) {
            const target = arg.slice(4).trim();
            if (target === "all") {
              removeAllUserLoops(sessions, uid);
              // Clear all timers for this user
              for (const [key] of loopTimers) {
                if (key.startsWith(`${uid}-`)) {
                  clearTimeout(loopTimers.get(key));
                  loopTimers.delete(key);
                }
              }
              await sendTextMessage({ to: uid, text: "✅ 已停止所有定时任务", baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            } else {
              const loops = getUserLoops(sessions, uid);
              const loop = loops.find(l => l.id.startsWith(target));
              if (!loop) {
                await sendTextMessage({ to: uid, text: `未找到任务: ${target}`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
              } else {
                const key = `${uid}-${loop.id}`;
                if (loopTimers.has(key)) {
                  clearTimeout(loopTimers.get(key));
                  loopTimers.delete(key);
                }
                removeUserLoop(sessions, uid, loop.id);
                await sendTextMessage({ to: uid, text: `✅ 已停止任务: ${loop.id.slice(0, 8)}`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
              }
            }
            continue;
          }

          // Create a loop: /loop <interval> <prompt>
          const intervalMatch = arg.match(/^(\S+)\s+(.+)$/);
          if (!intervalMatch) {
            await sendTextMessage({ to: uid, text: "用法: /loop <间隔> <提示词>\n示例: /loop 5m 检查服务器状态", baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            continue;
          }
          const intervalMs = parseInterval(intervalMatch[1]);
          if (!intervalMs || intervalMs < 60000) {
            await sendTextMessage({ to: uid, text: "间隔至少 1 分钟，格式: 5m / 1h / 1d", baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            continue;
          }
          const loopId = `loop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          const loop: LoopEntry = { id: loopId, prompt: intervalMatch[2], intervalMs, nextFireAt: Date.now() + intervalMs };
          addUserLoop(sessions, uid, loop);
          scheduleLoop(uid, loop, auth, sessions, async (uid, prompt, auth) => {
            console.log(`⏰ 定时任务触发: ${prompt.slice(0, 40)}`);
            await sendTextMessage({ to: uid, text: `⏰ 定时任务: ${prompt}`, baseUrl: auth.baseUrl, token: auth.botToken, contextToken: getContextToken(uid) }).catch(() => {});
          });
          await sendTextMessage({ to: uid, text: `✅ 定时任务已创建\nID: ${loopId.slice(0, 8)}\n间隔: ${formatInterval(intervalMs)}\n提示: ${intervalMatch[2].slice(0, 50)}`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
          continue;
        }

        // ---- /q command — quick commands ----
        if (parsed.text.trim().startsWith("/q")) {
          const arg = parsed.text.trim().slice(2).trim();
          if (!arg) {
            const qcs = sessions[uid]?.quickCommands ?? {};
            const entries = Object.entries(qcs);
            if (entries.length === 0) {
              await sendTextMessage({ to: uid, text: "📋 暂无快捷命令\n\n保存: /q set <名称> <提示词>\n删除: /q del <名称>", baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            } else {
              const lines = entries.map(([k, v]) => `${k} → ${v.slice(0, 40)}`);
              await sendTextMessage({ to: uid, text: `📋 快捷命令:\n${lines.join("\n")}`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            }
            continue;
          }

          if (arg.startsWith("set ")) {
            const rest = arg.slice(4);
            const spaceIdx = rest.indexOf(" ");
            if (spaceIdx === -1) {
              await sendTextMessage({ to: uid, text: "用法: /q set <名称> <提示词>", baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
              continue;
            }
            const name = rest.slice(0, spaceIdx).toLowerCase();
            const prompt = rest.slice(spaceIdx + 1);
            if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) {
              await sendTextMessage({ to: uid, text: "名称格式: 字母开头，仅限字母数字_-，最长32", baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
              continue;
            }
            if (!sessions[uid]) sessions[uid] = { sessions: [], activeIndex: -1 };
            if (!sessions[uid].quickCommands) sessions[uid].quickCommands = {};
            sessions[uid].quickCommands![name] = prompt;
            saveSessions(sessions);
            await sendTextMessage({ to: uid, text: `✅ 快捷命令已保存: ${name}`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            continue;
          }

          if (arg.startsWith("del ")) {
            const name = arg.slice(4).trim().toLowerCase();
            if (sessions[uid]?.quickCommands?.[name]) {
              delete sessions[uid].quickCommands![name];
              saveSessions(sessions);
              await sendTextMessage({ to: uid, text: `✅ 已删除: ${name}`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            } else {
              await sendTextMessage({ to: uid, text: `未找到: ${name}`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            }
            continue;
          }

          // Execute quick command
          const name = arg.split(/\s+/)[0].toLowerCase();
          const extraArgs = arg.slice(name.length).trim();
          const qcs = sessions[uid]?.quickCommands ?? {};
          if (qcs[name]) {
            parsed.text = extraArgs ? `${qcs[name]} ${extraArgs}` : qcs[name];
            // Fall through to normal message processing
          } else {
            await sendTextMessage({ to: uid, text: `未找到快捷命令: ${name}`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
            continue;
          }
        }

        // ---- /undo command — undo last conversation turn ----
        if (parsed.text.trim().startsWith("/undo")) {
          const arg = parsed.text.trim().slice(5).trim();
          const count = parseInt(arg, 10) || 1;
          // Clear current session to effectively undo
          clearConversation(uid);
          if (sessions[uid]) sessions[uid].activeIndex = -1;
          saveSessions(sessions);
          await sendTextMessage({ to: uid, text: `✅ 已撤销最近 ${count} 轮对话\n会话已重置`, baseUrl, token, contextToken: parsed.contextToken || getContextToken(uid) });
          continue;
        }

        // ---- Interrupt previous run if user sends a new message ----
        const prevCtrl = activeControllers.get(uid);
        if (prevCtrl) {
          prevCtrl.kill();
          prevCtrl.abort();
          activeControllers.delete(uid);
          console.log(`⏹️ 用户 ${uid} 发送新消息，中断了上一个 ${getAIProvider() === "mimo" ? "MiMoCode" : "Claude Code"} 进程`);
        }

        // Process message
        try {
          await processOneMessage(
            parsed, msg, auth, sessions, activeControllers,
          );
        } catch (err) {
          const errMsg = String(err);
          console.error(`处理消息出错: ${errMsg}`);
          if (!errMsg.includes("ret=-2")) {
            try {
              await sendTextMessage({
                to: uid,
                text: `⚠️ ${errMsg.slice(0, 200)}`,
                baseUrl, token,
                contextToken: parsed.contextToken || getContextToken(uid),
              });
            } catch { /* ignore send error */ }
          }
        }
      }
    } catch (err) {
      if (abortSignal.aborted) break;
      consecutiveFailures++;
      console.warn(`⚠️ getUpdates 异常 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`❌ 连续 ${MAX_CONSECUTIVE_FAILURES} 次异常，等待 ${COOLDOWN_DELAY_MS / 1000}s 后重试...`);
        consecutiveFailures = 0;
        await sleep(COOLDOWN_DELAY_MS, abortSignal);
      } else {
        await sleep(POLL_RETRY_DELAY_MS, abortSignal);
      }
    }
  }

  console.log("🛑 Monitor 已停止");

  } finally {
    console.log = _origLog;
    console.warn = _origWarn;
    console.error = _origError;
  }
}

// ---------------------------------------------------------------------------
// Message processing (single message → Claude Code)
// ---------------------------------------------------------------------------

async function processOneMessage(
  parsed: ReturnType<typeof parseInboundMessage>,
  _rawMsg: Parameters<typeof parseInboundMessage>[0],
  auth: AuthData,
  sessions: SessionsStore,
  activeControllers: Map<string, { abort: () => void; kill: () => void }>,
): Promise<void> {
  const { baseUrl, botToken: token } = auth;
  const uid = parsed.fromUserId;
  const contextToken = parsed.contextToken || getContextToken(uid);

  // Download media if present
  let mediaPath: string | undefined;
  let mediaMime: string | undefined;
  let mediaFileName: string | undefined;

  const mediaResult = findMediaItem(_rawMsg.item_list);
  if (mediaResult) {
    const downloaded = await downloadMedia({
      cdnBaseUrl: CDN_BASE_URL,
      item: mediaResult.item,
    });
    if (downloaded) {
      mediaPath = downloaded.filePath;
      mediaMime = downloaded.mimeType;
      mediaFileName = downloaded.fileName;
    }
  }

  // Build prompt
  let prompt = parsed.text || "";

  // Append file content if attached
  if (mediaPath) {
    const isText = mediaMime?.startsWith("text/") || mediaFileName?.match(/\.(txt|md|json|xml|yaml|yml|csv|log|py|js|ts|java|cpp|c|h|go|rs)$/i);
    const isImage = mediaMime?.startsWith("image/");
    const isVoice = mediaMime?.startsWith("audio/");
    const isVideo = mediaMime?.startsWith("video/");

    if (isImage) {
      const buf = fs.readFileSync(mediaPath);
      prompt += `\n\n[用户发送了一张图片: ${path.basename(mediaPath)}, ${buf.length} 字节]\n[图片存储在: ${mediaPath}]\n请使用 Read 工具查看此图片文件。`;
    } else if (isVoice) {
      const buf = fs.readFileSync(mediaPath);
      prompt += `\n\n[用户发送了一条语音: ${path.basename(mediaPath)}, ${buf.length} 字节${mediaMime?.includes("wav") ? ", 已转码为 WAV" : ""}]\n语音文件存储在: ${mediaPath}`;
    } else if (isVideo) {
      const buf = fs.readFileSync(mediaPath);
      prompt += `\n\n[用户发送了一个视频: ${path.basename(mediaPath) || "video"}, ${buf.length} 字节]\n[视频存储在: ${mediaPath}]`;
    } else if (isText) {
      try {
        const content = fs.readFileSync(mediaPath, "utf-8").slice(0, 50000);
        prompt += `\n\n[用户提供了文件: ${mediaFileName || "attachment"}]\n${content}`;
      } catch {
        prompt += `\n\n[用户提供了文件: ${mediaFileName || "attachment"}, 无法读取]`;
      }
    } else {
      const buf = fs.readFileSync(mediaPath);
      prompt += `\n\n[用户提供了文件: ${mediaFileName || "attachment"}, ${buf.length} 字节, 二进制格式]`;
    }
  }

  // Create abort controller for this run (kill fn populated via onKillReady)
  const ac = new AbortController();
  const entry = { abort: () => ac.abort(), kill: () => {} };
  activeControllers.set(uid, entry);

  let toolNotifications = 0;
  const md = new StreamingMarkdownFilter();
  let streamBuf = "";     // accumulated filtered output
  let streamSentLen = 0;  // how many chars already sent to WeChat
  let lastFlush = Date.now();
  const FLUSH_CHARS = 3800;       // Near WeChat's 4000 char limit
  const FLUSH_MIN_CHARS = 400;    // Minimum chars before flushing at boundary
  const FLUSH_IDLE_MS = 8000;     // Flush after 8s idle even if below threshold

  const flushStream = async (force = false) => {
    const newText = streamBuf.slice(streamSentLen);
    if (newText.length === 0) return;

    // Smart flush: check for structural boundaries
    const shouldFlush = force
      || newText.length >= FLUSH_CHARS
      || (newText.length >= FLUSH_MIN_CHARS
          && Date.now() - lastFlush >= FLUSH_IDLE_MS
          && /\n\n|\n---|\n#{1,3} /.test(newText));

    if (!shouldFlush) return;

    const clean = newText.replace(/\[SEND_(IMAGE|FILE|VIDEO):[^\]]+\]/gi, "").trim();
    if (clean) {
      // Stream chunks: no contextToken to avoid ret=-2 retry storms
      await sendTextMessage({
        to: uid, text: clean,
        baseUrl, token,
      }).catch(() => {});
      streamSentLen = streamBuf.length;
      recordMessageOut();
    }
    lastFlush = Date.now();
  };

  console.log(`🤖 调用 ${getAIProvider() === "mimo" ? "MiMoCode" : "Claude Code"}...`);
  const startTime = Date.now();
  const providerName = getAIProvider() === "mimo" ? "MiMoCode" : "Claude Code";
  startTask(parsed.text, providerName);

  // Typing indicator — show "正在输入..." in WeChat every 2.5s
  let typingTicket: string | undefined;
  try {
    const cfg = await getConfig({ baseUrl, token, ilinkUserId: uid, contextToken });
    typingTicket = cfg.typing_ticket;
  } catch { /* ignore — typing indicator is best-effort */ }

  const typingTimer = setInterval(() => {
    if (!typingTicket) return;
    sendTyping({
      baseUrl, token,
      body: { ilink_user_id: uid, typing_ticket: typingTicket, status: TypingStatus.TYPING },
    }).catch(() => {});
  }, TYPING_INTERVAL_MS);

  // Periodic stream flush timer
  const streamTimer = setInterval(() => {
    if (Date.now() - lastFlush >= FLUSH_IDLE_MS) {
      flushStream().catch(() => {});
    }
  }, 1000);

  // Only use permission handler for Claude in approve mode
  const permMode = getPermissionMode(sessions, uid);
  const usePermissionHandler = getAIProvider() === "claude" && permMode === "approve";

  // Use session-level model if set, otherwise fall back to env
  const sessionModel = sessions[uid]?.model;
  const envModel = getAIProvider() === "mimo"
    ? (process.env.MIMO_MODEL?.trim() || undefined)
    : (process.env.CLAUDE_MODEL?.trim() || undefined);

  try {
    const result = await streamAI(
      {
        prompt,
        cwd: WORKSPACE_DIR || process.cwd(),
        sessionId: getActiveSessionId(sessions, uid),
        systemPrompt: await getAISystemPrompt(),
        model: sessionModel || envModel,
        effort: sessions[uid]?.effort,
        abortSignal: ac.signal,
        onKillReady: (killFn) => { entry.kill = killFn; },
        onPermissionRequest: usePermissionHandler ? createPermissionHandler(uid, auth) : undefined,
      },
      {
        onText: (delta) => {
          const filtered = md.feed(delta);
          streamBuf += filtered;
          if (streamBuf.length - streamSentLen >= FLUSH_CHARS) {
            flushStream().catch(() => {});
          }
        },
        onThinking: (_delta) => {
          // Thinking accumulates silently
        },
        onToolUse: async (toolName, input) => {
          // Flush pending text before showing tool notification
          await flushStream().catch(() => {});
          toolNotifications++;
          recordToolCall();
          addTaskTool(toolName);
          console.log(`🔧 #${toolNotifications}: ${toolDesc(toolName, input)}`);
        },
        onDone: async (_fullText, sessionId) => {
          // Save session for --resume
          if (sessionId) {
            addSessionEntry(sessions, uid, sessionId, parsed.text || "(空消息)");
            saveSessions(sessions);
          }
        },
        onError: (err) => {
          const name = getAIProvider() === "mimo" ? "MiMoCode" : "Claude Code";
          console.error(`${name} 错误: ${err.message}`);
        },
      },
    );

    const elapsed = Date.now() - startTime;
    recordLlmCall(elapsed);
    endTask();

    // Estimate token usage (rough: 1 token per 4 chars English, 1 per 2 chars Chinese)
    const textLen = result.text.length;
    const estimatedTokens = Math.ceil(textLen / 3); // Average estimate
    recordTokens(estimatedTokens);

    clearInterval(streamTimer);

    // Flush remaining streamed text
    await flushStream().catch(() => {});

    const toolInfo = toolNotifications > 0 ? `, ${toolNotifications} 次工具调用` : "";
    const providerName = getAIProvider() === "mimo" ? "MiMoCode" : "Claude Code";
    console.log(`✅ ${providerName} 完成 (${elapsed}ms, ${result.text.length} chars${toolInfo})${result.aborted ? " [已中断]" : ""}`);

    // Send reply (fault-tolerant — ret=-2 from WeChat must not crash bridge)
    try {
      let filtered = streamBuf + md.flush();

      // --- Extract [SEND_IMAGE:path], [SEND_FILE:path], [SEND_VIDEO:path] ---
      const fileMarkerRegex = /\[SEND_(IMAGE|FILE|VIDEO):([^\]]+)\]/gi;
      const fileMatches: { type: string; filePath: string }[] = [];
      let match: RegExpExecArray | null;
      while ((match = fileMarkerRegex.exec(filtered)) !== null) {
        fileMatches.push({ type: match[1].toUpperCase(), filePath: match[2].trim() });
      }
      // Remove markers from the text shown to user
      filtered = filtered.replace(fileMarkerRegex, "").trim();

      // Send ONLY the remaining unsent text (streaming already sent most of it)
      // Apply smart splitting for long messages
      const remaining = filtered.slice(streamSentLen).trim();
      if (remaining) {
        const chunks = splitMessage(remaining);
        for (const chunk of chunks) {
          await sendTextMessage({
            to: uid, text: chunk,
            baseUrl, token, contextToken: getContextToken(uid),
          }).catch(() => {});
          recordMessageOut();
        }
        console.log(`📤 剩余回复已发送 (${remaining.length} chars, ${chunks.length} 段)`);
      } else if (!result.aborted && toolNotifications === 0 && fileMatches.length === 0 && streamSentLen === 0) {
        await sendTextMessage({
          to: uid, text: "✅ 完成（无文本输出）",
          baseUrl, token, contextToken: getContextToken(uid),
        });
      }

      // Send detected files
      for (const fm of fileMatches) {
        let localPath = fm.filePath;
        let isRemote = false;

        // --- Remote URL support: download first, then send ---
        if (localPath.startsWith("http://") || localPath.startsWith("https://")) {
          try {
            console.log(`🌐 下载远程文件: ${localPath.slice(0, 80)}...`);
            const dlResp = await fetch(localPath);
            if (!dlResp.ok) {
              console.warn(`⚠️ 远程文件下载失败 (${dlResp.status}): ${localPath}`);
              await sendTextMessage({
                to: uid, text: `⚠️ 远程文件下载失败 (${dlResp.status}): ${localPath}`,
                baseUrl, token, contextToken: getContextToken(uid),
              }).catch(() => {});
              continue;
            }
            const buf = Buffer.from(await dlResp.arrayBuffer());
            const urlObj = new URL(localPath);
            const urlName = path.basename(urlObj.pathname) || "download";
            const tmpDir = path.join(os.tmpdir(), "wechat-ai", "media-outbound");
            fs.mkdirSync(tmpDir, { recursive: true });
            const tmpPath = path.join(tmpDir, `remote_${Date.now()}_${urlName}`);
            fs.writeFileSync(tmpPath, buf);
            isRemote = true;
            localPath = tmpPath;
            console.log(`✅ 远程文件已下载: ${tmpPath} (${buf.length} bytes)`);
          } catch (fetchErr) {
            console.warn(`⚠️ 远程文件下载失败: ${String(fetchErr)}`);
            await sendTextMessage({
              to: uid, text: `⚠️ 远程文件下载失败: ${String(fetchErr).slice(0, 100)}`,
              baseUrl, token, contextToken: getContextToken(uid),
            }).catch(() => {});
            continue;
          }
        }

        if (!fs.existsSync(localPath)) {
          console.warn(`⚠️ 文件不存在: ${localPath}`);
          await sendTextMessage({
            to: uid, text: `⚠️ 文件不存在: ${localPath}`,
            baseUrl, token, contextToken: getContextToken(uid),
          }).catch(() => {});
          continue;
        }
        try {
          if (fm.type === "IMAGE") {
            await sendImageMessage({
              to: uid, filePath: localPath,
              baseUrl, token, cdnBaseUrl: CDN_BASE_URL,
              contextToken: getContextToken(uid),
            });
            console.log(`📸 图片已发送: ${path.basename(localPath)}${isRemote ? " (远程)" : ""}`);
          } else if (fm.type === "VIDEO") {
            await sendVideoMessage({
              to: uid, filePath: localPath,
              baseUrl, token, cdnBaseUrl: CDN_BASE_URL,
              contextToken: getContextToken(uid),
            });
            console.log(`🎬 视频已发送: ${path.basename(localPath)}${isRemote ? " (远程)" : ""}`);
          } else {
            await sendFileMessage({
              to: uid, filePath: localPath,
              baseUrl, token, cdnBaseUrl: CDN_BASE_URL,
              contextToken: getContextToken(uid),
            });
            console.log(`📎 文件已发送: ${path.basename(localPath)}${isRemote ? " (远程)" : ""}`);
          }
          recordMessageOut();
          // Cleanup temp file
          if (isRemote) {
            try { fs.unlinkSync(localPath); } catch { /* ignore */ }
          }
        } catch (fileErr) {
          console.error(`发送文件失败 (${localPath}): ${String(fileErr)}`);
          await sendTextMessage({
            to: uid, text: `⚠️ 发送文件失败: ${path.basename(localPath)} — ${String(fileErr).slice(0, 100)}`,
            baseUrl, token, contextToken: getContextToken(uid),
          }).catch(() => {});
        }
      }

      // --- Auto file push: detect file paths in response and auto-send ---
      const AUTO_PUSH_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|pdf|docx?|xlsx?|pptx?|txt|md|csv|json|xml|zip|tar\.gz|rar|mp[34]|wav|ogg|mov|avi|mkv)$/i;
      const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
      const pathRegex = /(?:[A-Z]:\\[^\s`'"()\[\]{}|<>]+|\/(?:Users|home|tmp|var|etc|opt)\/[^\s`'"()\[\]{}|<>]+|~\/[^\s`'"()\[\]{}|<>]+)/g;
      const pushableFiles: string[] = [];
      let pathMatch: RegExpExecArray | null;

      while ((pathMatch = pathRegex.exec(filtered)) !== null) {
        let p = pathMatch[0].replace(/[.,;!?]+$/, ""); // strip trailing punctuation
        if (p.startsWith("~")) p = p.replace("~", os.homedir());
        if (!fs.existsSync(p)) continue;

        try {
          const stat = fs.statSync(p);
          if (stat.isDirectory()) {
            // Scan directory for pushable files
            const files = fs.readdirSync(p).filter(f => AUTO_PUSH_EXTENSIONS.test(f)).slice(0, 10);
            for (const f of files) {
              const fp = path.join(p, f);
              if (fs.statSync(fp).size <= MAX_FILE_SIZE) pushableFiles.push(fp);
            }
          } else if (stat.size <= MAX_FILE_SIZE && AUTO_PUSH_EXTENSIONS.test(p)) {
            pushableFiles.push(p);
          }
        } catch { /* ignore */ }
      }

      // Deduplicate and send auto-detected files
      const sentFiles = new Set<string>();
      for (const fp of pushableFiles.slice(0, 5)) { // max 5 auto-push files
        if (sentFiles.has(fp)) continue;
        sentFiles.add(fp);
        try {
          const ext = path.extname(fp).toLowerCase();
          if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(ext)) {
            await sendImageMessage({ to: uid, filePath: fp, baseUrl, token, cdnBaseUrl: CDN_BASE_URL, contextToken: getContextToken(uid) });
          } else if (/\.(mp[34]|mov|avi|mkv)$/i.test(ext)) {
            await sendVideoMessage({ to: uid, filePath: fp, baseUrl, token, cdnBaseUrl: CDN_BASE_URL, contextToken: getContextToken(uid) });
          } else {
            await sendFileMessage({ to: uid, filePath: fp, baseUrl, token, cdnBaseUrl: CDN_BASE_URL, contextToken: getContextToken(uid) });
          }
          console.log(`📎 自动推送文件: ${path.basename(fp)}`);
          recordMessageOut();
        } catch (err) {
          console.warn(`自动推送文件失败 (${fp}): ${String(err)}`);
        }
      }
    } catch (sendErr) {
      console.error(`发送回复失败: ${String(sendErr)}`);
    }
  } catch (err) {
    const msg = String(err);
    if (!ac.signal.aborted) {
      const pname = getAIProvider() === "mimo" ? "MiMoCode" : "Claude Code";
      console.error(`${pname} 失败: ${msg}`);
      recordError(msg);
      try {
        await sendTextMessage({
          to: uid,
          text: `❌ ${pname} 出错: ${msg.slice(0, 300)}`,
          baseUrl, token,
          contextToken: getContextToken(uid),
        });
      } catch { /* ignore */ }
    }
  } finally {
    clearInterval(typingTimer);
    clearInterval(streamTimer);
    activeControllers.delete(uid);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolDesc(name: string, input: Record<string, unknown>): string {
  const short = (k: string) => String(input[k] || "").slice(0, 50);
  const n = name.toLowerCase();
  switch (n) {
    case "bash": return `执行: \`${short("command")}\``;
    case "read": return `读取: ${(input.file_path as string || "").split(/[/\\]/).pop() || "-"}`;
    case "write": return `写入: ${(input.file_path as string || "").split(/[/\\]/).pop() || "-"}`;
    case "edit": return `编辑: ${(input.file_path as string || "").split(/[/\\]/).pop() || "-"}`;
    case "glob": return `查找: \`${short("pattern")}\``;
    case "grep": return `搜索: "${short("pattern")}"`;
    case "websearch": return `搜索网页: ${short("query")}`;
    case "webfetch": return `访问: ${short("url")}`;
    case "task": return `子任务: ${short("description")}`;
    case "askuserquestion": return `提问用户: ${short("question")}`;
    default: return `调用 ${name}`;
  }
}
