#!/usr/bin/env bash

# ==============================================================================
# Direct Node.js Mail Server — Automated VPS Installation & Systemd Service Script
# Ensures 24/7 uptime and automatic restart on server reboot or process crash.
# ==============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo -e "\n${CYAN}${BOLD}=============================================================${NC}"
echo -e "${CYAN}${BOLD}   🚀 Direct Node.js Mail Server — VPS Production Installer   ${NC}"
echo -e "${CYAN}${BOLD}=============================================================${NC}\n"

# 1. Require root privileges
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}✖ Error: This installer must be run as root (or with sudo).${NC}"
  echo "Try running: sudo bash $0"
  exit 1
fi

APP_DIR="/opt/mailserver"
SERVICE_NAME="mailserver"

# 2. Parse CLI args or interactive prompt for Port & Password
INPUT_PORT=""
INPUT_PASS=""

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
    *)
      shift
      ;;
  esac
done

echo -e "${YELLOW}${BOLD}⚙️  Configure Your Mail Server Credentials:${NC}"

# Ask for Port
if [ -z "$INPUT_PORT" ] && [ -n "$PORT" ]; then
  INPUT_PORT="$PORT"
fi

if [ -z "$INPUT_PORT" ]; then
  read -p "Select API Service Port [default: 3000]: " USER_PORT
  API_PORT=${USER_PORT:-3000}
else
  API_PORT="$INPUT_PORT"
fi

# Ask for Password
if [ -z "$INPUT_PASS" ] && [ -n "$API_PASSWORD" ]; then
  INPUT_PASS="$API_PASSWORD"
fi

if [ -z "$INPUT_PASS" ]; then
  read -p "Enter Secret API Password [press Enter to auto-generate]: " USER_PASS
  if [ -z "$USER_PASS" ]; then
    RAND_KEY=$(openssl rand -hex 16 2>/dev/null || date +%s%N | sha256sum | head -c 32)
    API_PASSWORD="sec_${RAND_KEY}"
    echo -e "${CYAN}→ Auto-generated password: ${BOLD}${API_PASSWORD}${NC}"
  else
    API_PASSWORD="$USER_PASS"
  fi
else
  API_PASSWORD="$INPUT_PASS"
fi

echo -e "\n${GREEN}✔ Configuration chosen:${NC}"
echo -e "  • Service Port : ${BOLD}${API_PORT}${NC}"
echo -e "  • API Password : ${BOLD}${API_PASSWORD}${NC}"
echo -e "\n${CYAN}Starting automated system setup...${NC}\n"

# 3. Detect Package Manager & Install System Dependencies
echo -e "${CYAN}▶ Step 1/6: Checking system dependencies & Node.js...${NC}"

if command -v apt-get &> /dev/null; then
  apt-get update -y
  apt-get install -y curl git build-essential ufw openssl
elif command -v dnf &> /dev/null; then
  dnf install -y curl git gcc-c++ make openssl
elif command -v yum &> /dev/null; then
  yum install -y curl git gcc-c++ make openssl
fi

# Check Node.js version (Requires Node.js 20 or 22 LTS for built-in SQLite & Direct Sockets)
NODE_INSTALLED=false
if command -v node &> /dev/null; then
  NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$NODE_VER" -ge 20 ]; then
    NODE_INSTALLED=true
    echo -e "${GREEN}✔ Found Node.js $(node -v)${NC}"
  fi
fi

if [ "$NODE_INSTALLED" = false ]; then
  echo -e "${YELLOW}Installing latest Node.js 22 LTS...${NC}"
  if command -v apt-get &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  elif command -v dnf &> /dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y nodejs
  elif command -v yum &> /dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    yum install -y nodejs
  fi
  echo -e "${GREEN}✔ Node.js $(node -v) installed successfully.${NC}"
fi

NODE_BIN=$(command -v node)

# 4. Copy Application Files to /opt/mailserver
echo -e "\n${CYAN}▶ Step 2/6: Deploying files to ${APP_DIR}...${NC}"

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "${APP_DIR}"
mkdir -p "${APP_DIR}/data"
mkdir -p "${APP_DIR}/config"

if [ "${CURRENT_DIR}" != "${APP_DIR}" ]; then
  echo "Copying files from ${CURRENT_DIR} to ${APP_DIR}..."
  cp -r "${CURRENT_DIR}/." "${APP_DIR}/"
fi

cd "${APP_DIR}"

