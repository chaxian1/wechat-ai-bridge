/**
 * Atomic JSON store with file-based locking.
 *
 * Features:
 * - Atomic writes: write to temp file then rename (never exposes partial JSON)
 * - File-based locking: mkdir as atomic lock primitive (cross-platform)
 * - Stale lock detection: 30s TTL, auto-cleanup
 * - Retry on race conditions: brief retry window for concurrent reads
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, statSync, readdirSync, rmdirSync } from "node:fs";
import { join, dirname } from "node:path";

const LOCK_TTL_MS = 30_000; // 30 seconds
const RETRY_DELAYS = [5, 15]; // ms

/**
 * Acquire a file-based lock using mkdir (atomic on all OS).
 * Returns a release function.
 */
export function acquireLock(lockPath: string): () => void {
  const start = Date.now();

  while (true) {
    try {
      mkdirSync(lockPath, { recursive: true });
      // Lock acquired
      return () => {
        try {
          const stat = statSync(lockPath);
          if (stat.mtimeMs >= start - 1000) {
            try {
              const files = readdirSync(lockPath);
              if (files.length === 0) {
                rmdirSync(lockPath);
              }
            } catch {
              // Best-effort cleanup
            }
          }
        } catch {
          // Already removed or never existed
        }
      };
    } catch (err: any) {
      if (err.code !== "EEXIST") {
        throw err;
      }

      // Lock exists — check for stale lock
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_TTL_MS) {
          // Stale lock — force remove and retry
          try {
            const files = readdirSync(lockPath);
            if (files.length === 0) {
              rmdirSync(lockPath);
            }
          } catch {
            // Ignore cleanup errors
          }
          continue;
        }
      } catch {
        // Lock dir disappeared between EEXIST check and stat — retry
        continue;
      }

      // Lock is valid and recent — wait and retry
      const elapsed = Date.now() - start;
      if (elapsed > 5000) {
        throw new Error(`Failed to acquire lock after ${elapsed}ms: ${lockPath}`);
      }

      // Busy wait
      const end = Date.now() + 10;
      while (Date.now() < end) {
        // spin
      }
    }
  }
}

/**
 * Load JSON from file with retry for race conditions.
 */
export function loadJson<T>(filePath: string): T | null {
  for (const delay of [0, ...RETRY_DELAYS]) {
    try {
      if (delay > 0) {
        const end = Date.now() + delay;
        while (Date.now() < end) {
          // spin
        }
      }
      const raw = readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as T;
    } catch (err: any) {
      if (err.code === "ENOENT") return null;
      if (delay === RETRY_DELAYS[RETRY_DELAYS.length - 1]) {
        throw err;
      }
      // Retry on next delay
    }
  }
  return null;
}

/**
 * Save JSON atomically: write to temp file then rename.
 */
export function saveJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = join(dir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Cleanup temp file on failure
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore
    }
    throw err;
  }
}

/**
 * Load-transform-save with file lock for safe concurrent access.
 */
export function updateJson<T>(
  filePath: string,
  transformer: (current: T | null) => T,
): T {
  const lockPath = `${filePath}.lock`;
  const release = acquireLock(lockPath);

  try {
    const current = loadJson<T>(filePath);
    const updated = transformer(current);
    saveJson(filePath, updated);
    return updated;
  } finally {
    release();
  }
}

/**
 * Convenience: load JSON, create if missing.
 */
export function loadOrCreate<T>(filePath: string, defaultValue: T): T {
  const existing = loadJson<T>(filePath);
  if (existing !== null) return existing;
  saveJson(filePath, defaultValue);
  return defaultValue;
}
