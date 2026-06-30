/**
 * Claude Code CLI integration.
 *
 * Spawns the local `claude` binary with --output-format stream-json and parses
 * NDJSON events in real time.  No Anthropic API key needed — the CLI uses its
 * own credentials.
 *
 * Ported from wechat-claude-code (MIT) — the NDJSON protocol is the same one
 * used by `claude --output-format stream-json --include-partial-messages`.
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getClaudePath } from "../config.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Claude CLI binary discovery
// ---------------------------------------------------------------------------

/**
 * Find the `claude` CLI binary.
 *
 * Priority:
 *   1. CLAUDE_PATH from .env (manual override)
 *   2. Common install locations (Windows / macOS / Linux)
 *   3. Fallback to "claude" (rely on PATH)
 */
export function findClaudeBin(): string {
  if (_claudeBinCache) return _claudeBinCache;

  // 1. Manual override from .env
  const claudePath = getClaudePath();
  if (claudePath) {
    if (fs.existsSync(claudePath)) { _claudeBinCache = claudePath; return claudePath; }
    console.warn(`⚠️ CLAUDE_PATH 指向的路径不存在: ${claudePath}, 尝试自动查找...`);
  }

  const isWin = process.platform === "win32";

  // 2. Common install locations
  //    On Windows, check both .cmd and .exe in each directory
  const winDirs = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "ClaudeCode"),  // MSI user-level
    path.join(process.env.APPDATA || "", "npm"),                           // npm global
    "C:\\ClaudeCode",                                                      // MSI system-level
    path.join(os.homedir(), ".local", "bin"),                              // standalone / pip
    path.join(os.homedir(), "AppData", "Local", "ClaudeCode"),             // alternate MSI
  ];

  const candidates = isWin
    ? winDirs.flatMap((dir) => [path.join(dir, "claude.exe"), path.join(dir, "claude.cmd")])
    : [
        // macOS Homebrew
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        // Linux / macOS npm global
        path.join(os.homedir(), ".npm-global", "bin", "claude"),
        // pip / standalone
        path.join(os.homedir(), ".local", "bin", "claude"),
        // npm global (nvm / fnm) — scan node versions
        ...(() => {
          const nvmDir = path.join(os.homedir(), ".nvm", "versions", "node");
          try {
            return fs.readdirSync(nvmDir)
              .filter(d => d.startsWith("v"))
              .map(d => path.join(nvmDir, d, "bin", "claude"));
          } catch { return []; }
        })(),
        // cargo / other
        path.join(os.homedir(), ".cargo", "bin", "claude"),
      ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      console.log(`🔍 自动找到 Claude CLI: ${candidate}`);
      _claudeBinCache = candidate;
      return candidate;
    }
  }

  // 3. Fallback — hope it's in PATH
  console.log("🔍 未在常见路径找到 Claude CLI，使用 PATH 中的 claude");
  _claudeBinCache = "claude";
  return "claude";
}

let _claudeBinCache: string | null = null;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

export type PermissionDecision = "allow" | "deny";

export interface ClaudeCodeOptions {
  /** User prompt (plain text, already assembled with context). */
  prompt: string;
  /** Working directory for claude CLI. */
  cwd?: string;
  /** Resume a previous session. */
  sessionId?: string;
  /** Additional system prompt appended via --append-system-prompt. */
  systemPrompt?: string;
  /** Model override (passed as --model). */
  model?: string;
  /** Effort level override (passed as --effort). */
  effort?: string;
  /** Abort signal to kill the running CLI process. */
  abortSignal?: AbortSignal;
  /** Callback: monitor sets this to receive a kill function for external abort. */
  onKillReady?: (kill: () => void) => void;
  /** Called when Claude requests permission for a tool. Resolve with allow/deny. */
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionDecision>;
}