# 5. Persist Port and Password into config/server.json
cat <<EOF > "${APP_DIR}/config/server.json"
{
  "port": ${API_PORT},
  "apiPassword": "${API_PASSWORD}",
  "inboundPort": 25,
  "concurrency": 25,
  "heloHost": "mail.localmta.dev",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

# 6. Install NPM Dependencies
echo -e "\n${CYAN}▶ Step 3/6: Installing project dependencies...${NC}"
npm install --production
echo -e "${GREEN}✔ Dependencies installed.${NC}"

# 7. Configure Firewall (Open Port 25, API_PORT, 2525)
echo -e "\n${CYAN}▶ Step 4/6: Configuring firewall rules...${NC}"
if command -v ufw &> /dev/null; then
  ufw allow 25/tcp comment "Inbound/Outbound SMTP" >/dev/null 2>&1 || true
  ufw allow 2525/tcp comment "Local Inbound SMTP Relay" >/dev/null 2>&1 || true
  ufw allow "${API_PORT}/tcp" comment "Mail Server REST API" >/dev/null 2>&1 || true
  echo -e "${GREEN}✔ Ports 25, 2525, and ${API_PORT} allowed in UFW.${NC}"
elif command -v firewall-cmd &> /dev/null; then
  firewall-cmd --permanent --add-port=25/tcp >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-port=2525/tcp >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-port="${API_PORT}/tcp" >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
  echo -e "${GREEN}✔ Ports allowed in firewalld.${NC}"
fi

# 8. Create & Enable Systemd Service (Autostart on Boot & Auto-Restart on Crash)
echo -e "\n${CYAN}▶ Step 5/6: Configuring persistent Systemd background service...${NC}"

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

cat <<EOF > "${SERVICE_FILE}"
[Unit]
Description=Direct Node.js Mail Server & High-Throughput MTA
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} index.js --port ${API_PORT} --password ${API_PASSWORD}
Restart=always
RestartSec=5s

# High-concurrency limits for sending millions of emails
LimitNOFILE=65535
LimitNPROC=4096

# Environment Configurations
Environment=NODE_ENV=production
Environment=PORT=${API_PORT}
Environment=API_PASSWORD=${API_PASSWORD}
Environment=INBOUND_PORT=25
Environment=CONCURRENCY=25

# Standard Logging to systemd journal
StandardOutput=journal
StandardError=journal
SyslogIdentifier=mailserver

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"
systemctl restart "${SERVICE_NAME}.service"

# Install global CLI command `mailsource` (and alias `mailsouce`)
chmod +x "${APP_DIR}/bin/mailsource.js"
ln -sf "${APP_DIR}/bin/mailsource.js" /usr/local/bin/mailsource
ln -sf "${APP_DIR}/bin/mailsource.js" /usr/local/bin/mailsouce

echo -e "${GREEN}✔ Global CLI commands 'mailsource' and 'mailsouce' installed to /usr/local/bin${NC}"

# 9. Verify Service Status
echo -e "\n${CYAN}▶ Step 6/6: Verifying service health...${NC}"
sleep 2

if systemctl is-active --quiet "${SERVICE_NAME}"; then
  echo -e "${GREEN}${BOLD}✔ Mail Server is RUNNING and ACTIVE!${NC}\n"
else
  echo -e "${RED}✖ Warning: Service failed to start. Showing logs:${NC}"
  journalctl -u "${SERVICE_NAME}" -n 25 --no-pager
  exit 1
fi

PUBLIC_IP=$(curl -s -m 3 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_VPS_IP")

echo -e "${CYAN}${BOLD}=============================================================${NC}"
echo -e "${GREEN}${BOLD}🎉 INSTALLATION COMPLETE & AUTOSTART ACTIVATED!${NC}"
echo -e "${CYAN}${BOLD}=============================================================${NC}"
echo -e "🌐 Status Webpage        : ${BOLD}http://${PUBLIC_IP}:${API_PORT}/${NC}"
echo -e "📡 REST API Base URL     : ${BOLD}http://${PUBLIC_IP}:${API_PORT}/api/${NC}"
echo -e "🔑 Secret API Password   : ${YELLOW}${BOLD}${API_PASSWORD}${NC}"
echo -e "📥 Inbound SMTP Port     : ${BOLD}25 (TCP)${NC}"
echo -e "💾 Working Directory     : ${APP_DIR}"
echo -e ""
echo -e "${YELLOW}${BOLD}⚡ Global CLI Tool (run from ANY directory on this VPS):${NC}"
echo -e "  • ${BOLD}Send Email${NC}   : ${CYAN}mailsource send --to user@gmail.com --from me@domain.com --subject \"Test\" --body \"Hello\"${NC}"
echo -e "  • ${BOLD}Check Status${NC} : ${CYAN}mailsource status${NC}"
echo -e "  • ${BOLD}View Inbox${NC}   : ${CYAN}mailsource inbox${NC}"
echo -e "  • ${BOLD}Read Email${NC}   : ${CYAN}mailsource read 1${NC}"
echo -e "  • ${BOLD}Add Domain${NC}   : ${CYAN}mailsource domains add yourdomain.com${NC}"
echo -e "  • ${BOLD}Verify DNS${NC}   : ${CYAN}mailsource domains verify yourdomain.com${NC}"
echo -e ""
echo -e "${BOLD}Helpful Service Management Commands:${NC}"
echo -e "  • Check Status : ${CYAN}systemctl status ${SERVICE_NAME}${NC}"
echo -e "  • View Live Log: ${CYAN}journalctl -u ${SERVICE_NAME} -f${NC}"
echo -e "  • Restart      : ${CYAN}systemctl restart ${SERVICE_NAME}${NC}"
echo -e "  • Stop         : ${CYAN}systemctl stop ${SERVICE_NAME}${NC}"
echo -e "${CYAN}${BOLD}=============================================================${NC}\n"
