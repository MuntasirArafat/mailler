#!/usr/bin/env bash

# ==============================================================================
# Direct Mail Server — Universal 1-Click Docker Setup
# Works on any Linux VPS (Ubuntu, Debian, AlmaLinux, RockyLinux, CentOS, Fedora)
# ==============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "\n${CYAN}${BOLD}=============================================================${NC}"
echo -e "${CYAN}${BOLD}   🚀 Direct Node.js Mail Server — Docker Production Installer ${NC}"
echo -e "${CYAN}${BOLD}=============================================================${NC}\n"

if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}✖ Error: Please run as root (or with sudo).${NC}"
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${PROJECT_DIR}"

# 1. Stop conflicting host mail servers (Postfix, Exim, Sendmail, systemd mailserver)
echo -e "${CYAN}▶ Step 1/5: Checking for conflicting mail services on port 25...${NC}"
for svc in postfix sendmail exim exim4 mailserver; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    echo -e "${YELLOW}Stopping and disabling conflicting service: ${svc}...${NC}"
    systemctl stop "$svc" 2>/dev/null || true
    systemctl disable "$svc" 2>/dev/null || true
  fi
done

# 2. Install Docker & Docker Compose if missing
echo -e "\n${CYAN}▶ Step 2/5: Checking Docker installation...${NC}"
if ! command -v docker &> /dev/null; then
  echo -e "${YELLOW}Docker not found. Installing Docker engine...${NC}"
  if command -v apt-get &> /dev/null; then
    apt-get update -y
    apt-get install -y curl ca-certificates
    curl -fsSL https://get.docker.com | bash
  elif command -v dnf &> /dev/null; then
    dnf install -y dnf-plugins-core curl
    dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo 2>/dev/null || true
    dnf install -y --allowerasing docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  elif command -v yum &> /dev/null; then
    yum install -y yum-utils curl
    yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo 2>/dev/null || true
    yum install -y --allowerasing docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  systemctl enable --now docker
  echo -e "${GREEN}✔ Docker installed and running.${NC}"
else
  echo -e "${GREEN}✔ Found Docker $(docker --version)${NC}"
fi

# Configure reliable DNS for Docker engine if not present
if [ ! -f /etc/docker/daemon.json ]; then
  mkdir -p /etc/docker
  echo '{"dns": ["8.8.8.8", "1.1.1.1"]}' > /etc/docker/daemon.json
  systemctl restart docker 2>/dev/null || true
fi

# 3. Create persistent directories and configure environment
mkdir -p data/mongo config

# Check for existing .env file
HAS_ENV_FILE=false
if [ -f .env ]; then
  HAS_ENV_FILE=true
  echo -e "${GREEN}✔ Detected existing '.env' file.${NC}"
  # Source .env safely
  set -a
  source .env 2>/dev/null || true
  set +a
fi

# Parse CLI flags
INPUT_PORT=""
INPUT_PASS=""
INPUT_MONGO=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --port|-p)
      INPUT_PORT="$2"
      shift 2
      ;;
    --password|--pass|-k)
      INPUT_PASS="$2"
      shift 2
      ;;
    --mongo|--mongodb|-m)
      INPUT_MONGO="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [ "$HAS_ENV_FILE" = true ] && [ -z "$INPUT_PORT" ] && [ -z "$INPUT_PASS" ] && [ -z "$INPUT_MONGO" ]; then
  # Use values from .env
  API_PORT="${PORT:-3000}"
  API_PASSWORD="${API_PASSWORD:-ar@51/er}"
  MONGO_MODE="${MONGO_MODE:-local}"
  MONGO_URI="${MONGODB_URI:-${MONGO_LOCAL_URI:-mongodb://127.0.0.1:27017/mailserver}}"
  echo -e "${CYAN}→ Loaded configuration from .env:${NC}"
  echo -e "   • API Port        : ${BOLD}${API_PORT}${NC}"
  echo -e "   • API Password    : ${BOLD}${API_PASSWORD}${NC}"
  echo -e "   • MongoDB Mode    : ${BOLD}${MONGO_MODE}${NC}"
  echo -e "   • MongoDB URI     : ${BOLD}${MONGO_URI}${NC}"
