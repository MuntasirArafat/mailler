const mongoose = require('mongoose');

// Determine MongoDB Mode: 'local' (default) or 'remote'
function getMongoMode() {
  return (process.env.MONGO_MODE || 'local').toLowerCase().trim();
}

function getMongoUri() {
  const mode = getMongoMode();
  if (mode === 'remote') {
    return process.env.MONGO_REMOTE_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/mailserver';
  }
  // Default: local
  return process.env.MONGO_LOCAL_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/mailserver';
}

// -----------------------------------------------------------------------------
// Database Models
// -----------------------------------------------------------------------------

// 1. MailJob Model (Outbound Queue, Atomic Workers & Exponential Backoff Retries)
const MailJobSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    recipient: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ['queued', 'processing', 'completed', 'failed'],
      default: 'queued',
      index: true
    },
    attempts: { type: Number, default: 0 },
    maxRetries: { type: Number, default: 5 },
    nextRetryAt: { type: Date, default: Date.now, index: true },
    priority: { type: Number, default: 0, index: true },
    payload: {
      from: { type: String, required: true },
      to: { type: String, required: true },
      name: { type: String, default: null },
      subject: { type: String, default: '' },
      text: { type: String, default: '' },
      html: { type: String, default: '' },
      unsubscribeUrl: { type: String, default: null },
      unsubscribeEmail: { type: String, default: null },
      headers: { type: mongoose.Schema.Types.Mixed, default: {} },
      dkim: { type: mongoose.Schema.Types.Mixed, default: null }
    },
    lastAttemptAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    errorHistory: [
      {
        attempt: Number,
        error: String,
        timestamp: { type: Date, default: Date.now }
      }
    ],
    response: { type: String, default: null },
    messageId: { type: String, default: null },
    host: { type: String, default: null },
    durationMs: { type: Number, default: null },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null }
  },
  {
    timestamps: true
  }
);

// High-performance compound indexes
MailJobSchema.index({ status: 1, nextRetryAt: 1, priority: -1 });
MailJobSchema.index({ createdAt: -1 });

// 2. InboundMessage Model (Received Emails via Port 25, Parsed MIME & Attachments)
const InboundMessageSchema = new mongoose.Schema(
  {
    id: { type: Number, required: true, unique: true, index: true },
    message_id: { type: String, default: null, index: true },
    from_email: { type: String, default: '', index: true },
    from_name: { type: String, default: '' },
    to_email: { type: String, default: '', index: true },
    subject: { type: String, default: '(No Subject)' },
    text_body: { type: String, default: '' },
    html_body: { type: String, default: '' },
    headers: { type: mongoose.Schema.Types.Mixed, default: {} },
    attachments: [
      {
        filename: String,
        contentType: String,
        size: Number,
        contentBase64: String
      }
    ],
    raw_size: { type: Number, default: 0 },
    status: { type: String, default: 'received', index: true },
    received_at: { type: Date, default: Date.now, index: true }
  },
  {
    timestamps: true
  }
);

InboundMessageSchema.index({ to_email: 1, received_at: -1 });
InboundMessageSchema.index({ from_email: 1, received_at: -1 });

// Register models safely
const MailJob = mongoose.models.MailJob || mongoose.model('MailJob', MailJobSchema);
const InboundMessage = mongoose.models.InboundMessage || mongoose.model('InboundMessage', InboundMessageSchema);

// -----------------------------------------------------------------------------
// Connection Management
// -----------------------------------------------------------------------------

async function connect(customUri = null) {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  const mode = getMongoMode();
  const uri = customUri || getMongoUri();
  const maskedUri = uri.replace(/:([^:@]{3,})@/, ':****@');

  console.log(`[Mongoose] Connecting in [${mode.toUpperCase()}] mode to: ${maskedUri}`);

  await mongoose.connect(uri, {
    maxPoolSize: 50,
    minPoolSize: 5,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000
  });

  console.log(`[Mongoose] ✔ Connected successfully in [${mode.toUpperCase()}] mode to database: ${mongoose.connection.name}`);
  return mongoose.connection;
}

function isConnected() {
  return mongoose.connection.readyState === 1;
}

async function close() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    console.log('[Mongoose] Disconnected.');
  }
}

module.exports = {
  mongoose,
  connect,
  close,
  isConnected,
  getMongoMode,
  getMongoUri,
  MailJob,
  InboundMessage
};
