const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'mailserver.db');
const db = new DatabaseSync(dbPath);

// Enable WAL mode for high concurrency (thousands of transactions/sec)
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA cache_size = -64000;'); // 64MB cache

// Initialize Schemas
db.exec(`
  CREATE TABLE IF NOT EXISTS outbound_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    from_email TEXT NOT NULL,
    to_email TEXT NOT NULL,
    recipient_domain TEXT NOT NULL,
    subject TEXT,
    text_body TEXT,
    html_body TEXT,
    attachments_json TEXT,
    headers_json TEXT,
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 5,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    delivery_response TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_status_attempt ON outbound_jobs(status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_domain ON outbound_jobs(recipient_domain);
  CREATE INDEX IF NOT EXISTS idx_jobs_created ON outbound_jobs(created_at);

  CREATE TABLE IF NOT EXISTS inbound_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT,
    from_email TEXT,
    from_name TEXT,
    to_email TEXT,
    subject TEXT,
    text_body TEXT,
    html_body TEXT,
    headers_json TEXT,
    attachments_json TEXT,
    raw_size INTEGER,
    received_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_inbound_to ON inbound_emails(to_email);
  CREATE INDEX IF NOT EXISTS idx_inbound_from ON inbound_emails(from_email);
  CREATE INDEX IF NOT EXISTS idx_inbound_received ON inbound_emails(received_at);

  CREATE TABLE IF NOT EXISTS dkim_keys (
    domain TEXT PRIMARY KEY,
    selector TEXT NOT NULL,
    private_key TEXT NOT NULL,
    public_key TEXT NOT NULL,
    txt_record_name TEXT NOT NULL,
    txt_record_value TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS suppression_list (
    email TEXT PRIMARY KEY,
    reason TEXT NOT NULL, -- 'bounce', 'unsubscribe', 'complaint', 'manual'
    details TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_suppression_reason ON suppression_list(reason);

  CREATE TABLE IF NOT EXISTS hosted_domains (
    domain TEXT PRIMARY KEY,
    selector TEXT NOT NULL DEFAULT 'default',
    is_verified INTEGER DEFAULT 0,
    inbound_enabled INTEGER DEFAULT 1,
    outbound_enabled INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL
  );
`);

module.exports = db;
