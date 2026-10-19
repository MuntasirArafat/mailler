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

# 3. Create persistent directories
mkdir -p data config

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
