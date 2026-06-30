/**
 * Autostart management — cross-platform with path-staleness detection.
 *
 * - Windows: Startup folder .bat (inline Node version check)
 * - macOS:   LaunchAgent .plist → delegates to helper script
 * - Linux:   XDG autostart .desktop → delegates to helper script
 *
 * Helper script + state/.autostart marker are written alongside the system
 * entry so isAutostartEnabled() can detect project-directory relocation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MARKER_BASENAME = ".autostart";
const HELPER_BASENAME = "autostart-helper.sh";
const HELPER_LOG = "autostart.log";

function stateMarkerPath(projectDir: string): string {
  return path.join(projectDir, "state", MARKER_BASENAME);
}

function helperScriptPath(projectDir: string): string {
  return path.join(projectDir, "state", HELPER_BASENAME);
}

function logPath(projectDir: string): string {
  return path.join(projectDir, "state", HELPER_LOG);
}

// ---------------------------------------------------------------------------
// Public: get OS-specific system autostart file path
// ---------------------------------------------------------------------------

export function getAutostartPath(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "LaunchAgents", "com.wechat-ai-bridge.plist");
  }
  if (process.platform === "linux") {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    return path.join(configHome, "autostart", "wechat-ai-bridge.desktop");
  }
  // Windows
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "wechat-ai-bridge.bat");
}

// ---------------------------------------------------------------------------
// Public: check whether autostart is genuinely enabled
// ---------------------------------------------------------------------------

export function isAutostartEnabled(projectDir: string): boolean {
  const sysPath = getAutostartPath();
  if (!fs.existsSync(sysPath)) return false;

  // Check state marker for path staleness
  const markerPath = stateMarkerPath(projectDir);
  if (!fs.existsSync(markerPath)) return false;

  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    if (marker.projectDir !== projectDir) return false;
  } catch {
    return false;
  }

  // On Unix the helper script must also exist
  if (process.platform === "darwin" || process.platform === "linux") {
    if (!fs.existsSync(helperScriptPath(projectDir))) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Public: enable / disable autostart
// ---------------------------------------------------------------------------

export function setAutostart(enabled: boolean, projectDir: string): { ok: boolean; message: string } {
  const sysPath = getAutostartPath();
  const markerPath = stateMarkerPath(projectDir);
  const helperPath = helperScriptPath(projectDir);
  const logFile = logPath(projectDir);

  if (enabled) {
    try {
      fs.mkdirSync(path.dirname(sysPath), { recursive: true });

      if (process.platform === "win32") {
        fs.writeFileSync(sysPath, batContent(projectDir, logFile), "utf-8");
      } else if (process.platform === "darwin") {
        fs.writeFileSync(helperPath, helperScriptContent(projectDir), { mode: 0o755, encoding: "utf-8" });
        fs.writeFileSync(sysPath, plistContent(projectDir, helperPath, logFile), "utf-8");
      } else if (process.platform === "linux") {
        fs.writeFileSync(helperPath, helperScriptContent(projectDir), { mode: 0o755, encoding: "utf-8" });
        fs.writeFileSync(sysPath, desktopContent(projectDir, helperPath), "utf-8");
      } else {
        return { ok: false, message: `不支持的操作系统: ${process.platform}` };
      }

      // Write state marker last (atomic from caller's perspective)
      fs.writeFileSync(markerPath, JSON.stringify({
        projectDir,
        platform: process.platform,
        ts: new Date().toISOString(),
      }), "utf-8");

      return { ok: true, message: "已设置开机自启" };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  } else {
    try {
      for (const f of [sysPath, markerPath, helperPath]) {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
      }
      return { ok: true, message: "已取消开机自启" };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: platform-specific content generators
// ---------------------------------------------------------------------------

function batContent(projectDir: string, _logFile: string): string {
  // Visible error popups on failure; uses start /d to avoid nested-quote issues.
  const alertTitle = "WeChat AI Bridge 启动失败";
  // VBScript inside batch: "" → literal " inside the Execute string
  const vbTitle = `""${alertTitle}""`;
  const lines = [
    `@echo off`,
    `setlocal enabledelayedexpansion`,
    ``,
    `REM Check Node.js installed`,
    `where node >nul 2>nul`,
    `if %errorlevel% neq 0 (`,
    `  mshta vbscript:Execute("MsgBox ""未找到 Node.js，请安装 Node.js >= 22"" ,48,${vbTitle})(window.close)`,
    `  exit /b 1`,
    `)`,
    ``,
    `REM Check Node.js >= 22`,
    `for /f "tokens=1 delims=v." %%i in ('node -v 2^>nul') do set NODE_MAJOR=%%i`,
    `if not defined NODE_MAJOR (`,
    `  mshta vbscript:Execute("MsgBox ""无法检测 Node.js 版本"" ,48,${vbTitle})(window.close)`,
    `  exit /b 1`,
    `)`,
    `if !NODE_MAJOR! LSS 22 (`,
    `  for /f "delims=" %%v in ('node -v 2^>nul') do set NODE_FULL=%%v`,
    `  mshta vbscript:Execute("MsgBox ""需要 Node.js >= 22，当前: !NODE_FULL!"" ,48,${vbTitle})(window.close)`,
    `  exit /b 1`,
    `)`,
    ``,
    `REM Launch bridge minimized (use /d to set cwd, relative paths inside)`,
    `start /min "" /d "${projectDir}" cmd /c node_modules\\.bin\\tsx.cmd src\\index.ts`,
    `exit /b 0`,
  ];
  return lines.join("\r\n") + "\r\n";
}

function helperScriptContent(projectDir: string): string {
  // Bash helper shared by macOS launchd and Linux XDG autostart.
  // Shows visible error dialogs on failure — no log-diving needed.
  return [
    `#!/bin/bash`,
    `# Auto-generated by WeChat AI Bridge — do not edit manually`,
    `PROJECT_DIR="${projectDir}"`,
    `TITLE="WeChat AI Bridge 启动失败"`,
    ``,
    `die() {`,
    `  if command -v osascript >/dev/null 2>&1; then`,
    `    osascript -e "display dialog \"$1\" with title \"$TITLE\" buttons {\"确定\"} default button 1 with icon stop"`,
    `  elif command -v zenity >/dev/null 2>&1; then`,
    `    zenity --error --title="$TITLE" --text="$1" 2>/dev/null`,
    `  elif command -v notify-send >/dev/null 2>&1; then`,
    `    notify-send -u critical "$TITLE" "$1"`,
    `  fi`,
    `  echo "[autostart $(date)] $1" >> "$PROJECT_DIR/state/autostart.log" 2>/dev/null`,
    `  exit 1`,
    `}`,
    ``,
    `NODE_VER=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)`,
    `if [ -z "$NODE_VER" ]; then`,
    `  die "未找到 Node.js，请安装 Node.js >= 22"`,
    `fi`,
    `if [ "$NODE_VER" -lt 22 ]; then`,
    `  die "需要 Node.js >= 22，当前: $(node -v 2>/dev/null || echo 'unknown')"`,
    `fi`,
    ``,
    `cd "$PROJECT_DIR" || die "无法进入目录 $PROJECT_DIR"`,
    `exec "./node_modules/.bin/tsx" "./src/index.ts"`,
    ``,
  ].join("\n");
}

function plistContent(projectDir: string, helperPath: string, logFile: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
	<key>Label</key><string>com.wechat-ai-bridge</string>
	<key>ProgramArguments</key><array>
		<string>/bin/bash</string>
		<string>${helperPath}</string>
	</array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><false/>
	<key>WorkingDirectory</key><string>${projectDir}</string>
	<key>StandardOutPath</key><string>${logFile}</string>
	<key>StandardErrorPath</key><string>${logFile}</string>
</dict></plist>`;
}

function desktopContent(projectDir: string, helperPath: string): string {
  return [
    `[Desktop Entry]`,
    `Type=Application`,
    `Name=WeChat AI Bridge`,
    `Comment=WeChat AI Bridge Autostart`,
    `Exec=/bin/bash "${helperPath}"`,
    `Path=${projectDir}`,
    `Terminal=false`,
    `X-GNOME-Autostart-enabled=true`,
    ``,
  ].join("\n");
}
