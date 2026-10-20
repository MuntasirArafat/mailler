const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');

class InboundReceiver {
  constructor(options = {}) {
    this.port = options.port || parseInt(process.env.INBOUND_PORT || '25', 10);
    this.host = options.host || '0.0.0.0';
    this.serverName = options.serverName || options.heloHost || 'mail.localmta.dev';
    this.options = options;
    this.server = null;
    this.webhookUrl = options.webhookUrl || process.env.WEBHOOK_URL || null;
  }

  static getStorageFile() {
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    return path.join(dataDir, 'inbox.json');
  }

  static loadInbox() {
    const file = this.getStorageFile();
    if (!fs.existsSync(file)) return [];
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return [];
    }
  }

  static saveInbox(list) {
    const file = this.getStorageFile();
    // Keep last 1,000 received emails in persistent storage
    const trimmed = list.slice(0, 1000);
    fs.writeFileSync(file, JSON.stringify(trimmed, null, 2), 'utf8');
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = new SMTPServer({
        name: this.serverName,
        banner: `${this.serverName} Inbound ESMTP Ready`,
        authOptional: true,
        disabledCommands: ['AUTH'],
        hideSTARTTLS: !this.options.key,
        key: this.options.key,
        cert: this.options.cert,
        size: 30 * 1024 * 1024, // 30MB max size

        onConnect: (session, callback) => callback(),

        onMailFrom: (address, session, callback) => callback(),

        onRcptTo: (address, session, callback) => {
          const DomainManager = require('./domain-manager');
          const hosted = DomainManager.listDomains();

          if (hosted.length > 0) {
            const domain = address.address.split('@')[1]?.toLowerCase();
            if (domain && !DomainManager.isDomainHosted(domain)) {
              return callback(new Error(`550 5.7.1 Relay access denied: domain ${domain} not hosted on this server`));
            }
          }
          callback();
        },

        onData: (stream, session, callback) => {
          simpleParser(stream)
            .then(parsed => {
              const fromVal = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
              const toVal = (parsed.to && parsed.to.value && parsed.to.value[0]) || {};

              const attachments = (parsed.attachments || []).map(att => ({
                filename: att.filename || 'attachment',
                contentType: att.contentType,
                size: att.size,
                contentBase64: att.content ? att.content.toString('base64') : null
              }));

              const headersObj = {};
              if (parsed.headers) {
                for (const [key, val] of parsed.headers) {
                  headersObj[key] = val;
                }
              }

              const emailRecord = {
                id: Date.now(),
                message_id: parsed.messageId || null,
                from_email: fromVal.address || session.envelope.mailFrom.address || '',
                from_name: fromVal.name || '',
                to_email: toVal.address || (session.envelope.rcptTo[0] && session.envelope.rcptTo[0].address) || '',
                subject: parsed.subject || '(No Subject)',
                text_body: parsed.text || '',
                html_body: parsed.html || '',
                headers: headersObj,
                attachments,
                raw_size: parsed.text ? parsed.text.length : 0,
                received_at: Date.now()
              };

              // Persist email
              const inbox = InboundReceiver.loadInbox();
              inbox.unshift(emailRecord);
              InboundReceiver.saveInbox(inbox);

              console.log(`[InboundReceiver] 📥 Received email from ${emailRecord.from_email} to ${emailRecord.to_email}: "${emailRecord.subject}"`);

              // Optional Webhook dispatch to centralized system
              if (this.webhookUrl) {
                this.forwardWebhook(emailRecord);
              }

              callback(null, 'OK: Message received');
            })
            .catch(err => {
              console.error('[InboundReceiver] Error parsing incoming email:', err.message);
              callback(new Error('MIME parse error: ' + err.message));
            });
        }
      });

      let isListening = false;
      this.server.on('error', err => {
        console.error('[InboundReceiver] Server error:', err.message);
        if (!isListening) {
          reject(err);
        }
      });

      this.server.listen(this.port, this.host, () => {
        isListening = true;
        console.log(`[InboundReceiver] Inbound SMTP Server listening on ${this.host}:${this.port}`);
        resolve(this.server);
      });
    });
  }

  stop() {
    return new Promise(resolve => {
      if (this.server) {
        try {
          this.server.close(() => resolve());
        } catch (e) {
          resolve();
        }
      } else {
        resolve();
      }
    });
  }

  forwardWebhook(emailRecord) {
    try {
      const url = new URL(this.webhookUrl);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const payload = JSON.stringify(emailRecord);
      const req = client.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': 'MailServer-Inbound-Relay/2.0'
        },
        timeout: 8000
      });

      req.on('error', (err) => {
        console.warn(`[InboundReceiver] Webhook delivery failed: ${err.message}`);
      });
      req.write(payload);
      req.end();
    } catch (e) {
      console.warn(`[InboundReceiver] Webhook error: ${e.message}`);
    }
  }

  static getInbox({ limit = 50, offset = 0, to = null, from = null, query = null } = {}) {
    let inbox = this.loadInbox();
    if (to) {
      const cleanTo = to.toLowerCase();
      inbox = inbox.filter(e => (e.to_email || '').toLowerCase().includes(cleanTo));
    }
    if (from) {
      const cleanFrom = from.toLowerCase();
      inbox = inbox.filter(e => (e.from_email || '').toLowerCase().includes(cleanFrom));
    }
    if (query) {
      const q = query.toLowerCase();
      inbox = inbox.filter(e =>
        (e.subject || '').toLowerCase().includes(q) ||
        (e.text_body || '').toLowerCase().includes(q)
      );
    }
    return inbox.slice(offset, offset + limit);
  }

  static getEmail(id) {
    const inbox = this.loadInbox();
    const numId = typeof id === 'string' ? parseInt(id, 10) : id;
    return inbox.find(e => e.id === numId) || null;
  }

  static deleteEmail(id) {
    const inbox = this.loadInbox();
    const numId = typeof id === 'string' ? parseInt(id, 10) : id;
    const initialLen = inbox.length;
    const filtered = inbox.filter(e => e.id !== numId);
    if (filtered.length !== initialLen) {
      this.saveInbox(filtered);
      return true;
    }
    return false;
  }

  static clearInbox() {
    this.saveInbox([]);
    return true;
  }
}

module.exports = InboundReceiver;
