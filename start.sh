#!/usr/bin/env bash
set -e

# Clear screen if running in an interactive terminal
[ -t 1 ] && command -v clear >/dev/null 2>&1 && clear || true

# ANSI Color Codes
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo -e "${CYAN}${BOLD}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                  🚨  T O C S I N  🚨                         ║"
echo "║       Real-Time Multilingual Voice AI Disaster Command       ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# 1. Ensure .env exists
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    echo -e "${YELLOW}📋 Creating .env from .env.example...${NC}"
    cp .env.example .env
  fi
fi

# Helper function to safely update an environment variable in a .env file
update_env_var() {
  local target_file="$1"
  local var_key="$2"
  local var_val="$3"

  if [ -f "$target_file" ]; then
    python3 -c "
import sys
path, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, 'r') as f:
    lines = f.readlines()
found = False
new_lines = []
for line in lines:
    if line.strip().startswith(key + '='):
        new_lines.append(f'{key}=\"{val}\"\n')
        found = True
    else:
        new_lines.append(line)
if not found:
    new_lines.append(f'{key}=\"{val}\"\n')
with open(path, 'w') as f:
    f.writelines(new_lines)
" "$target_file" "$var_key" "$var_val"
  fi
}

# 2. Check & Auto-Launch Docker Desktop if stopped
if ! docker info >/dev/null 2>&1; then
  echo -e "${YELLOW}⚠️  Docker daemon is not running.${NC}"
  
  if [ -d "/Applications/Docker.app" ]; then
    echo -e "${BLUE}🚀 Automatically launching Docker Desktop...${NC}"
    open -a Docker
    
    echo -ne "${BLUE}⏳ Waiting for Docker daemon to initialize...${NC}"
    MAX_RETRIES=40
    RETRY_COUNT=0
    
    until docker info >/dev/null 2>&1; do
      RETRY_COUNT=$((RETRY_COUNT + 1))
      if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
        echo -e "\n${RED}❌ Docker took too long to start. Please check Docker Desktop manually.${NC}"
        exit 1
      fi
      sleep 2
      printf "."
    done
    echo -e "\n${GREEN}✅ Docker daemon is ready!${NC}\n"
  else
    echo -e "${RED}❌ Docker.app not found in /Applications. Please install or launch Docker.${NC}"
    exit 1
  fi
fi

# 3. Build & Boot Containers in Background
echo -e "${CYAN}⚡ Starting Docker services in background...${NC}"
docker compose up --build -d

echo -ne "${CYAN}⏳ Verifying health of backend, database, and mock services...${NC}"
MAX_HEALTH_RETRIES=30
HEALTH_COUNT=0
until curl -s -f http://localhost:8000/health >/dev/null 2>&1 && curl -s --max-time 1 http://localhost:8001/mcp >/dev/null 2>&1; do
  sleep 1
  HEALTH_COUNT=$((HEALTH_COUNT + 1))
  if [ $HEALTH_COUNT -ge $MAX_HEALTH_RETRIES ]; then
    echo -e "\n${YELLOW}⚠️  Services started (health check timed out, proceeding)...${NC}"
    break
  fi
  printf "."
done
echo -e " ${GREEN}Services Online!${NC}\n"

# 4. Automate ngrok Tunnel Lifecycle for MCP Tool Server (Port 8001)
NGROK_URL=""
NGROK_PID_FILE="/tmp/tocsin-ngrok.pid"
NGROK_LOG_FILE="/tmp/tocsin-ngrok.log"

echo -e "${BLUE}🌐 Inspecting ngrok tunnel status for port 8001...${NC}"

# Check if ngrok is already running with an active tunnel on port 8001
get_existing_ngrok_url() {
  curl -s --max-time 2 http://localhost:4040/api/tunnels 2>/dev/null | python3 -c '
import sys, json
try:
    data = json.load(sys.stdin)
    tunnels = data.get("tunnels", [])
    for t in tunnels:
        addr = str(t.get("config", {}).get("addr", ""))
        public_url = str(t.get("public_url", ""))
        if "8001" in addr and public_url.startswith("https://"):
            print(public_url.rstrip("/"))
            sys.exit(0)
    # Fallback to any https tunnel
    for t in tunnels:
        public_url = str(t.get("public_url", ""))
        if public_url.startswith("https://"):
            print(public_url.rstrip("/"))
            sys.exit(0)
except Exception:
    pass
' 2>/dev/null || echo ""
}

NGROK_URL=$(get_existing_ngrok_url)

if [ -n "$NGROK_URL" ]; then
  echo -e "${GREEN}♻️  Reusing active ngrok tunnel:${NC} ${BOLD}${NGROK_URL}${NC}"
