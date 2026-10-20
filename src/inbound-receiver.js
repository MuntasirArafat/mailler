const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const { InboundMessage } = require('./db');

class InboundReceiver {
  constructor(options = {}) {
    this.port = options.port || 25;
    this.host = options.host || '0.0.0.0';
    this.serverName = options.serverName || 'mail.exauraa.com';
    this.server = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = new SMTPServer({
        name: this.serverName,
        banner: `${this.serverName} ESMTP Direct Mail Receiver Ready`,
        authOptional: true,
        disabledCommands: ['AUTH'],
        disableReverseLookup: true, // Prevents DNS reverse lookup delays on incoming connections
        maxClients: 250,            // Handle high concurrent inbound connections
        socketTimeout: 30000,       // 30s inactivity timeout
        size: 25 * 1024 * 1024,     // 25 MB max email size

        onConnect: (session, callback) => {
          return callback();
        },

        onMailFrom: (address, session, callback) => {
          return callback();
        },

        onRcptTo: (address, session, callback) => {
          return callback();
        },

        onData: (stream, session, callback) => {
          stream.on('error', err => {
            console.error('[InboundReceiver] Inbound stream error:', err.message);
          });

          simpleParser(stream)
            .then(async parsed => {
              const fromVal = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
              const toVal = (parsed.to && parsed.to.value && parsed.to.value[0]) || {};

              const attachments = (parsed.attachments || []).map(att => {
                let contentBase64 = null;
                // Safeguard against MongoDB 16MB document size limit (only serialize under 8MB)
                if (att.content && att.content.length <= 8 * 1024 * 1024) {
                  contentBase64 = att.content.toString('base64');
                }
                return {
                  filename: att.filename || 'attachment',
                  contentType: att.contentType,
                  size: att.size,
                  contentBase64
                };
              });

              const headersObj = {};
              if (parsed.headers) {
                for (const [key, val] of parsed.headers) {
                  headersObj[key] = val;
                }
              }

              const emailRecord = {
                id: Date.now(),
                message_id: parsed.messageId || null,
                from_email: fromVal.address || (session.envelope.mailFrom && session.envelope.mailFrom.address) || '',
                from_name: fromVal.name || '',
                to_email: toVal.address || (session.envelope.rcptTo[0] && session.envelope.rcptTo[0].address) || '',
                subject: parsed.subject || '(No Subject)',
                text_body: parsed.text || '',
                html_body: parsed.html || '',
                headers: headersObj,
                attachments,
                raw_size: parsed.text ? parsed.text.length : 0,
                status: 'received',
                received_at: new Date()
              };

              try {
                await InboundMessage.create(emailRecord);
                console.log(`[InboundReceiver] 📥 Saved incoming email from ${emailRecord.from_email} to ${emailRecord.to_email}: "${emailRecord.subject}" in Mongoose`);
              } catch (dbErr) {
                console.error(`[InboundReceiver] ✖ Failed to save email into Mongoose:`, dbErr.message);
              }

              callback(null, 'OK: Message received and saved in database');
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
        console.log(`[InboundReceiver] Inbound SMTP Server listening on ${this.host}:${this.port} (backed by Mongoose InboundMessage model)`);
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

  static async getInbox({ limit = 50, offset = 0, to = null, from = null, query = null } = {}) {
    const filter = {};

    if (to) {
      filter.to_email = { $regex: to, $options: 'i' };
    }
    if (from) {
      filter.from_email = { $regex: from, $options: 'i' };
    }
    if (query) {
      filter.$or = [
        { subject: { $regex: query, $options: 'i' } },
        { text_body: { $regex: query, $options: 'i' } },
        { from_email: { $regex: query, $options: 'i' } }
      ];
    }

    const total = await InboundMessage.countDocuments(filter);
    const emails = await InboundMessage
      .find(filter)
      .sort({ received_at: -1 })
      .skip(offset)
      .limit(Math.min(limit, 200))
      .lean();

    return {
      total,
      limit,
      offset,
      emails
    };
  }

  static async getEmail(id) {
    const numId = typeof id === 'string' && /^\d+$/.test(id) ? parseInt(id, 10) : (typeof id === 'number' ? id : null);
    const filter = numId ? { $or: [{ id: numId }, { message_id: id }] } : { message_id: id };
    return await InboundMessage.findOne(filter).lean();
  }

  static async deleteEmail(id) {
    const numId = typeof id === 'string' && /^\d+$/.test(id) ? parseInt(id, 10) : (typeof id === 'number' ? id : null);
    const filter = numId ? { $or: [{ id: numId }, { message_id: id }] } : { message_id: id };
    const result = await InboundMessage.deleteOne(filter);
    return result.deletedCount > 0;
  }

  static async clearInbox() {
    const result = await InboundMessage.deleteMany({});
    return result.deletedCount;
  }

  static async getStats() {
    const total = await InboundMessage.countDocuments({});
    return { total };
  }
}

module.exports = InboundReceiver;
