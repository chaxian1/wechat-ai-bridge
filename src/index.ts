#!/usr/bin/env node
/**
 * Claude → WeChat Bridge  (single-process: bridge + management UI)
 *
 * Usage:
 *   npm start              — start bridge + management UI on :3456
 *   npm run login          — login only (save credentials), then exit
 *
 * Protocol: WeChat iLink Bot HTTP API
 * Ported from @tencent-weixin/openclaw-weixin (MIT)
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- Auth ---
import { hasAuth, loadAuth } from "./auth/store.ts";
import { loginWithQR } from "./auth/qr-login.ts";
import { listBlocked, blockUser, unblockUser } from "./auth/users.ts";

// --- Bridge ---
import { startMonitor } from "./monitor.ts";
import { clearConversation } from "./messaging/conversation.ts";
import { getStats } from "./messaging/stats.ts";
import type { AuthData } from "./auth/store.ts";

// --- Config ---
import { ILINK_BASE_URL, RESTART_DELAY_MS, ERROR_RETRY_DELAY_MS } from "./config.ts";
import { isAutostartEnabled, setAutostart } from "./autostart.ts";

// --- Security ---
import { redact } from "./utils/redact.ts";

// ===========================================================================
// Bootstrap
// ===========================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3456", 10);
const PROJECT_DIR = path.resolve(__dirname, "..");
const STATE_DIR = path.join(PROJECT_DIR, "state");
const ENV_FILE = path.join(PROJECT_DIR, ".env");
const LOG_FILE = path.join(STATE_DIR, "bridge.log");
const LOG_MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const LOG_KEEP = 3;
const MAX_LOG_LINES = 500;

// Machine fingerprint — detect if project was copied from another machine
function checkMachineFingerprint(): void {
  const fpFile = path.join(STATE_DIR, ".machine");
  const currentFp = `${os.hostname()}|${os.homedir()}|${process.platform}`;
  try {
    if (fs.existsSync(fpFile)) {
      const storedFp = fs.readFileSync(fpFile, "utf-8").trim();
      if (storedFp && storedFp !== currentFp) {
        addLog("🔄 检测到机器变更，清理旧凭证...");
        const toClear = ["auth.json", "sync.json", "context_tokens.json", "cc-sessions.json"];
        for (const f of toClear) {
          try { fs.unlinkSync(path.join(STATE_DIR, f)); } catch { /* ignore */ }
        }
      }
    }
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(fpFile, currentFp, "utf-8");
  } catch { /* best-effort */ }
}

// ===========================================================================
// Log management
// ===========================================================================

// Save original console BEFORE monitor overrides it (avoids recursion: monitor
// onLog → addLog → console.log → onLog → …)
const _rawConsoleLog = console.log.bind(console);

const logBuffer: string[] = [];

function rotateLogFile(): void {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_SIZE) {
      for (let i = LOG_KEEP - 1; i >= 0; i--) {
        const old = i === 0 ? LOG_FILE : `${LOG_FILE}.${i}`;
        const next = `${LOG_FILE}.${i + 1}`;
        if (fs.existsSync(old)) {
          if (i === LOG_KEEP - 1) fs.unlinkSync(old);
          else fs.renameSync(old, next);
        }
      }
    }
  } catch { /* best-effort */ }
}

function addLog(line: string): void {
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;
  // Redact sensitive information before logging
  const redactedLine = redact(line);
  const entry = `[${ts}] ${redactedLine}`;
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
  _rawConsoleLog(redactedLine);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    rotateLogFile();
    fs.appendFileSync(LOG_FILE, entry + "\n", "utf-8");
  } catch { /* best-effort */ }
}

// Best-effort notification to bot owner via WeChat
async function sendOwnerNotification(text: string): Promise<void> {
  try {
    const auth = loadAuth();
    if (!auth?.ilinkUserId) return;
    const { sendTextMessage } = await import("./messaging/send-media.ts");
    await sendTextMessage({
      to: auth.ilinkUserId,
      text,
      baseUrl: auth.baseUrl,
      token: auth.botToken,
    });
  } catch { /* best-effort — don't crash on notification failure */ }
}

// ===========================================================================
// Bridge lifecycle
// ===========================================================================

type BridgeState = "idle" | "starting" | "running" | "stopping" | "error";

