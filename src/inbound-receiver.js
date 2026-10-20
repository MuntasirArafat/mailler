const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');

// In-memory buffer of recent emails for inspection/debugging if inbound is enabled
const recentInbox = [];
const MAX_INBOX = 100;

class InboundReceiver {
  constructor(options = {}) {
    this.port = options.port || 2525;
    this.host = options.host || '0.0.0.0';
    this.serverName = options.serverName || 'mail.localmta.dev';
    this.options = options;
    this.server = null;
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
        size: 25 * 1024 * 1024, // 25MB max size

        onConnect: (session, callback) => callback(),

        onMailFrom: (address, session, callback) => callback(),

        onRcptTo: (address, session, callback) => {
          const DomainManager = require('./domain-manager');
          const hosted = DomainManager.listDomains();

          if (hosted.length > 0) {
            const domain = address.address.split('@')[1].toLowerCase();
            if (!DomainManager.isDomainHosted(domain)) {
              return callback(new Error(`550 5.7.1 Domain ${domain} not hosted on this server`));
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
              for (const [key, val] of parsed.headers) {
                headersObj[key] = val;
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

              recentInbox.unshift(emailRecord);
              if (recentInbox.length > MAX_INBOX) {
                recentInbox.pop();
              }

              callback(null, 'OK: Message received');
            })
            .catch(err => {
              console.error('[InboundReceiver] Error parsing email:', err);
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

  static getInbox({ limit = 50, offset = 0 } = {}) {
    return recentInbox.slice(offset, offset + limit);
  }

  static getEmail(id) {
    return recentInbox.find(e => e.id === id) || null;
  }

  static deleteEmail(id) {
    const idx = recentInbox.findIndex(e => e.id === id);
    if (idx !== -1) {
      recentInbox.splice(idx, 1);
      return true;
    }
    return false;
  }
}

module.exports = InboundReceiver;