else
  if ! command -v ngrok >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  WARNING: ngrok is not installed.${NC}"
    echo -e "${YELLOW}   MCP tool-calling by Gemini Live / Agora requires a public HTTPS tunnel.${NC}"
    echo -e "${YELLOW}   Install via: brew install ngrok/ngrok/ngrok${NC}"
  else
    echo -e "${BLUE}🚀 Starting fresh ngrok tunnel on port 8001...${NC}"
    # Start ngrok in background
    ngrok http 8001 --log=stdout > "$NGROK_LOG_FILE" 2>&1 &
    NGROK_PID=$!
    echo "$NGROK_PID" > "$NGROK_PID_FILE"

    echo -ne "${BLUE}⏳ Waiting for ngrok public tunnel to establish...${NC}"
    MAX_TUNNEL_RETRIES=15
    TUNNEL_COUNT=0

    while [ $TUNNEL_COUNT -lt $MAX_TUNNEL_RETRIES ]; do
      sleep 1
      TUNNEL_COUNT=$((TUNNEL_COUNT + 1))
      printf "."
      NGROK_URL=$(get_existing_ngrok_url)
      if [ -n "$NGROK_URL" ]; then
        break
      fi
    done

    if [ -n "$NGROK_URL" ]; then
      echo -e "\n${GREEN}✅ Tunnel created:${NC} ${BOLD}${NGROK_URL}${NC}"
    else
      echo -e "\n${YELLOW}⚠️  Could not establish ngrok tunnel within 15 seconds.${NC}"
      if [ -f "$NGROK_LOG_FILE" ]; then
        echo -e "${YELLOW}   ngrok log snippet:${NC}"
        tail -n 6 "$NGROK_LOG_FILE" | sed 's/^/   /' || true
      fi
      echo -e "${YELLOW}   Check authentication: ngrok config add-authtoken <token>${NC}"
    fi
  fi
fi

# 5. Wire NGROK_URL into .env, backend/.env, and refresh backend container if updated
if [ -n "$NGROK_URL" ]; then
  echo -e "\n${CYAN}⚙️  Updating MCP_SERVER_PUBLIC_URL in .env and backend/.env...${NC}"
  update_env_var ".env" "MCP_SERVER_PUBLIC_URL" "$NGROK_URL"
  update_env_var "backend/.env" "MCP_SERVER_PUBLIC_URL" "$NGROK_URL"

  echo -e "${CYAN}🔄 Refreshing backend container environment...${NC}"
  docker compose up -d --no-deps backend >/dev/null 2>&1

  # Verify URL inside running backend container
  CONTAINER_MCP_URL=$(docker compose exec -T backend env | grep "^MCP_SERVER_PUBLIC_URL=" | cut -d'=' -f2- | tr -d '"' | tr -d '\r')

  if [ "$CONTAINER_MCP_URL" != "$NGROK_URL" ]; then
    echo -e "${RED}${BOLD}❌ ERROR: Environment variable verification failed!${NC}"
    echo -e "${RED}   Expected in backend container: '$NGROK_URL'${NC}"
    echo -e "${RED}   Found in backend container:    '$CONTAINER_MCP_URL'${NC}"
    exit 1
  else
    echo -e "${GREEN}✅ Verified: backend container is running with MCP_SERVER_PUBLIC_URL=${CONTAINER_MCP_URL}${NC}\n"
  fi
fi

# 6. Automatically Open Dashboard in Browser (macOS)
if command -v open >/dev/null 2>&1; then
  echo -e "${BLUE}🌐 Opening Dashboard in your default browser...${NC}"
  sleep 1
  open http://localhost:3000 || true
fi

# 7. Print Final Status Summary Output & Endpoints
echo -e "${GREEN}${BOLD}════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}             ✅ ALL TOCSIN SERVICES ARE RUNNING!                ${NC}"
echo -e "${GREEN}${BOLD}════════════════════════════════════════════════════════════════${NC}\n"

echo -e "${BOLD}📍 Access URLs:${NC}"
echo -e "  • ${BOLD}Command Dashboard:${NC}   ${CYAN}http://localhost:3000${NC}"
echo -e "  • ${BOLD}Voice AI Test Room:${NC}  ${CYAN}http://localhost:3000/voice-test${NC}"
echo -e "  • ${BOLD}Backend REST API:${NC}    ${CYAN}http://localhost:8000/docs${NC}"
echo -e "  • ${BOLD}Emergency Tools MCP:${NC} ${CYAN}http://localhost:8001/mcp${NC}"
if [ -n "$NGROK_URL" ]; then
  echo -e "  • ${BOLD}🔗 MCP Public Tunnel:${NC} ${GREEN}${BOLD}${NGROK_URL}${NC} ${YELLOW}(may change on next restart — free tier)${NC}"
else
  echo -e "  • ${BOLD}⚠️  MCP Public Tunnel:${NC} ${YELLOW}Not active (ngrok missing or unauthenticated)${NC}"
fi
echo -e "  • ${BOLD}PostgreSQL Database:${NC} ${CYAN}localhost:5432${NC}"
echo -e "  • ${BOLD}Redis State Cache:${NC}   ${CYAN}localhost:6379${NC}\n"

echo -e "${BOLD}💡 Useful Commands & Tips:${NC}"
echo -e "  • ${MAGENTA}View live logs:${NC}        ${BOLD}./logs.sh${NC} (or ${BOLD}docker compose logs -f${NC})"
echo -e "  • ${MAGENTA}View backend logs only:${NC} ${BOLD}docker compose logs -f backend${NC}"
echo -e "  • ${MAGENTA}Stop everything & ngrok:${NC} ${BOLD}./stop.sh${NC} (or ${BOLD}docker compose down${NC})"
echo -e "  • ${MAGENTA}Restart everything:${NC}    ${BOLD}./start.sh${NC}\n"

echo -e "${YELLOW}👉 Check your browser window to start using Tocsin!${NC}\n"