let bridgeState: BridgeState = "idle";
let monitorAbortController: AbortController | null = null;
let bridgeStartTime: number | null = null;
let pendingRestart = false; // start() called while still stopping → restart after stop completes
let bridgeStopResolve: (() => void) | null = null; // resolves when bridge fully stopped

function getStatus() {
  const authExists = fs.existsSync(path.join(STATE_DIR, "auth.json"));
  let auth: Record<string, unknown> | null = null;
  if (authExists) {
    try { auth = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "auth.json"), "utf-8")); } catch { /* ignore */ }
  }
  return {
    running: bridgeState === "running",
    pid: process.pid,
    configured: authExists,
    botId: (auth?.ilinkBotId as string) ?? null,
    userId: (auth?.ilinkUserId as string) ?? null,
    uptime: bridgeState === "running" && bridgeStartTime ? Date.now() - bridgeStartTime : 0,
  };
}

function internalStart(): void {
  if (bridgeState === "running" || bridgeState === "starting") return;

  // If still stopping, defer restart until stop completes
  if (bridgeState === "stopping") {
    pendingRestart = true;
    addLog("⏳ 桥接正在关闭，关闭完成后自动重启...");
    return;
  }

  const auth = loadAuth();
  if (!auth) {
    addLog("⚠️ 未登录，无法启动。请在终端运行 npm start 进行扫码登录。");
    return;
  }

  pendingRestart = false;
  bridgeState = "starting";
  addLog("🚀 启动桥接...");

  monitorAbortController = new AbortController();
  bridgeStartTime = Date.now();

  startMonitor({ auth, onLog: addLog }, monitorAbortController.signal)
    .then(() => {
      addLog("桥接已退出");
      if (bridgeState === "stopping") {
        // Manual stop
        addLog("桥接已停止");
        sendOwnerNotification("🛑 桥接已关闭");
        bridgeStopResolve?.();
        bridgeStopResolve = null;
        bridgeState = "idle";
        bridgeStartTime = null;
        // If start() was called while stopping, restart now
        if (pendingRestart) {
          addLog("🔄 执行待定重启...");
          internalStart();
        }
      } else {
        // Natural exit (e.g. token expired) — restart after short delay
        addLog("桥接非预期退出，3 秒后自动重启...");
        sendOwnerNotification("🛑 桥接已关闭（非预期退出，3 秒后自动重启）");
        bridgeState = "idle";
        bridgeStartTime = null;
        setTimeout(() => {
          if (bridgeState === "idle" && loadAuth()) internalStart();
        }, RESTART_DELAY_MS);
      }
    })
    .catch((err) => {
      addLog(`桥接异常退出: ${String(err)}，10 秒后自动重试...`);
      sendOwnerNotification(`🛑 桥接已关闭（异常退出: ${String(err).slice(0, 50)}，10 秒后自动重试）`);
      bridgeState = "idle";
      bridgeStartTime = null;
      setTimeout(() => {
        if (bridgeState === "idle" && loadAuth()) internalStart();
      }, ERROR_RETRY_DELAY_MS);
    });

  bridgeState = "running";
}

function internalStop(): void {
  if (bridgeState !== "running") {
    addLog("桥接未在运行");
    return;
  }
  bridgeState = "stopping";
  addLog("🛑 关闭桥接...");
  monitorAbortController?.abort();
}

/** Web-initiated relogin: clear credentials only (no blocking QR flow). */
async function internalReloginWeb(): Promise<{ ok: boolean; message: string }> {
  addLog("🔄 Web 端触发重新登录...");
  if (bridgeState === "running" || bridgeState === "starting") {
    internalStop();
    await new Promise<void>((resolve) => {
      bridgeStopResolve = resolve;
      setTimeout(resolve, 10_000); // max wait 10s
    });
    bridgeStopResolve = null;
  }
  const files = ["auth.json", "sync.json", "context_tokens.json"];
  for (const f of files) {
    try { fs.unlinkSync(path.join(STATE_DIR, f)); } catch { /* ignore */ }
  }
  bridgeState = "idle";
  addLog("凭证已清除，请在终端运行 npm start 扫码登录");
  return { ok: true, message: "凭证已清除。请在终端运行 npm start 进行扫码登录。" };
}

