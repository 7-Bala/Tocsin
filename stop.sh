#!/usr/bin/env bash
set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${CYAN}${BOLD}🛑 Stopping Tocsin services and cleaning up tunnels...${NC}"

# 1. Kill background ngrok process if running
NGROK_PID_FILE="/tmp/tocsin-ngrok.pid"
if [ -f "$NGROK_PID_FILE" ]; then
  NGROK_PID=$(cat "$NGROK_PID_FILE" 2>/dev/null || echo "")
  if [ -n "$NGROK_PID" ] && kill -0 "$NGROK_PID" 2>/dev/null; then
    echo -e "${YELLOW}Killing ngrok process (PID: $NGROK_PID)...${NC}"
    kill "$NGROK_PID" 2>/dev/null || true
  fi
  rm -f "$NGROK_PID_FILE"
fi

# Fallback cleanup for any lingering tocsin ngrok processes on port 8001
pkill -f "ngrok http 8001" 2>/dev/null || true

# 2. Stop and remove Docker containers
docker compose down

echo -e "${GREEN}${BOLD}✅ All Tocsin containers and background tunnels have been stopped.${NC}"
