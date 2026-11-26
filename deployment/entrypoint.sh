#!/usr/bin/env bash
set -euo pipefail

# Start Dedicated Python TCP Messaging Server in background
python3 /app/tcp_server/server.py &
TCP_PID=$!

# Start FastAPI WebSocket + HTTP Gateway
uvicorn main:app --app-dir /app/backend --host 0.0.0.0 --port "${GATEWAY_PORT:-8000}" &
API_PID=$!

cleanup() {
  kill -TERM "$API_PID" "$TCP_PID" 2>/dev/null || true
  wait "$API_PID" "$TCP_PID" 2>/dev/null || true
}
trap cleanup SIGINT SIGTERM

wait -n "$TCP_PID" "$API_PID"
cleanup
