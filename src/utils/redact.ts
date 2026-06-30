/**
 * Log redaction: strip sensitive information before writing to logs.
 *
 * Patterns redacted:
 * - Bearer tokens
 * - API keys (generic)
 * - Passwords
 * - AES keys
 * - Authorization headers
 *
 * Ported from wechat-claude-code-enhanced (MIT).
 */

// Sensitive patterns to redact
const REDACT_PATTERNS: Array<{ pattern: RegExp; replacement: string | ((match: string) => string) }> = [
  // Bearer tokens
  { pattern: /Bearer\s+[A-Za-z0-9._\-]+/gi, replacement: "Bearer ***REDACTED***" },
  // Generic API keys (long hex/base64 strings)
  { pattern: /(?:api[_-]?key|apikey|secret[_-]?key|token)\s*[=:]\s*["']?[A-Za-z0-9._\-]{20,}["']?/gi, replacement: (match: string) => {
    const eqIdx = match.search(/[=:]/);
    return match.slice(0, eqIdx + 1) + " ***REDACTED***";
  }},
  // AES keys (hex strings)
  { pattern: /AES[_-]?(?:KEY|key)\s*[=:]\s*["']?[A-Fa-f0-9]{32,}["']?/gi, replacement: "AES_KEY=***REDACTED***" },
  // Authorization headers
  { pattern: /Authorization\s*[=:]\s*["']?[^\s"']+/gi, replacement: "Authorization: ***REDACTED***" },
  // Passwords in URLs (user:pass@host)
  { pattern: /:\/\/[^:]+:[^@]+@/g, replacement: "://***:***@" },
  // Long hex strings that look like tokens (32+ chars)
  { pattern: /\b[A-Fa-f0-9]{32,}\b/g, replacement: "***HEX_REDACTED***" },
];

/**
 * Redact sensitive information from a string.
 */
export function redact(s: string): string {
  let result = s;
  for (const { pattern, replacement } of REDACT_PATTERNS) {
    if (typeof replacement === "function") {
      result = result.replace(pattern, replacement);
    } else {
      result = result.replace(pattern, replacement);
    }
  }
  return result;
}

/**
 * Redact an object's string values (recursive).
 */
export function redactObject<T>(obj: T): T {
  if (typeof obj === "string") {
    return redact(obj) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(redactObject) as T;
  }
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = redactObject(value);
    }
    return result as T;
  }
  return obj;
}