else
  echo -e "\n${YELLOW}${BOLD}⚙️  Configure Mail Server & MongoDB Settings:${NC}"

  # 1. Port
  if [ -n "$INPUT_PORT" ]; then
    API_PORT="$INPUT_PORT"
  elif [ -n "$PORT" ]; then
    API_PORT="$PORT"
  else
    read -p "Select REST API Port [default: 3000]: " USER_PORT
    API_PORT=${USER_PORT:-3000}
  fi

  # 2. Password
  if [ -n "$INPUT_PASS" ]; then
    API_PASSWORD="$INPUT_PASS"
  elif [ -n "$API_PASSWORD" ]; then
    API_PASSWORD="$API_PASSWORD"
  else
    EXISTING_PASS=""
    if [ -f config/server.json ]; then
      EXISTING_PASS=$(node -e "try { console.log(require('./config/server.json').apiPassword || ''); } catch(e){}" 2>/dev/null || true)
    fi
    PROMPT_MSG="Enter Secret API Password"
    if [ -n "$EXISTING_PASS" ]; then
      PROMPT_MSG="Enter Secret API Password [press Enter to keep '${EXISTING_PASS}']"
    else
      PROMPT_MSG="Enter Secret API Password [press Enter to keep 'ar@51/er']"
    fi
    read -p "${PROMPT_MSG}: " USER_PASS
    if [ -n "$USER_PASS" ]; then
      API_PASSWORD="$USER_PASS"
    elif [ -n "$EXISTING_PASS" ]; then
      API_PASSWORD="$EXISTING_PASS"
    else
      API_PASSWORD="ar@51/er"
    fi
  fi

  # 3. MongoDB Mode & URI
  MONGO_MODE="${MONGO_MODE:-local}"
  read -p "Select MongoDB Mode [local/remote, default: local]: " USER_MODE
  if [ -n "$USER_MODE" ]; then
    MONGO_MODE="$USER_MODE"
  fi

  if [ "$MONGO_MODE" = "remote" ]; then
    read -p "Enter Remote MongoDB URI (e.g. mongodb+srv://...): " USER_REMOTE
    MONGO_REMOTE_URI="$USER_REMOTE"
    MONGO_LOCAL_URI="mongodb://127.0.0.1:27017/mailserver"
  else
    MONGO_MODE="local"
    MONGO_LOCAL_URI="${MONGO_LOCAL_URI:-mongodb://127.0.0.1:27017/mailserver}"
    MONGO_REMOTE_URI=""
  fi

  echo -e "\n${GREEN}✔ Configured settings:${NC}"
  echo -e "   • API Port        : ${BOLD}${API_PORT}${NC}"
  echo -e "   • API Password    : ${BOLD}${API_PASSWORD}${NC}"
  echo -e "   • MongoDB Mode    : ${BOLD}${MONGO_MODE}${NC}"
  echo -e "   • Active URI      : ${BOLD}${MONGO_REMOTE_URI:-$MONGO_LOCAL_URI}${NC}"

  # Write to .env for docker-compose
  cat << ENV_EOF > .env
PORT=${API_PORT}
API_PASSWORD=${API_PASSWORD}
MONGO_MODE=${MONGO_MODE}
MONGO_LOCAL_URI=${MONGO_LOCAL_URI}
MONGO_REMOTE_URI=${MONGO_REMOTE_URI}
MONGODB_URI=${MONGO_REMOTE_URI:-$MONGO_LOCAL_URI}
INBOUND_PORT=25
HELO_HOST=mail.exauraa.com
CONCURRENCY=25
ENV_EOF
fi

# Sync with config/server.json
node -e "
const fs = require('fs');
const file = 'config/server.json';
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e){}
cfg.port = ${API_PORT};
cfg.apiPassword = '${API_PASSWORD}';
cfg.mongodbUri = '${MONGO_URI}';
cfg.inboundPort = 25;
cfg.updatedAt = new Date().toISOString();
fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
" 2>/dev/null || true

# 4. Build & Run Docker Container
echo -e "\n${CYAN}▶ Step 3/5: Building and starting Mail Server container...${NC}"
if docker compose version &> /dev/null; then
  docker compose down --remove-orphans 2>/dev/null || true
  docker compose up -d --build
elif command -v docker-compose &> /dev/null; then
  docker-compose down --remove-orphans 2>/dev/null || true
  docker-compose up -d --build
else
  # Fallback to docker build & run
  docker build -t mailsource:latest .
  docker rm -f mailsource-mta 2>/dev/null || true
  docker run -d \
    --name mailsource-mta \
    --restart unless-stopped \
    -p 25:25 \
    -p 3000:3000 \
    -p 2525:2525 \
    -v "${PROJECT_DIR}/data:/app/data" \
    -v "${PROJECT_DIR}/config:/app/config" \
    mailsource:latest
fi

# 5. Install Host CLI Wrapper
echo -e "\n${CYAN}▶ Step 4/5: Installing global host CLI tool (mailsource)...${NC}"
cat << 'EOF' > /usr/local/bin/mailsource
#!/usr/bin/env bash
if docker ps --format '{{.Names}}' | grep -q 'mailsource-mta'; then
  docker exec -i mailsource-mta mailsource "$@"
else
  echo "Error: mailsource-mta container is not running."
  echo "Run: cd /root/mailler && docker compose up -d"
  exit 1
fi
EOF
chmod +x /usr/local/bin/mailsource
ln -sf /usr/local/bin/mailsource /usr/local/bin/mailsouce

echo -e "${GREEN}✔ 'mailsource' command ready on host terminal.${NC}"

# 6. Verify container status
echo -e "\n${CYAN}▶ Step 5/5: Verifying container health...${NC}"
sleep 3

if docker ps | grep -q 'mailsource-mta'; then
  PUBLIC_IP=$(curl -s -m 3 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  echo -e "\n${GREEN}${BOLD}🎉 DOCKER DEPLOYMENT SUCCESSFUL!${NC}"
  echo -e "${CYAN}${BOLD}=============================================================${NC}"
  echo -e "🌐 Status Webpage   : ${BOLD}http://${PUBLIC_IP}:3000/${NC}"
  echo -e "📥 Inbound Port     : ${BOLD}25 (TCP)${NC}"
  echo -e "⚡ Container Status  : ${GREEN}${BOLD}RUNNING${NC}"
  echo -e ""
  echo -e "${YELLOW}${BOLD}Commands:${NC}"
  echo -e "  • Send mail       : ${CYAN}mailsource send --to user@gmail.com --from me@domain.com --name \"Support\" --subject \"Test\" --body \"Hi\" --sync${NC}"
  echo -e "  • Check queue     : ${CYAN}mailsource queue${NC}"
  echo -e "  • View container  : ${CYAN}docker logs -f mailsource-mta${NC}"
  echo -e "${CYAN}${BOLD}=============================================================${NC}\n"
else
  echo -e "${RED}✖ Error: Container failed to start. Showing logs:${NC}"
  docker logs mailsource-mta
  exit 1
fi
