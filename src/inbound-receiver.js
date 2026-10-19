const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const db = require('./db');

class InboundReceiver {
  constructor(options = {}) {
    this.port = options.port || 2525;
    this.host = options.host || '0.0.0.0';
    this.serverName = options.serverName || 'mail.localmta.dev';
    this.allowedDomains = options.allowedDomains || null; // null means accept all
    this.options = options;
    this.server = null;

    this.stmtInsert = db.prepare(`
      INSERT INTO inbound_emails (
        message_id, from_email, from_name, to_email, subject, text_body,
        html_body, headers_json, attachments_json, raw_size, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
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

              this.stmtInsert.run(
                parsed.messageId || null,
                fromVal.address || session.envelope.mailFrom.address || '',
                fromVal.name || '',
                toVal.address || (session.envelope.rcptTo[0] && session.envelope.rcptTo[0].address) || '',
                parsed.subject || '(No Subject)',
                parsed.text || '',
                parsed.html || '',
                JSON.stringify(headersObj),
                JSON.stringify(attachments),
                parsed.text ? parsed.text.length : 0,
                Date.now()
              );

              callback(null, 'OK: Message received');
            })
            .catch(err => {
              console.error('[InboundReceiver] Error parsing email:', err);
              callback(new Error('MIME parse error: ' + err.message));
            });
        }
      });

      this.server.on('error', err => {
        console.error('[InboundReceiver] Server error:', err.message);
      });

      this.server.listen(this.port, this.host, () => {
        console.log(`[InboundReceiver] Inbound SMTP Server listening on ${this.host}:${this.port}`);
        resolve(this.server);
      });
    });
  }

  stop() {
    return new Promise(resolve => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Search and paginate incoming emails.
   */
  static getInbox({ limit = 50, offset = 0, to = null, from = null, query = null }) {
    let sql = 'SELECT id, message_id, from_email, from_name, to_email, subject, raw_size, received_at FROM inbound_emails WHERE 1=1';
    const params = [];

    if (to) {
      sql += ' AND to_email LIKE ?';
      params.push(`%${to}%`);
    }
    if (from) {
      sql += ' AND from_email LIKE ?';
      params.push(`%${from}%`);
    }
    if (query) {
      sql += ' AND (subject LIKE ? OR text_body LIKE ?)';
      params.push(`%${query}%`, `%${query}%`);
    }

    sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return db.prepare(sql).all(...params);
  }

  static getEmail(id) {
    const row = db.prepare('SELECT * FROM inbound_emails WHERE id = ?').get(id);
    if (!row) return null;

    return {
      ...row,
      headers: row.headers_json ? JSON.parse(row.headers_json) : {},
      attachments: row.attachments_json ? JSON.parse(row.attachments_json) : []
    };
  }

  static deleteEmail(id) {
    const res = db.prepare('DELETE FROM inbound_emails WHERE id = ?').run(id);
    return res.changes > 0;
  }
}

module.exports = InboundReceiver;
