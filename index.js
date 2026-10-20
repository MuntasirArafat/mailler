const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./src/db');
const DirectMta = require('./src/direct-mta');
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
    } else if (arg === '--helo') {
      parsed.heloHost = args[++i];
    } else if (arg === '--inbound') {
      parsed.inboundPort = parseInt(args[++i], 10);
    } else if (arg === '--mongo' || arg === '--mongodb') {
      parsed.mongodbUri = args[++i];
    } else if (arg === '--mongo-mode') {
      parsed.mongoMode = args[++i];
    } else if (arg === '--concurrency' || arg === '-c') {
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

if (!API_PASSWORD) {
  API_PASSWORD = 'sec_' + crypto.randomBytes(16).toString('hex');
  console.log(`\n[Security] No API password configured. Generated secure key: ${API_PASSWORD}`);
}

// 3. Resolve HELO hostname, Inbound Port, Concurrency & MongoDB Mode/URI
const HELO_HOST = cliArgs.heloHost || process.env.HELO_HOST || savedConfig.heloHost || 'mail.exauraa.com';
const INBOUND_PORT = cliArgs.inboundPort || parseInt(process.env.INBOUND_PORT || '', 10) || savedConfig.inboundPort || 25;
const CONCURRENCY = cliArgs.concurrency || parseInt(process.env.CONCURRENCY || '', 10) || savedConfig.concurrency || 20;

if (cliArgs.mongoMode) process.env.MONGO_MODE = cliArgs.mongoMode;
const MONGO_MODE = db.getMongoMode();
const MONGODB_URI = cliArgs.mongodbUri || db.getMongoUri();

// Save configuration to config/server.json so it persists across restarts
savedConfig = {
  ...savedConfig,
  port: API_PORT,
  apiPassword: API_PASSWORD,
  heloHost: HELO_HOST,
  inboundPort: INBOUND_PORT,
  concurrency: CONCURRENCY,
  mongoMode: MONGO_MODE,
  mongodbUri: MONGODB_URI,
  updatedAt: new Date().toISOString()
};
fs.writeFileSync(configFile, JSON.stringify(savedConfig, null, 2), 'utf8');

async function start() {
  // 4. Connect to MongoDB via Mongoose
  let mongoConnected = false;
  try {
    await db.connect(MONGODB_URI);
    mongoConnected = true;
  } catch (err) {
    console.error(`\n⚠️  [Mongoose Warning] Could not connect to MongoDB in [${MONGO_MODE.toUpperCase()}] mode at ${MONGODB_URI}: ${err.message}`);
    console.error(`   Job queue and MongoDB-backed inbox require a running MongoDB instance.`);
    console.error(`   Check MONGO_MODE ('local' or 'remote') and MONGO_LOCAL_URI / MONGO_REMOTE_URI in .env.\n`);
  }

  // 5. Initialize Direct MTA (Outbound mail engine: MX lookup -> Port 25 -> TLS delivery)
  const mta = new DirectMta({
    heloHost: HELO_HOST
  });

  // 6. Initialize Job Queue (MongoDB Backed)
  let jobQueue = null;
  if (mongoConnected) {
    jobQueue = new JobQueue(mta, {
      concurrency: CONCURRENCY,
      maxRetries: 5
    });
    jobQueue.start();
  }

  // 7. Initialize Inbound Mail Receiver (Port 25 SMTP listening -> MongoDB storage)
  const inboundReceiver = new InboundReceiver({
    port: INBOUND_PORT,
    host: '0.0.0.0',
    serverName: HELO_HOST
  });

  let inboundRunning = false;
  try {
    await inboundReceiver.start();
    inboundRunning = true;
  } catch (err) {
    console.error(`\n⚠️  [InboundReceiver Warning] Could not start inbound SMTP receiver on port ${INBOUND_PORT}: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      console.error(`👉 Port ${INBOUND_PORT} is in use by another process. Check with: ss -tulpn | grep :${INBOUND_PORT}`);
    }
    console.error(`   Outbound direct MTA and REST API will still proceed.\n`);
  }

  // 8. Initialize Protected REST API
  const app = createApiServer(mta, jobQueue, inboundReceiver, {
    apiPassword: API_PASSWORD
  });

  const server = app.listen(API_PORT, () => {
    console.log(`\n=============================================================`);
    console.log(`🚀 PRODUCTION DIRECT MTA SENDER & INBOUND RECEIVER NODE`);
    console.log(`=============================================================`);
    console.log(`📡 REST API Endpoint     : http://localhost:${API_PORT}`);
    console.log(`🔒 API Authentication    : REQUIRED`);
    console.log(`🔑 Secret API Password   : ${API_PASSWORD}`);
    console.log(`🗄️  Database              : MongoDB via Mongoose (${mongoConnected ? `CONNECTED [${MONGO_MODE.toUpperCase()}]` : 'OFFLINE'})`);
    console.log(`⚡ Outbound Engine       : Direct MX Delivery (Port 25 with STARTTLS)`);
    console.log(`📬 Job Queue Worker      : ${jobQueue ? `ACTIVE (${CONCURRENCY} workers, retry backoff)` : 'DISABLED (Requires MongoDB)'}`);
    console.log(`📥 Inbound Receiver      : ${inboundRunning ? `smtp://0.0.0.0:${INBOUND_PORT} (Saved to MongoDB)` : 'OFFLINE'}`);
    console.log(`🛡️ Anti-Spam Shield      : DKIM 2048-bit + SPF Alignment + RFC 8058`);
    console.log(`=============================================================`);
    console.log(`\n👉 Authenticate your requests using:`);
    console.log(`   Header : -H "x-api-key: ${API_PASSWORD}"`);
    console.log(`   Bearer : -H "Authorization: Bearer ${API_PASSWORD}"`);
    console.log(`   Query  : ?api_key=${API_PASSWORD}\n`);
  });

  const shutdown = async () => {
    console.log('\nGracefully shutting down Mail Server...');
    if (jobQueue) {
      jobQueue.stop();
    }
    if (inboundRunning) {
      await inboundReceiver.stop();
    }
    await db.close();
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
