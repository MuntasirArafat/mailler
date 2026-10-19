const { SMTPServer } = require('smtp-server');
const DirectMtaSender = require('./direct-sender');
const historyStore = require('./history-store');
const dkimManager = require('./dkim-manager');

/**
 * LocalSmtpRelay
 * Listens locally on port 2525 and accepts emails from localhost,
 * immediately relaying them DIRECTLY to the recipient MX servers.
 */
class LocalSmtpRelay {
  constructor(options = {}) {
    this.port = options.port || parseInt(process.env.SMTP_RELAY_PORT || '2525', 10);
    this.host = options.host || '127.0.0.1';
    this.heloHost = options.heloHost || 'localhost';
    this.sender = new DirectMtaSender({ heloHost: this.heloHost });
    this.server = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = new SMTPServer({
        name: this.heloHost,
        banner: 'Node.js Direct MTA Relay ready',
        authOptional: true,
        disabledCommands: ['AUTH'], // No auth needed on loopback
        size: 25 * 1024 * 1024, // 25MB max
        onConnect: (session, callback) => {
          callback();
        },
        onMailFrom: (address, session, callback) => {
          callback(); // Accept any sender
        },
        onRcptTo: (address, session, callback) => {
          callback(); // Accept any recipient
        },
        onData: (stream, session, callback) => {
          const chunks = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', async () => {
            const rawMime = Buffer.concat(chunks);
            const from = session.envelope.mailFrom.address;
            const toList = session.envelope.rcptTo.map(r => r.address);

            const deliveryLogs = [];
            const onLog = (entry) => deliveryLogs.push(entry);

            try {
              // Check if DKIM key exists for sender domain
              const parsed = DirectMtaSender.parseEmail(from);
              const dkimKey = parsed.domain ? dkimManager.getKey(parsed.domain) : null;

              // Deliver raw buffer directly to recipient MX servers
              const result = await this.sender.sendMail({
                from,
                to: toList,
                subject: '(Raw SMTP Relay)',
                dkim: dkimKey ? {
                  domainName: dkimKey.domain,
                  keySelector: dkimKey.selector,
                  privateKey: dkimKey.privateKey
                } : null
              }, onLog);

              // Store in delivery history
              historyStore.addRecord({
                source: 'SMTP-Relay (port ' + this.port + ')',
                from,
                to: toList,
                subject: '(Relayed via local SMTP)',
                success: result.success,
                results: result.results,
                logs: deliveryLogs
              });

              if (result.success) {
                callback(null, 'OK: Message delivered directly to MX');
              } else {
                callback(new Error('Direct delivery failed for all recipients'));
              }
            } catch (err) {
              historyStore.addRecord({
                source: 'SMTP-Relay (port ' + this.port + ')',
                from,
                to: toList,
                subject: '(Relayed via local SMTP)',
                success: false,
                error: err.message,
                logs: deliveryLogs
              });
              callback(new Error('MTA error: ' + err.message));
            }
          });
        }
      });

      this.server.on('error', (err) => {
        console.error('[SMTP-Relay Server Error]', err.message);
      });

      this.server.listen(this.port, this.host, () => {
        console.log(`[SMTP Relay] Listening on ${this.host}:${this.port} (Relays directly to recipient MX)`);
        resolve(this.server);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

module.exports = LocalSmtpRelay;