export interface ClaudeCodeEvents {
  /** A text delta (streaming). */
  onText?: (delta: string) => void;
  /** Extended-thinking delta. */
  onThinking?: (delta: string) => void;
  /** A tool_use block was detected (name + JSON input). */
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
  /** Stream ended successfully. */
  onDone?: (fullText: string, sessionId: string) => void;
  /** Stream ended with an error. */
  onError?: (err: Error) => void;
}

export interface ClaudeCodeResult {
  text: string;
  sessionId: string;
  toolCalls: number;
  aborted: boolean;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildSystemPrompt(): string {
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
    `  curl -X POST http://localhost:${process.env.PORT || "3456"}/api/restart`,
    "重启不会中断对话，桥接在后台重启。",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Core: spawn + NDJSON stream
// ---------------------------------------------------------------------------

/**
 * Spawn `claude` CLI, write prompt to stdin, parse NDJSON stream from stdout.
 *
 * NDJSON event reference:
 *   {"type":"system","subtype":"init","session_id":"..."}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}, ...]}}
 *   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
 *   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"..."}}}
 *   {"type":"result","subtype":"success","result":"...","session_id":"..."}
 */
export async function streamClaudeCode(
  opts: ClaudeCodeOptions,
  events: ClaudeCodeEvents,
): Promise<ClaudeCodeResult> {
  const useStdioPrompt = !!opts.onPermissionRequest;

  const args = [
    "-p", opts.prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];

  if (useStdioPrompt) {
    args.push("--permission-prompt-tool", "stdio");
  } else {
    args.push("--dangerously-skip-permissions");
  }

  if (opts.sessionId) {
    args.push("--resume", opts.sessionId);
  }
  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.effort) {
    args.push("--effort", opts.effort);
  }
  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }

  const cwd = opts.cwd || PROJECT_ROOT;
  let claudeBin = findClaudeBin();

  // If we got a .cmd wrapper, prefer the .exe in the same directory
  if (process.platform === "win32" && claudeBin.toLowerCase().endsWith(".cmd")) {
    const exePath = claudeBin.replace(/\.cmd$/i, ".exe");
    if (fs.existsSync(exePath)) {
      claudeBin = exePath;
    }
    // If .exe doesn't exist, spawn the .cmd as-is — it'll work if Node can handle it
  }

  // When using stdio prompt, keep stdin open for permission responses
  const child = spawn(claudeBin, args, {
    cwd,
    stdio: [useStdioPrompt ? "pipe" : "ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  // Prevent crash when claude CLI not installed or cwd invalid
  let spawnError: Error | null = null;
  child.on("error", (err) => {
    spawnError = err;
    events.onError?.(new Error(`Claude Code 未安装或启动失败: ${err.message}`));
  });

  // Build a kill function that forcibly stops the Claude CLI process
  const killProcess = () => {
    try {
      console.error(`[kill] killing Claude pid=${child.pid}`);
      if (process.platform === "win32" && child.pid) {
        try {
          execSync(`taskkill /F /T /PID ${child.pid}`, { timeout: 5000, stdio: "pipe" });
          console.error(`[kill] taskkill OK pid=${child.pid}`);
        } catch (e: any) {
          console.error(`[kill] taskkill failed: ${e.message}, fallback .kill()`);
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    } catch (e: any) { console.error(`[kill] error: ${e.message}`); }
  };

  // Expose kill function to caller for external abort
  opts.onKillReady?.(killProcess);

  // Also register via AbortSignal for standard abort flow
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", killProcess, { once: true });
  }

  const result: ClaudeCodeResult = { text: "", sessionId: "", toolCalls: 0, aborted: false };

  // Accumulate text from stream events and build final from assistant messages
  let sessionId = "";
  const textParts: string[] = [];

  // Permission request queue: requestId → resolve function
  const pendingPermissions = new Map<string, (decision: PermissionDecision) => void>();

  const stdoutDone = new Promise<void>((resolve, reject) => {
    let buf = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || ""; // keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);

          // Handle control_request for permission
          if (evt.type === "control_request" && evt.subtype === "permission" && opts.onPermissionRequest) {
            const req: PermissionRequest = {
              requestId: evt.requestId,
              toolName: evt.tool_name || "unknown",
              toolInput: evt.tool_input || {},
            };
            // Forward to callback and handle response
            opts.onPermissionRequest(req).then((decision) => {
              const response = { type: "control_response", requestId: evt.requestId, decision };
              child.stdin!.write(JSON.stringify(response) + "\n");
            }).catch(() => {
              // On error, deny by default
              const response = { type: "control_response", requestId: evt.requestId, decision: "deny" };
              child.stdin!.write(JSON.stringify(response) + "\n");
            });
            continue;
          }

          processEvent(evt, events, result, textParts);
          // Capture session_id from init
          if (evt.type === "system" && evt.subtype === "init" && evt.session_id) {
            sessionId = evt.session_id;
          }
          // Capture final session_id from result
          if (evt.type === "result" && evt.session_id) {
            sessionId = evt.session_id;
          }
        } catch {
          // Skip unparseable lines (e.g., non-JSON stderr mixed in)
        }
      }
    });

    child.stdout!.on("end", resolve);
    child.stdout!.on("error", reject);
  });

