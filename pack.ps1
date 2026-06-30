$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

$version = "1.0.0"
$distDir = "$root\dist"
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
$outDir = "$root\wechat-ai-v$version"
$zipFile = "$distDir\wechat-ai-v$version.zip"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Pack WeChat AI Bridge v$version" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Cleanup (ignore locked files)
if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir -ErrorAction SilentlyContinue }
# If old cleanup left files, retry after brief wait
if (Test-Path $outDir) { Start-Sleep 1; Remove-Item -Recurse -Force $outDir -ErrorAction SilentlyContinue }
if (Test-Path $outDir) { Write-Host "  (warning: could not clean old build, continuing...)" -ForegroundColor Yellow }
if (Test-Path $zipFile) { Remove-Item -Force $zipFile -ErrorAction SilentlyContinue }

# Create structure
New-Item -ItemType Directory -Force -Path "$outDir\state" | Out-Null

# ---- [1/6] Core files ----
Write-Host "[1/6] Core files..." -ForegroundColor Yellow
Copy-Item "$root\manage.bat" $outDir
Copy-Item "$root\manage.html" $outDir
Copy-Item "$root\package.json" $outDir
Copy-Item "$root\tsconfig.json" $outDir
Copy-Item "$root\README.md" $outDir -ErrorAction SilentlyContinue
"v$version" | Out-File -FilePath "$outDir\VERSION" -Encoding UTF8 -NoNewline

# ---- [2/6] Mac/Linux startup script (LF line endings) ----
Write-Host "[2/6] manage.sh..." -ForegroundColor Yellow
$shContent = @'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
echo ====================================
echo   WeChat AI Bridge
echo ====================================
echo

# Check Node.js version
NODE_VER=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VER" ] || [ "$NODE_VER" -lt 22 ]; then
    echo "[ERROR] Node.js >= 22 required. Current: $(node -v 2>/dev/null || echo 'not found')"
    exit 1
fi

# Check if already running
if curl -s http://localhost:3456/api/status > /dev/null 2>&1; then
    echo Already running on http://localhost:3456
    open http://localhost:3456 2>/dev/null || xdg-open http://localhost:3456 2>/dev/null
    exit 0
fi

echo Starting server on http://localhost:3456 ...

# Start server in background (stdout visible for QR scan)
./node_modules/.bin/tsx src/index.ts &
SERVER_PID=$!

# Poll until ready (max 15s)
for i in $(seq 1 15); do
    sleep 1
    if curl -s http://localhost:3456/api/status > /dev/null 2>&1; then
        echo Server is ready!
        open http://localhost:3456 2>/dev/null || xdg-open http://localhost:3456 2>/dev/null
        echo
        echo Management page opened in your browser.
        echo Server running in background (PID: $SERVER_PID).
        echo To stop: curl -X POST http://localhost:3456/api/stop
        exit 0
    fi
done

echo "[WARN] Server not ready after 15s, check state/bridge.log"
exit 1
'@
[System.IO.File]::WriteAllText("$outDir\manage.sh", $shContent, [System.Text.UTF8Encoding]::new($false))

# ---- [3/6] Source ----
Write-Host "[3/6] Source..." -ForegroundColor Yellow
Copy-Item -Recurse "$root\src" $outDir -Force

# ---- [4/6] node_modules ----
Write-Host "[4/6] node_modules (full)..." -ForegroundColor Yellow
Copy-Item -Recurse "$root\node_modules" $outDir -Force

