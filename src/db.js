const { MongoClient } = require('mongodb');

let client = null;
let db = null;
let isConnecting = false;

const DEFAULT_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/mailserver';

async function connect(uri = DEFAULT_URI) {
  if (db) return db;
  if (isConnecting) {
    while (isConnecting) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (db) return db;
  }

  isConnecting = true;
  try {
    const mongoUri = uri || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/mailserver';
    console.log(`[MongoDB] Connecting to ${mongoUri.replace(/:([^:@]{3,})@/, ':****@')}...`);
    
    client = new MongoClient(mongoUri, {
      maxPoolSize: 50,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000
    });

    await client.connect();
    
    // Extract db name from URI or default to 'mailserver'
    const parsedUri = new URL(mongoUri.startsWith('mongodb://') || mongoUri.startsWith('mongodb+srv://') ? mongoUri : `mongodb://${mongoUri}`);
    const dbName = (parsedUri.pathname && parsedUri.pathname.replace(/^\//, '')) || 'mailserver';
    db = client.db(dbName);

    console.log(`[MongoDB] ✔ Connected successfully to database: ${dbName}`);

    // Create essential indexes for fast queuing and querying
    await createIndexes();

    return db;
  } catch (err) {
    console.error(`[MongoDB] ✖ Connection error: ${err.message}`);
    throw err;
  } finally {
    isConnecting = false;
  }
}

async function createIndexes() {
  if (!db) return;
  try {
    const jobs = db.collection('mail_jobs');
    await jobs.createIndex({ status: 1, nextRetryAt: 1, priority: -1 }, { background: true });
    await jobs.createIndex({ jobId: 1 }, { unique: true, background: true });
    await jobs.createIndex({ recipient: 1 }, { background: true });
    await jobs.createIndex({ createdAt: -1 }, { background: true });

    const inbound = db.collection('inbound_messages');
    await inbound.createIndex({ id: 1 }, { unique: true, background: true });
    await inbound.createIndex({ to_email: 1 }, { background: true });
    await inbound.createIndex({ from_email: 1 }, { background: true });
    await inbound.createIndex({ received_at: -1 }, { background: true });

    console.log(`[MongoDB] ✔ Production indexes verified on 'mail_jobs' & 'inbound_messages'`);
  } catch (err) {
    console.warn(`[MongoDB] Index setup warning: ${err.message}`);
  }
}

function getDb() {
  if (!db) {
    throw new Error('Database not connected. Call connect() first.');
  }
  return db;
}

function jobsCollection() {
  return getDb().collection('mail_jobs');
}

function inboundCollection() {
  return getDb().collection('inbound_messages');
}

function isConnected() {
  return !!db;
}

async function close() {
  if (client) {
    try {
      await client.close();
      db = null;
      client = null;
      console.log('[MongoDB] Connection closed.');
    } catch (e) {}
  }
}

module.exports = {
  connect,
  getDb,
  jobsCollection,
  inboundCollection,
  isConnected,
  close
};