  // Collect stderr for debugging
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stderr!.on("error", () => { /* ignore pipe errors */ });

  try {
    await stdoutDone;

    // Wait for process exit
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
    });

    if (exitCode !== 0 && exitCode !== null && !opts.abortSignal?.aborted) {
      // Stale session? Retry once without --resume
      if (opts.sessionId && (stderr.includes("No conversation found") || stderr.includes("session ID"))) {
        events.onError?.(new Error("会话过期，重新开始..."));
        return streamClaudeCode({ ...opts, sessionId: undefined, systemPrompt: opts.systemPrompt }, events);
      }
      const errMsg = stderr.slice(-500) || `exit code ${exitCode}`;
      events.onError?.(new Error(errMsg));
      result.text = textParts.join("") || `Claude Code exited with code ${exitCode}`;
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
// NDJSON event processor (mutates textParts + result in place)
// ---------------------------------------------------------------------------

function processEvent(
  evt: Record<string, any>,
  events: ClaudeCodeEvents,
  result: ClaudeCodeResult,
  textParts: string[],
): void {
  // --- stream_event: content_block_delta ---
  if (evt.type === "stream_event" && evt.event?.type === "content_block_delta") {
    const delta = evt.event.delta;
    if (!delta) return;

    // text_delta
    if (delta.type === "text_delta" && delta.text) {
      textParts.push(delta.text);
      events.onText?.(delta.text);
    }

    // thinking_delta
    if (delta.type === "thinking_delta" && delta.thinking) {
      events.onThinking?.(delta.thinking);
    }

    // input_json_delta for tool_use
    // (tool_use detections are better handled via full assistant message parsing)
    return;
  }

  // --- assistant message (full content blocks) ---
  if (evt.type === "assistant" && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === "tool_use") {
        result.toolCalls++;
        const input = typeof block.input === "string"
          ? safeJsonParse(block.input) || { raw: block.input }
          : (block.input || {});
        events.onToolUse?.(block.name || "unknown", input);
      }
    }
    return;
  }

  // --- result: success ---
  if (evt.type === "result" && evt.subtype === "success") {
    if (evt.result && !textParts.length) {
      // Fallback: if no stream events were captured, use the result text
      textParts.push(evt.result);
    }
    return;
  }
}

function safeJsonParse(s: string): Record<string, unknown> | null {
  try { return JSON.parse(s); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Compact session (used by /compact command)
// ---------------------------------------------------------------------------

/** Send /compact directive to Claude CLI via stdin and wait for completion. */
export async function compactClaudeSession(
  sessionId: string,
  cwd?: string,
  model?: string,
): Promise<boolean> {
  const bin = findClaudeBin();
  const args = [
    "--resume", sessionId,
    "--dangerously-skip-permissions",
  ];
  if (model) args.push("--model", model);

  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: cwd || PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
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
