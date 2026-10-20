const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const { inboundCollection } = require('./db');

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
        size: 25 * 1024 * 1024, // 25 MB max email size

        onConnect: (session, callback) => {
          callback();
        },

        onMailFrom: (address, session, callback) => {
          callback();
        },

        onRcptTo: (address, session, callback) => {
          callback();
        },

        onData: (stream, session, callback) => {
          simpleParser(stream)
            .then(async parsed => {
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
                const col = inboundCollection();
                await col.insertOne(emailRecord);
                console.log(`[InboundReceiver] 📥 Saved incoming email from ${emailRecord.from_email} to ${emailRecord.to_email}: "${emailRecord.subject}" in MongoDB`);
              } catch (dbErr) {
                console.error(`[InboundReceiver] ✖ Failed to save email into MongoDB:`, dbErr.message);
              }

              callback(null, 'OK: Message received and queued in MongoDB');
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
        console.log(`[InboundReceiver] Inbound SMTP Server listening on ${this.host}:${this.port} (backed by MongoDB)`);
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
    const col = inboundCollection();
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

    const total = await col.countDocuments(filter);
    const emails = await col
      .find(filter)
      .sort({ received_at: -1 })
      .skip(offset)
      .limit(Math.min(limit, 200))
      .toArray();

    return {
      total,
      limit,
      offset,
      emails
    };
  }

  static async getEmail(id) {
    const col = inboundCollection();
    const numId = typeof id === 'string' ? parseInt(id, 10) : id;
    return await col.findOne({
      $or: [{ id: numId }, { message_id: id }]
    });
  }

  static async deleteEmail(id) {
    const col = inboundCollection();
    const numId = typeof id === 'string' ? parseInt(id, 10) : id;
    const result = await col.deleteOne({
      $or: [{ id: numId }, { message_id: id }]
    });
    return result.deletedCount > 0;
  }

  static async clearInbox() {
    const col = inboundCollection();
    const result = await col.deleteMany({});
    return result.deletedCount;
  }

  static async getStats() {
    const col = inboundCollection();
    const total = await col.estimatedDocumentCount();
    return { total };
  }
}

module.exports = InboundReceiver;
