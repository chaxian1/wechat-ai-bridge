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
echo Log: state/bridge.log

# Start server with auto-restart on exit code 42
while true; do
    ./node_modules/.bin/tsx src/index.ts
    EXIT_CODE=$?
    if [ $EXIT_CODE -ne 42 ]; then
        break
    fi
    echo "Restarting to load new code..."
    sleep 2
done
