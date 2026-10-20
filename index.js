const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DirectMta = require('./src/direct-mta');
const createApiServer = require('./src/api-server');

// Parse Command Line Arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' || arg === '-p') {
      parsed.port = parseInt(args[++i], 10);
    } else if (arg === '--password' || arg === '--pass' || arg === '--key' || arg === '-k') {
      parsed.password = args[++i];
    } else if (arg === '--helo') {
      parsed.heloHost = args[++i];
    }
  }
  return parsed;
}

const cliArgs = parseArgs();

// Load persistent config/server.json if exists
const configDir = path.join(__dirname, 'config');
const configFile = path.join(configDir, 'server.json');
let savedConfig = {};

if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

if (fs.existsSync(configFile)) {
  try {
    savedConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (e) {}
}

// 1. Resolve API Port
const API_PORT = cliArgs.port || parseInt(process.env.PORT || '', 10) || savedConfig.port || 3000;

// 2. Resolve API Password / Secret Key
let API_PASSWORD = cliArgs.password || process.env.API_PASSWORD || process.env.API_KEY || savedConfig.apiPassword;

// If no password provided anywhere, generate a secure random password on first run
if (!API_PASSWORD) {
  API_PASSWORD = 'sec_' + crypto.randomBytes(16).toString('hex');
  console.log(`\n[Security] No API password configured. Generated secure key: ${API_PASSWORD}`);
}

// 3. Resolve HELO hostname
const HELO_HOST = cliArgs.heloHost || process.env.HELO_HOST || savedConfig.heloHost || 'mail.localmta.dev';

// Save configuration to config/server.json so it persists across restarts
savedConfig = {
  ...savedConfig,
  port: API_PORT,
  apiPassword: API_PASSWORD,
  heloHost: HELO_HOST,
  updatedAt: new Date().toISOString()
};
fs.writeFileSync(configFile, JSON.stringify(savedConfig, null, 2), 'utf8');

async function start() {
  // 4. Initialize Direct MTA (Outbound mail engine: MX lookup -> Port 25 -> TLS delivery)
  const mta = new DirectMta({
    heloHost: HELO_HOST
  });

  // 5. Initialize Protected REST API for centralized dispatch
  const app = createApiServer(mta, { apiPassword: API_PASSWORD });

  const server = app.listen(API_PORT, () => {
    console.log(`\n=============================================================`);
    console.log(`🚀 STATELESS DIRECT NODE.JS MTA SENDER NODE (PROTECTED API)`);
    console.log(`=============================================================`);
    console.log(`📡 REST API Endpoint     : http://localhost:${API_PORT}`);
    console.log(`🔒 API Authentication    : REQUIRED`);
    console.log(`🔑 Secret API Password   : ${API_PASSWORD}`);
    console.log(`⚡ Outbound Engine       : Direct MX Delivery (Port 25 with STARTTLS)`);
    console.log(`💾 Architecture          : Stateless Worker (Zero SQLite - Centralized Control)`);
    console.log(`🛡️ Anti-Spam Shield      : DKIM + SPF Alignment + RFC 8058`);
    console.log(`=============================================================`);
    console.log(`\n👉 Authenticate your requests using:`);
    console.log(`   Header : -H "x-api-key: ${API_PASSWORD}"`);
    console.log(`   Bearer : -H "Authorization: Bearer ${API_PASSWORD}"`);
    console.log(`   Query  : ?api_key=${API_PASSWORD}\n`);
  });

  const shutdown = async () => {
    console.log('\nGracefully shutting down Mail Server...');
    server.close(() => {
      console.log('Server stopped cleanly.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
