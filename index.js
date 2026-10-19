const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JobQueue = require('./src/job-queue');
const InboundReceiver = require('./src/inbound-receiver');
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
    } else if (arg === '--inbound') {
      parsed.inboundPort = parseInt(args[++i], 10);
    } else if (arg === '--concurrency') {
      parsed.concurrency = parseInt(args[++i], 10);
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

// 3. Resolve Inbound Port & Concurrency
const INBOUND_PORT = cliArgs.inboundPort || parseInt(process.env.INBOUND_PORT || '', 10) || savedConfig.inboundPort || 2525;
const CONCURRENCY = cliArgs.concurrency || parseInt(process.env.CONCURRENCY || '', 10) || savedConfig.concurrency || 20;
const HELO_HOST = process.env.HELO_HOST || savedConfig.heloHost || 'mail.localmta.dev';

// Save configuration to config/server.json so it persists across restarts
savedConfig = {
  ...savedConfig,
  port: API_PORT,
  apiPassword: API_PASSWORD,
  inboundPort: INBOUND_PORT,
  concurrency: CONCURRENCY,
  heloHost: HELO_HOST,
  updatedAt: new Date().toISOString()
};
fs.writeFileSync(configFile, JSON.stringify(savedConfig, null, 2), 'utf8');

// 4. Initialize Outbound Job Queue
const jobQueue = new JobQueue({
  concurrency: CONCURRENCY,
  heloHost: HELO_HOST
});
jobQueue.start();

// 5. Initialize Inbound Receiver (Reading Mail)
const inboundReceiver = new InboundReceiver({
  port: INBOUND_PORT,
  host: '0.0.0.0',
  serverName: HELO_HOST
});

inboundReceiver.start().then(() => {
  // 6. Initialize API with Authentication
  const app = createApiServer(jobQueue, inboundReceiver, { apiPassword: API_PASSWORD });

  const server = app.listen(API_PORT, () => {
    console.log(`\n=============================================================`);
    console.log(`🚀 HIGH-THROUGHPUT DIRECT NODE.JS MAIL SERVER (PROTECTED API)`);
    console.log(`=============================================================`);
    console.log(`📡 REST API Endpoint     : http://localhost:${API_PORT}`);
    console.log(`🔒 API Authentication    : REQUIRED`);
    console.log(`🔑 Secret API Password   : ${API_PASSWORD}`);
    console.log(`📥 Inbound Mail Receiver : smtp://0.0.0.0:${INBOUND_PORT}`);
    console.log(`⚡ Outbound Concurrency  : ${CONCURRENCY} active workers`);
    console.log(`💾 High-Volume Database  : SQLite WAL Engine (millions ready)`);
    console.log(`🛡️ Anti-Spam Shield      : DKIM + SPF Alignment + RFC 8058`);
    console.log(`=============================================================`);
    console.log(`\n👉 Authenticate your requests using:`);
    console.log(`   Header : -H "x-api-key: ${API_PASSWORD}"`);
    console.log(`   Bearer : -H "Authorization: Bearer ${API_PASSWORD}"`);
    console.log(`   Query  : ?api_key=${API_PASSWORD}\n`);
  });

  const shutdown = async () => {
    console.log('\nGracefully shutting down Mail Server...');
    jobQueue.stop();
    await inboundReceiver.stop();
    server.close(() => {
      console.log('Server stopped cleanly.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}).catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