# Slim down: remove TypeScript locales (not needed at runtime, cause long-path errors)
Write-Host "       pruning (ts locales / @types / ts-node)..." -ForegroundColor DarkGray
$pruneDirs = @(
  "$outDir\node_modules\typescript\lib\cs",
  "$outDir\node_modules\typescript\lib\de",
  "$outDir\node_modules\typescript\lib\es",
  "$outDir\node_modules\typescript\lib\fr",
  "$outDir\node_modules\typescript\lib\it",
  "$outDir\node_modules\typescript\lib\ja",
  "$outDir\node_modules\typescript\lib\ko",
  "$outDir\node_modules\typescript\lib\pl",
  "$outDir\node_modules\typescript\lib\pt-br",
  "$outDir\node_modules\typescript\lib\ru",
  "$outDir\node_modules\typescript\lib\tr",
  "$outDir\node_modules\typescript\lib\zh-cn",
  "$outDir\node_modules\typescript\lib\zh-tw",
  "$outDir\node_modules\@types",
  "$outDir\node_modules\ts-node"
)
foreach ($d in $pruneDirs) {
  if (Test-Path $d) { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue }
}

# ---- [5/6] .env template ----
Write-Host "[5/6] .env template..." -ForegroundColor Yellow
@"
# AI provider: "claude" or "mimo"
# AI_PROVIDER=claude

# --- Claude Code config ---
# Claude Code binary path (optional - auto-detect common locations if empty)
#   Windows: C:\ClaudeCode\claude.cmd  or  %APPDATA%\npm\claude.cmd
#   Mac:     /opt/homebrew/bin/claude  or  /usr/local/bin/claude
#   Linux:   ~/.local/bin/claude
# CLAUDE_PATH=
# CLAUDE_MODEL=claude-sonnet-4-6-20250514

# --- MiMoCode config ---
# MiMoCode binary path (optional - auto-detect common locations if empty)
#   Windows: %LOCALAPPDATA%\Programs\MiMoCode\mimo.exe  or  %APPDATA%\npm\mimo.cmd
#   Mac:     /opt/homebrew/bin/mimo  or  /usr/local/bin/mimo
#   Linux:   ~/.local/bin/mimo
# MIMO_PATH=
# MIMO_MODEL=mimo/mimo-auto

# --- Workspace ---
# WORKSPACE_DIR=

# --- Webhook (optional) ---
# WEBHOOK_TOKEN=my-secret-token

# WeChat (do not change)
ILINK_BASE_URL=https://ilinkai.weixin.qq.com
CDN_BASE_URL=https://novac2c.cdn.weixin.qq.com/c2c
"@ | Out-File -FilePath "$outDir\.env" -Encoding UTF8

# ---- [6/6] README ----
Write-Host "[6/6] README..." -ForegroundColor Yellow
@"
# WeChat AI Bridge v$version
================================

Supports Claude Code and MiMoCode — messages delegated to your local AI CLI.

QUICK START:
  Windows: double-click manage.bat
  Mac/Linux: chmod +x manage.sh && ./manage.sh
  Browser: http://localhost:3456

REQUIREMENTS:
  Node.js >= 22
  Claude Code CLI (npm install -g @anthropic-ai/claude-code)
  or MiMoCode CLI (npm install -g @anthropic-ai/mimocode)

FEATURES:
  - Claude Code / MiMoCode in WeChat (streaming, tool calls)
  - /stop to interrupt, /clear to reset conversation
  - Multi-user with independent sessions
  - Web dashboard with stats, logs, user management
  - Persistent cross-message context (--resume)
  - Webhook for external push
  - Autostart (Windows/Mac/Linux)
  - Machine fingerprint detection (auto-cleans stale state)

No npm install needed - node_modules included.
No API key needed - uses your local CLI credentials.
"@ | Out-File -FilePath "$outDir\README.txt" -Encoding UTF8

# ---- Zip ----
Write-Host "Compressing..." -ForegroundColor Yellow
Compress-Archive -Path "$outDir\*" -DestinationPath $zipFile -Force

Remove-Item -Recurse -Force $outDir

$size = [math]::Round((Get-Item $zipFile).Length / 1MB, 1)
Write-Host ""
Write-Host "Done: $zipFile ($size MB)" -ForegroundColor Green
Write-Host "  Windows: unzip -> double-click manage.bat" -ForegroundColor Green
Write-Host "  Mac:     unzip -> chmod +x manage.sh && ./manage.sh" -ForegroundColor Green
Write-Host ""
