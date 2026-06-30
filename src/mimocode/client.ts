/**
 * MiMoCode CLI integration.
 *
 * Spawns the local `mimo` binary with --format json and parses
 * NDJSON events in real time. No API key needed — the CLI uses its own credentials.
 *
 * API-compatible with Claude Code's streamClaudeCode.
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { getMimoPath, getClaudePath, WORKSPACE_DIR } from "../config.ts";
import type { AIProviderOptions, AIProviderEvents, AIProviderResult } from "../ai-provider.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Binary discovery
// ---------------------------------------------------------------------------

let _mimoBinCache: string | null = null;

export function findMimoBin(): string {
  if (_mimoBinCache) return _mimoBinCache;

  const mimoPath = getMimoPath();
  if (mimoPath) {
    if (fs.existsSync(mimoPath)) { _mimoBinCache = mimoPath; return mimoPath; }
    console.warn(`⚠️ MIMO_PATH 指向的路径不存在: ${mimoPath}, 尝试自动查找...`);
  }

  const isWin = process.platform === "win32";

  // Also search Claude's directory (user may put mimo.exe next to claude.exe)
  const claudePath = getClaudePath();
  const claudeDir = claudePath ? path.dirname(claudePath) : "";
  const claudeCommonDirs = isWin
    ? ["C:\\ClaudeCode", path.join(process.env.LOCALAPPDATA || "", "Programs", "ClaudeCode")]
    : ["/opt/homebrew/bin", "/usr/local/bin"];

  const winDirs = [
    claudeDir,
    ...claudeCommonDirs,
    path.join(process.env.LOCALAPPDATA || "", "Programs", "MiMoCode"),
    path.join(process.env.APPDATA || "", "npm"),
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), "AppData", "Local", "MiMoCode"),
  ].filter(d => d && d !== "");

  const candidates = isWin
    ? winDirs.flatMap((dir) => [path.join(dir, "mimo.exe"), path.join(dir, "mimo.cmd")])
    : [
        "/opt/homebrew/bin/mimo",
        "/usr/local/bin/mimo",
        path.join(os.homedir(), ".npm-global", "bin", "mimo"),
        path.join(os.homedir(), ".local", "bin", "mimo"),
      ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      console.log(`🔍 自动找到 MiMoCode CLI: ${candidate}`);
      _mimoBinCache = candidate;
      return candidate;
    }
  }

  console.log("🔍 未在常见路径找到 MiMoCode CLI，使用 PATH 中的 mimo");
  _mimoBinCache = "mimo";
  return "mimo";
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildMimoSystemPrompt(): string {
  const isWin = process.platform === "win32";

  return [
    "你正在通过微信与用户对话，不是在终端里。",
    "不要在回复中让用户去终端操作。",
    "回复使用中文，简洁清晰。",
    "",
    "--- 发送文件给用户 ---",
    "当用户要求发送文件/图片/视频时，用以下格式标记，系统会自动发送：",
    "  图片:   [SEND_IMAGE:完整路径]",
    "  文件:   [SEND_FILE:完整路径]",
    "  视频:   [SEND_VIDEO:完整路径]",
    "示例：",
    "  [SEND_IMAGE:C:\\Users\\xxx\\Pictures\\wallpaper.png]",
    "  [SEND_FILE:C:\\Users\\xxx\\Documents\\report.pdf]",
    "也支持远程 URL（自动下载后发送）：",
    "  [SEND_IMAGE:https://example.com/photo.jpg]",
    "多个文件可以分别标记，也可以和其他文字混排。",
    ...(isWin
      ? [
          "",
          "⚠️ 用户运行在 Windows 上。使用 Bash 工具时必须用 Windows 兼容命令:",
          "  文件操作用 copy/move/rename/mkdir/rmdir，不要用 cp/mv/sed/grep",
          "  用 findstr 代替 grep，用 powershell 代替 awk",
          "  路径用反斜杠 \\\\ 或正斜杠 / 均可",
        ]
      : []),
    "",
    "--- 重要规则 ---",
    "除非用户明确要求你修改代码，否则不要擅自改动任何文件。",
    "你的主要职责是对话和回答问题，不是主动修改项目代码。",
    "如果用户说\"你好\"之类的简单问候，只需要打招呼回复，不要做任何工具调用。",
    "用户说\"不要擅自改动\"时，你应当确认理解，然后停手 — 不要执行 git checkout 等命令。",
    "",
    "--- 代码修改（仅在用户明确要求时）---",
    `你的代码路径: ${PROJECT_ROOT.replace(/\\/g, "/")}/src/`,
    "修改完代码后，执行此命令重启桥接:",
    `  curl -X POST http://localhost:3456/api/restart`,
    "重启不会中断对话，桥接在后台重启。",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Core: spawn + NDJSON stream (MiMoCode format)
// ---------------------------------------------------------------------------

export async function streamMimoCode(
  opts: AIProviderOptions,
  events: AIProviderEvents,
): Promise<AIProviderResult> {
  const bin = findMimoBin();
  const cwd = opts.cwd || PROJECT_ROOT;

  // MiMoCode doesn't support --permission-prompt-tool stdio
  // Always use --dangerously-skip-permissions for MiMoCode
  const args = [
    "run",
    "--format", "json",
    "--dangerously-skip-permissions",
    "--dir", cwd,
  ];

  // Only pass --session if the ID is a MiMoCode session (ses_xxx format).
  // Claude Code session IDs are UUIDs and would cause mimo to silently fail.
  if (opts.sessionId?.startsWith("ses_")) args.push("--session", opts.sessionId);
  if (opts.model) args.push("-m", opts.model);

  // Image paths: pass with -f flag
  for (const imgPath of opts.imagePaths || []) {
    args.push("-f", imgPath);
  }

  // System prompt prepended to user prompt — written to stdin, NOT as CLI arg
  let fullPrompt = opts.prompt;
  if (opts.systemPrompt) {
    fullPrompt = `${opts.systemPrompt}\n\n${opts.prompt}`;
  }

  const child = spawn(bin, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    shell: process.platform === "win32",
    windowsVerbatimArguments: false,
    windowsHide: true,
  });

  // MiMoCode CLI reads prompt from stdin — write it then close
  child.stdin!.write(fullPrompt);
  child.stdin!.end();

  let spawnError: Error | null = null;
  child.on("error", (err) => {
    spawnError = err;
    events.onError?.(new Error(`MiMoCode 未安装或启动失败: ${err.message}`));
  });

  // Build kill function
  const killProcess = () => {
    try {
      if (process.platform === "win32" && child.pid) {
        try {
          execSync(`taskkill /F /T /PID ${child.pid}`, { timeout: 5000, stdio: "pipe" });
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    } catch { /* ignore */ }
  };

  opts.onKillReady?.(killProcess);

  if (opts.abortSignal) {
    const onAbort = () => killProcess();
    opts.abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  const result: AIProviderResult = { text: "", sessionId: "", toolCalls: 0, aborted: false };
  let sessionId = "";
  const textParts: string[] = [];
  const stderrParts: string[] = [];

  const stdoutDone = new Promise<void>((resolve, reject) => {
    let buf = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let evt: Record<string, any>;
        try { evt = JSON.parse(line); } catch { continue; }

        if (evt.sessionID && !sessionId) sessionId = evt.sessionID;
        if (evt.type === "result" && evt.session_id) sessionId = evt.session_id;

        switch (evt.type) {
          case "text": {
            const text: string = evt.part?.text ?? evt.text ?? "";
            if (text) {
              textParts.push(text);
              events.onText?.(text);
            }
            break;
          }
          case "tool_use": {
            result.toolCalls++;
            const toolName = evt.part?.tool || evt.name || evt.tool_name || "unknown";
            const input = typeof evt.input === "string"
              ? safeJsonParse(evt.input) || { raw: evt.input }
              : (evt.input || evt.part?.state?.input || {});
            events.onToolUse?.(toolName, input);
            break;
          }
          case "error": {
            const errMsg = evt.error?.data?.message || evt.error?.message || evt.error?.name || "MiMo error";
            events.onError?.(new Error(String(errMsg)));
            break;
          }
          case "step_finish": {
            const reason = evt.part?.reason;
            if (reason === "error") {
              events.onError?.(new Error(evt.part?.error || "Step finished with error"));
            }
            break;
          }
          default:
            break;
        }
      }
    });

    child.stdout!.on("end", resolve);
    child.stdout!.on("error", reject);
  });

  child.stderr!.on("data", (chunk: Buffer) => {
    const s = chunk.toString();
    stderrParts.push(s);
    // Log MiMoCode stderr to bridge log for debugging
    console.error(`[mimo stderr] ${s.trim()}`);
  });

  // Race stdoutDone against spawn error — if binary not found, stdout never ends
  const spawnFailed = new Promise<never>((_, reject) => {
    const check = () => {
      if (spawnError) reject(spawnError);
      else setTimeout(check, 50);
    };
    check();
  });

  try {
    await Promise.race([stdoutDone, spawnFailed]);

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
    });

    if (exitCode !== 0 && exitCode !== null && !opts.abortSignal?.aborted) {
      const errMsg = stderrParts.join("").slice(-500) || `exit code ${exitCode}`;
      events.onError?.(new Error(errMsg));
      result.text = textParts.join("") || `MiMoCode exited with code ${exitCode}`;
    } else {
      result.text = textParts.join("");
      result.sessionId = sessionId;
      events.onDone?.(result.text, sessionId);
    }
  } catch (err) {
    if (opts.abortSignal?.aborted) {
      result.aborted = true;
      result.text = textParts.join("");
    } else {
      events.onError?.(err as Error);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Compact session
// ---------------------------------------------------------------------------

export async function compactMimoSession(
  sessionId: string,
  cwd?: string,
  model?: string,
): Promise<boolean> {
  const bin = findMimoBin();
  const args = [
    "run",
    "--format", "json",
    "--session", sessionId,
    "--dangerously-skip-permissions",
    "--dir", cwd || PROJECT_ROOT,
  ];
  if (model) args.push("-m", model);

  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: cwd || PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      windowsHide: true,
    });

    child.stdin!.write("/compact\n");
    child.stdin!.end();

    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve(false);
    }, 120_000);

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve(code === 0);
    });

    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function safeJsonParse(s: string): Record<string, unknown> | null {
  try { return JSON.parse(s); } catch { return null; }
}
