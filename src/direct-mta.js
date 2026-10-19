const net = require('net');
const tls = require('tls');
const dns = require('dns').promises;
const os = require('os');

class DirectMta {
  constructor(options = {}) {
    this.heloHost = options.heloHost || os.hostname() || 'mail.localmta.dev';
    this.connectionTimeout = options.connectionTimeout || 25000;
    this.maxMessagesPerConnection = options.maxMessagesPerConnection || 50;
    this.pool = new Map(); // host -> { socket, isTls, messagesSent, inUse, lastUsed }

    // Periodically prune idle pooled connections
    setInterval(() => this.pruneIdleConnections(), 10000);
  }

  pruneIdleConnections() {
    const now = Date.now();
    for (const [host, conn] of this.pool.entries()) {
      if (!conn.inUse && (now - conn.lastUsed > 15000 || conn.socket.destroyed)) {
        try {
          conn.socket.write('QUIT\r\n');
          conn.socket.end();
        } catch (e) {}
        this.pool.delete(host);
      }
    }
  }

  async resolveMx(domain) {
    try {
      const records = await dns.resolveMx(domain);
      if (records && records.length > 0) {
        records.sort((a, b) => a.priority - b.priority);
        return records.map(r => r.exchange);
      }
    } catch (e) {}

    // Fallback to domain A record as per RFC 5321
    try {
      const a = await dns.resolve4(domain);
      if (a && a.length > 0) return [domain];
    } catch (e) {}

    throw new Error(`No MX or A records found for domain "${domain}"`);
  }

  async deliver(from, to, mimeBuffer) {
    const domain = to.split('@')[1].toLowerCase().trim();
    const mxHosts = await this.resolveMx(domain);

    let lastError = null;

    for (const host of mxHosts) {
      try {
        return await this.deliverToHost(host, from, to, mimeBuffer);
      } catch (err) {
        lastError = err;
        // Try next MX host in priority list
      }
    }

    throw lastError || new Error(`Failed to deliver to any MX host for ${domain}`);
  }

  deliverToHost(host, from, to, mimeBuffer) {
    return new Promise((resolve, reject) => {
      let socket = null;
      let buffer = '';
      let timer = null;
      let settled = false;
      let isTls = false;
      let state = 'GREETING'; // GREETING, EHLO1, STARTTLS, EHLO2, MAIL, RCPT, DATA, PAYLOAD, QUIT

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (socket && !socket.destroyed) socket.destroy();
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const succeed = (resp) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(resp);
      };

      const resetTimeout = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          fail(new Error(`Connection to ${host}:25 timed out after ${this.connectionTimeout}ms`));
        }, this.connectionTimeout);
      };

      const send = (cmd) => {
        if (!socket || socket.destroyed) return;
        resetTimeout();
        socket.write(cmd);
      };

      const processResponse = (code, lines) => {
        const fullResp = lines.join(' ');

        if (code >= 400 && state !== 'QUIT') {
          return fail(new Error(`SMTP error ${code} from ${host}: ${fullResp}`));
        }

        switch (state) {
          case 'GREETING':
            if (code === 220) {
              state = 'EHLO1';
              send(`EHLO ${this.heloHost}\r\n`);
            } else {
              fail(new Error(`Bad greeting from ${host}: ${code} ${fullResp}`));
            }
            break;

          case 'EHLO1':
            if (code === 250) {
              const supportsTls = lines.some(l => l.toUpperCase().includes('STARTTLS'));
              if (supportsTls && !isTls) {
                state = 'STARTTLS';
                send('STARTTLS\r\n');
              } else {
                state = 'MAIL';
                send(`MAIL FROM:<${from}>\r\n`);
              }
            } else {
              // Fallback to HELO
              state = 'HELO_FALLBACK';
              send(`HELO ${this.heloHost}\r\n`);
            }
            break;

          case 'HELO_FALLBACK':
            state = 'MAIL';
            send(`MAIL FROM:<${from}>\r\n`);
            break;

          case 'STARTTLS':
            if (code === 220) {
              upgradeToTls();
            } else {
              state = 'MAIL';
              send(`MAIL FROM:<${from}>\r\n`);
            }
            break;

          case 'EHLO2':
            state = 'MAIL';
            send(`MAIL FROM:<${from}>\r\n`);
            break;

          case 'MAIL':
            if (code === 250) {
              state = 'RCPT';
              send(`RCPT TO:<${to}>\r\n`);
            } else {
              fail(new Error(`MAIL FROM rejected: ${code} ${fullResp}`));
            }
            break;

          case 'RCPT':
            if (code === 250 || code === 251) {
              state = 'DATA';
              send('DATA\r\n');
            } else {
              fail(new Error(`RCPT TO rejected: ${code} ${fullResp}`));
            }
            break;

          case 'DATA':
            if (code === 354) {
              state = 'PAYLOAD';
              sendPayload();
            } else {
              fail(new Error(`DATA command rejected: ${code} ${fullResp}`));
            }
            break;

          case 'PAYLOAD':
            if (code === 250) {
              state = 'QUIT';
              send('QUIT\r\n');
              succeed({ host, response: fullResp, tls: isTls });
            } else {
              fail(new Error(`Message data rejected: ${code} ${fullResp}`));
            }
            break;

          case 'QUIT':
            cleanup();
            break;
        }
      };

      const sendPayload = () => {
        let rawStr = mimeBuffer.toString('binary');
        rawStr = rawStr.replace(/\r?\n/g, '\r\n');
        rawStr = rawStr.replace(/\r\n\./g, '\r\n..');
        if (rawStr.startsWith('.')) rawStr = '.' + rawStr;
        if (!rawStr.endsWith('\r\n')) rawStr += '\r\n';
        rawStr += '.\r\n';
        socket.write(Buffer.from(rawStr, 'binary'));
      };

      const attachListeners = (sock) => {
        sock.on('data', (chunk) => {
          resetTimeout();
          buffer += chunk.toString('utf8');

          while (buffer.includes('\n')) {
            const lineIdx = buffer.indexOf('\n');
            const line = buffer.substring(0, lineIdx + 1);
            buffer = buffer.substring(lineIdx + 1);

            const match = line.match(/^(\d{3})([ -])(.*)$/);
            if (match) {
              const code = parseInt(match[1], 10);
              const isContinuation = match[2] === '-';

              if (!sock._replyLines) sock._replyLines = [];
              sock._replyLines.push(line.trim());

              if (!isContinuation) {
                const complete = sock._replyLines;
                sock._replyLines = [];
                processResponse(code, complete);
              }
            }
          }
        });

        sock.on('error', (err) => fail(err));
        sock.on('close', () => {
          if (!settled && state !== 'QUIT') {
            fail(new Error(`Connection to ${host}:25 closed prematurely`));
          }
        });
      };

      const upgradeToTls = () => {
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        socket.removeAllListeners('close');

        const secureSocket = tls.connect({
          socket,
          host,
          servername: host,
          rejectUnauthorized: false // Opportunistic TLS for MTA delivery
        }, () => {
          isTls = true;
          socket = secureSocket;
          attachListeners(socket);
          state = 'EHLO2';
          send(`EHLO ${this.heloHost}\r\n`);
        });

        secureSocket.on('error', (err) => fail(err));
      };

      socket = net.createConnection(25, host);
      resetTimeout();
      attachListeners(socket);
    });
  }
}

module.exports = DirectMta;