/** Terminal-initiated relogin: clears credentials and blocks for QR scan. */
async function internalReloginTerminal(): Promise<boolean> {
  addLog("🔄 重新登录...");
  internalStop();

  // Wait for monitor to fully stop
  await new Promise<void>((resolve) => {
    bridgeStopResolve = resolve;
    setTimeout(resolve, 10_000); // max wait 10s
  });
  bridgeStopResolve = null;

  const files = ["auth.json", "sync.json", "context_tokens.json"];
  for (const f of files) {
    try { fs.unlinkSync(path.join(STATE_DIR, f)); } catch { /* ignore */ }
  }
  bridgeState = "idle";
  addLog("凭证已清除，开始扫码登录...");

  const result = await loginWithQR(ILINK_BASE_URL);
  if (!result.success) {
    addLog(`登录失败: ${result.message}`);
    return false;
  }
  addLog("✅ 登录成功");
  internalStart();
  return true;
}

// ===========================================================================
// Config management
// ===========================================================================

function readCCSettings(): Record<string, string> {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".claude", "settings.json"),
    path.join(home, ".claude", "settings.local.json"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, "utf-8");
        const parsed = JSON.parse(raw) as { env?: Record<string, string> };
        if (parsed.env) return parsed.env;
      }
    } catch { /* ignore */ }
  }
  return {};
}

function parseEnvValue(raw: string): string {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function readEnvConfig(): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    if (!fs.existsSync(ENV_FILE)) return result;
    const content = fs.readFileSync(ENV_FILE, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = parseEnvValue(trimmed.slice(eqIdx + 1));
      if (key) result[key] = value;
    }
  } catch { /* ignore */ }
  return result;
}

function updateEnvConfig(updates: Record<string, string>): void {
  let content = "";
  try { content = fs.readFileSync(ENV_FILE, "utf-8"); } catch { /* ignore */ }

  const lines = content.split("\n");
  const updatedKeys = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key in updates) {
      lines[i] = `${key}=${updates[key]}`;
      updatedKeys.add(key);
    }
  }

  for (const [k, v] of Object.entries(updates)) {
    if (!updatedKeys.has(k)) {
      lines.push(`${k}=${v}`);
    }
  }

  fs.writeFileSync(ENV_FILE, lines.join("\n"), "utf-8");

  // Also update process.env so getter functions in config.ts pick up new values
  // without requiring a full process restart
  for (const [k, v] of Object.entries(updates)) {
    process.env[k] = v;
  }

  addLog(`配置已更新: ${Object.keys(updates).join(", ")}`);
}

// ===========================================================================
// HTTP helpers
// ===========================================================================

