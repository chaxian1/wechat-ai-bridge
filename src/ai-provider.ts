/**
 * Unified AI provider interface: Claude Code and MiMoCode.
 */
import { getAIProvider as getAIProviderEnv } from "./config.ts";
import type { PermissionRequest, PermissionDecision } from "./claude/client.ts";

// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

export interface AIProviderOptions {
  prompt: string;
  cwd?: string;
  sessionId?: string;
  systemPrompt?: string;
  model?: string;
  effort?: string;
  abortSignal?: AbortSignal;
  /** callback: provider calls this with a kill function when the child process is ready */
  onKillReady?: (kill: () => void) => void;
  /** image file paths (Mimo uses -f; Claude ignores) */
  imagePaths?: string[];
  /** Called when AI requests permission for a tool. Resolve with allow/deny. */
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionDecision>;
}

export interface AIProviderEvents {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
  onDone?: (fullText: string, sessionId: string) => void;
  onError?: (err: Error) => void;
}

export interface AIProviderResult {
  text: string;
  sessionId: string;
  toolCalls: number;
  aborted: boolean;
}

export type AIProvider = "claude" | "mimo";

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

export function getAIProvider(): AIProvider {
  const raw = getAIProviderEnv();
  if (raw === "mimo" || raw === "mimocode") return "mimo";
  return "claude";
}

export async function getAISystemPrompt(): Promise<string> {
  if (getAIProvider() === "mimo") {
    const { buildMimoSystemPrompt } = await import("./mimocode/client.ts");
    return buildMimoSystemPrompt();
  }
  const { buildSystemPrompt } = await import("./claude/client.ts");
  return buildSystemPrompt();
}

// ---------------------------------------------------------------------------
// Unified entry points
// ---------------------------------------------------------------------------

export async function streamAI(
  opts: AIProviderOptions,
  events: AIProviderEvents,
): Promise<AIProviderResult> {
  if (getAIProvider() === "mimo") {
    const { streamMimoCode } = await import("./mimocode/client.ts");
    return streamMimoCode(opts, events);
  }
  const { streamClaudeCode } = await import("./claude/client.ts");
  return streamClaudeCode(opts, events);
}

export async function compactSession(
  sessionId: string,
  cwd?: string,
  model?: string,
): Promise<boolean> {
  if (getAIProvider() === "mimo") {
    const { compactMimoSession } = await import("./mimocode/client.ts");
    return compactMimoSession(sessionId, cwd, model);
  }
  const { compactClaudeSession } = await import("./claude/client.ts");
  return compactClaudeSession(sessionId, cwd, model);
}