const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1 MB

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("请求体超过 1 MB 限制"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ===========================================================================
// HTTP server
// ===========================================================================

const HTML_FILE = path.join(PROJECT_DIR, "manage.html");

function createHttpServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || "";
    const allowed = origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`;
    res.setHeader("Access-Control-Allow-Origin", allowed ? origin : `http://localhost:${PORT}`);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = req.url || "/";
    const json = (code: number, data: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };

    try {
      // --- Status ---
      if (url === "/api/status") {
        return json(200, getStatus());
      }

      // --- Start / Stop / Restart / Relogin ---
      if (url === "/api/start" && req.method === "POST") {
        internalStart();
        return json(200, { ok: true, message: "启动中..." });
      }

      if (url === "/api/stop" && req.method === "POST") {
        internalStop();
        return json(200, { ok: true, message: "关闭中..." });
      }

      if (url === "/api/restart" && req.method === "POST") {
        addLog("🔄 执行重启...");
        internalStop();
        // Wait for bridge to fully stop (max 15s), then start
        const stopped = await Promise.race([
          new Promise<void>((resolve) => { bridgeStopResolve = resolve; }),
          new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
        ]);
        bridgeStopResolve = null;
        if (bridgeState === "idle") {
          internalStart();
          return json(200, { ok: true, message: "重启完成" });
        }
        return json(200, { ok: false, message: `重启超时: bridge 仍在 ${bridgeState} 状态` });
      }

      if (url === "/api/restart-process" && req.method === "POST") {
        addLog("🔄 重启进程以加载新代码...");
        sendOwnerNotification("🔄 正在重启以加载新代码...");
        // Stop bridge first
        if (bridgeState === "running") {
          internalStop();
          await new Promise<void>((resolve) => {
            bridgeStopResolve = resolve;
            setTimeout(resolve, 5000);
          });
        }
        // Exit with code 42 to signal manage.bat to restart
        setTimeout(() => process.exit(42), 200);
        return json(200, { ok: true, message: "正在重启..." });
      }

      if (url === "/api/relogin" && req.method === "POST") {
        const result = internalReloginWeb();
        return json(200, result);
      }

      // --- Health (iLink connectivity) ---
      if (url === "/api/health") {
        const auth = loadAuth();
        if (!auth) return json(200, { ok: true, ilink: false, message: "未登录" });
        try {
          const { getConfig } = await import("./api/client.ts");
          await getConfig({ baseUrl: auth.baseUrl, token: auth.botToken, ilinkUserId: auth.ilinkUserId || "" });
          return json(200, { ok: true, ilink: true, message: "iLink 连接正常" });
        } catch (err) {
          return json(200, { ok: true, ilink: false, message: `iLink 连接失败: ${String(err).slice(0, 100)}` });
        }
      }

      // --- Logs ---
      if (url === "/api/logs" || url.startsWith("/api/logs?")) {
        const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
        const params = new URLSearchParams(qs);
        const tail = parseInt(params.get("tail") || "100", 10);
        const lines = logBuffer.slice(-tail);
        return json(200, { lines, count: logBuffer.length });
      }

      // --- Webhook ---
      const webhookMatch = url.match(/^\/api\/webhook\/(.+)\/send$/);
      if (webhookMatch && req.method === "POST") {
        const hookToken = process.env.WEBHOOK_TOKEN;
        if (!hookToken) {
          return json(403, { error: "未配置 WEBHOOK_TOKEN，请在 .env 中设置" });
        }
        if (webhookMatch[1] !== hookToken) {
          return json(403, { error: "invalid token" });
        }
        const body = await readBody(req);
        let parsed: { to: string; text: string };
        try { parsed = JSON.parse(body); } catch { return json(400, { error: "无效的 JSON" }); }
        const { to, text } = parsed;
        if (!to || !text) {
          return json(400, { error: "需要 to 和 text" });
        }
        const auth = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "auth.json"), "utf-8"));
        const { sendTextMessage } = await import("./messaging/send-media.ts");
        await sendTextMessage({ to, text, baseUrl: auth.baseUrl, token: auth.botToken });
        addLog(`📨 Webhook → ${to}: ${text.slice(0, 40)}`);
        return json(200, { ok: true });
      }

      // --- Autostart ---
      if (url === "/api/autostart") {
        if (req.method === "GET") {
          return json(200, { enabled: isAutostartEnabled(PROJECT_DIR) });
        } else if (req.method === "POST") {
          const body = await readBody(req);
          const { enabled } = JSON.parse(body) as { enabled: boolean };
          const result = setAutostart(enabled, PROJECT_DIR);
          addLog(result.message);
          return json(200, { ok: result.ok, enabled: isAutostartEnabled(PROJECT_DIR), message: result.message });
        }
      }

      // --- Blocklist ---
      if (url === "/api/blocklist") {
        if (req.method === "GET") {
          return json(200, listBlocked());
        } else if (req.method === "POST") {
          const body = await readBody(req);
          const { userId, action } = JSON.parse(body) as { userId: string; action?: string };
          if (action === "unblock") {
            unblockUser(userId);
            return json(200, { ok: true });
          }
          blockUser(userId);
          clearConversation(userId.replace(/[<>:"/\\|?*@]/g, "_"));
          return json(200, { ok: true });
        }
      }

      // --- Stats ---
      if (url === "/api/stats") {
        return json(200, getStats());
      }

      // --- Webhook info ---
      if (url === "/api/webhook-info") {
        const hookToken = process.env.WEBHOOK_TOKEN;
        if (!hookToken) return json(200, { configured: false, message: "未配置 WEBHOOK_TOKEN，请在 .env 中设置" });
        const hookUrl = `http://localhost:${PORT}/api/webhook/${hookToken}/send`;
        return json(200, { configured: true, url: hookUrl, token: hookToken });
      }

      // --- Test send (to bot owner) ---
      if (url === "/api/test-send" && req.method === "POST") {
        const auth = loadAuth();
        if (!auth?.ilinkUserId) return json(400, { ok: false, error: "未登录" });
        try {
          const { sendTextMessage } = await import("./messaging/send-media.ts");
          const { getContextToken } = await import("./auth/store.ts");
          // Use stored context_token if available (from prior inbound messages)
          await sendTextMessage({
            to: auth.ilinkUserId,
            text: `✅ 测试消息 — WeChat AI Bridge 运行正常\n${new Date().toLocaleString("zh-CN")}`,
            baseUrl: auth.baseUrl,
            token: auth.botToken,
            contextToken: getContextToken(auth.ilinkUserId),
          });
          addLog("📨 已发送测试消息");
          return json(200, { ok: true, message: "已发送" });
        } catch (err) {
          const msg = String(err);
          const hint = msg.includes("ret=-2") ? "（需要先给 Bot 发一条微信消息建立会话）" : "";
          return json(500, { ok: false, error: `发送失败: ${msg.slice(0, 60)}${hint}` });
        }
      }

      // --- LLM test ---
      if (url === "/api/test-llm" && req.method === "POST") {
        const body = await readBody(req);
        const cfg = JSON.parse(body) as { apiKey: string; baseUrl: string; model: string };
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 10_000);
        try {
          const resp = await fetch(`${cfg.baseUrl || "https://api.anthropic.com"}/v1/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: cfg.model || "claude-sonnet-4-6-20250514", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
            signal: controller.signal,
          });
          const text = await resp.text();
          return json(resp.ok ? 200 : 400, { ok: resp.ok, status: resp.status, preview: text.slice(0, 200) });
        } catch (err) {
          return json(500, { ok: false, error: (err as Error).message });
        } finally {
          clearTimeout(t);
        }
      }

      // --- AI Status (check configured AI provider CLI) ---
      if (url.startsWith("/api/ai-status")) {
        try {
          const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
          const params = new URLSearchParams(qs);
          const cfg = readEnvConfig();
          const provider = (params.get("provider") || cfg.AI_PROVIDER || "claude").toLowerCase();
          const isMimo = provider === "mimo" || provider === "mimocode";
          const pathKey = isMimo ? "MIMO_PATH" : "CLAUDE_PATH";
          const manualPath = params.get("path") || "";
          const configuredPath = manualPath || cfg[pathKey] || "";
          const bin = configuredPath || (isMimo ? "mimo" : "claude");
          let actualPath = configuredPath;
          // If manual path provided but doesn't exist, return error
          if (manualPath && !fs.existsSync(manualPath)) {
            return json(200, { ok: false, error: `路径不存在: ${manualPath}` });
          }
          // For auto-detect, use the same search logic as the bridge's findMimoBin/findClaudeBin
          if (!actualPath) {
            try {
              if (isMimo) {
                const { findMimoBin } = await import("./mimocode/client.ts");
                actualPath = findMimoBin();
              } else {
                const { findClaudeBin } = await import("./claude/client.ts");
                actualPath = findClaudeBin();
              }
            } catch {
              // Fallback to just the command name
              actualPath = isMimo ? "mimo" : "claude";
            }
            // If auto-detect returned just the command name (fallback), try where/which
            if (actualPath === "mimo" || actualPath === "claude") {
              try {
                const { execFileSync } = await import("node:child_process");
                actualPath = (process.platform === "win32"
                  ? execFileSync("where", [actualPath], { timeout: 5000, encoding: "utf-8" }).trim().split("\n")[0]
                  : execFileSync("which", [actualPath], { timeout: 5000, encoding: "utf-8" }).trim()) || actualPath;
              } catch {
                // where/which failed, keep using the command name
              }
            }
          }
          const { execFileSync } = await import("node:child_process");
          const ver = execFileSync(actualPath || bin, ["--version"], { timeout: 10000, encoding: "utf-8" }).trim();
          const model = isMimo ? (cfg.MIMO_MODEL || "") : (cfg.CLAUDE_MODEL || "");
          return json(200, { ok: true, provider: isMimo ? "mimo" : "claude", version: ver, path: actualPath || bin, model });
        } catch (err: any) {
          return json(200, { ok: false, error: `AI CLI 未安装: ${err.message?.slice(0, 100) || "未知错误"}` });
        }
      }

      // --- CC Status (check claude CLI) ---
      if (url === "/api/cc-status") {
        try {
          const { execFileSync } = await import("node:child_process");
          const configuredPath = readEnvConfig().CLAUDE_PATH || "";
          const bin = configuredPath || "claude";
          const ver = execFileSync(bin, ["--version"], { timeout: 5000, encoding: "utf-8" }).trim();
          const actualPath = configuredPath || (process.platform === "win32"
            ? execFileSync("where", [bin], { timeout: 3000, encoding: "utf-8" }).trim().split("\n")[0]
            : execFileSync("which", [bin], { timeout: 3000, encoding: "utf-8" }).trim());
          return json(200, { ok: true, version: ver, path: actualPath || bin });
        } catch {
          return json(200, { ok: false, error: "Claude Code CLI 未安装" });
        }
      }

      // --- CC Config (read Claude Code settings) ---
      if (url === "/api/cc-config") {
        return json(200, readCCSettings());
      }

      // --- Env Config ---
      if (url === "/api/config" && req.method === "GET") {
        return json(200, readEnvConfig());
      }
      if (url === "/api/config" && req.method === "POST") {
        const body = await readBody(req);
        const updated = JSON.parse(body) as Record<string, string>;
        updateEnvConfig(updated);
        return json(200, { ok: true, message: "配置已更新，需要重启生效" });
      }

      // --- Serve HTML ---
      if (url === "/" || url === "/manage.html") {
        const html = fs.readFileSync(HTML_FILE, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // --- 404 ---
      res.writeHead(404);
      res.end("Not Found");
    } catch (err) {
      addLog(`HTTP 错误: ${(err as Error).message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  return server;
}

// ===========================================================================
// Main entry
// ===========================================================================

const args = process.argv.slice(2);
const loginOnly = args.includes("--login-only") || args.includes("-l");
const forceLogin = args.includes("--force-login") || args.includes("-f");

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════╗");
  console.log("║   WeChat AI Bridge v1.1   ║");
  console.log("╚══════════════════════════════════╝");
  console.log("");

  checkMachineFingerprint();

  // Login if needed
  if (!hasAuth() || forceLogin) {
    if (!hasAuth()) {
      addLog("🔑 未检测到登录信息，开始扫码登录...");
    } else {
      addLog("🔑 强制重新登录（--force-login）...");
    }

    const result = await loginWithQR(ILINK_BASE_URL);

    if (!result.success) {
      console.error(`\n❌ 登录失败: ${result.message}`);
      process.exit(1);
    }

    if (result.message === "已连接过此 Bot，无需重复连接。") {
      if (!hasAuth()) {
        console.error("❌ 登录状态异常：显示已连接但未找到本地凭证，请重试。");
        process.exit(1);
      }
    }

    addLog("✅ 登录完成");
  }

  // If login-only, exit
  if (loginOnly) {
    console.log("✅ 登录完成。运行 `npm start` 启动桥接。");
    process.exit(0);
  }

  // Start HTTP server
  const server = createHttpServer();
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(PORT, () => {
      console.log(`\n⚡ 管理页面: http://localhost:${PORT}\n`);
      resolve();
    });
  });

  addLog("管理服务已启动");
  sendOwnerNotification("⚡ 管理端已启动");

  // Auto-start bridge if credentials exist
  if (hasAuth()) {
    internalStart();
  } else {
    addLog("⚠️ 未登录，请在终端运行 npm start 扫码登录");
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n🛑 正在关闭...");
    if (bridgeState === "running") {
      monitorAbortController?.abort();
      sendOwnerNotification("🛑 桥接已关闭");
    }
    sendOwnerNotification("🔌 管理端已关闭");
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Global crash guards
  process.on("uncaughtException", (err) => {
    addLog(`[FATAL] 未捕获异常: ${err.message}\n${err.stack?.slice(0, 500)}`);
    console.error("FATAL:", err.message);
  });
  process.on("unhandledRejection", (reason) => {
    addLog(`[FATAL] 未处理的 Promise 拒绝: ${String(reason)}`);
    console.error("FATAL:", String(reason));
  });
}

main().catch((err) => {
  console.error(`❌ 未捕获的错误: ${String(err)}`);
  process.exit(1);
});
