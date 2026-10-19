const net = require('net');
const tls = require('tls');
const dns = require('dns').promises;
const os = require('os');
const nodemailer = require('nodemailer');

/**
 * DirectMtaSender
 * Direct-to-MX Mail Transfer Agent (MTA)
 * Discovers recipient MX records and performs raw SMTP delivery directly to destination servers.
 */
class DirectMtaSender {
  constructor(options = {}) {
    this.defaultHelo = options.heloHost || os.hostname() || 'localhost';
    this.connectionTimeout = options.connectionTimeout || 25000;
    this.socketTimeout = options.socketTimeout || 20000;
    this.enableTls = options.enableTls !== false;
    this.dkim = options.dkim || null;
  }

  /**
   * Parse email addresses to extract domain and clean address.
   */
  static parseEmail(address) {
    if (!address) return { address: '', domain: '', name: '' };
    const match = address.match(/(?:(.*?)<)?([^<>@\s]+@[^<>@\s]+)>?/);
    if (!match) return { address: address.trim(), domain: address.split('@')[1] || '', name: '' };
    const cleanAddr = match[2].trim().toLowerCase();
    const domain = cleanAddr.split('@')[1] || '';
    const name = (match[1] || '').trim().replace(/^["']|["']$/g, '');
    return { address: cleanAddr, domain, name };
  }

  /**
   * Resolve MX records for a domain, sorted by priority.
   * If no MX record exists, falls back to domain A record as per RFC 5321.
   */
  async resolveMx(domain) {
    try {
      const records = await dns.resolveMx(domain);
      if (records && records.length > 0) {
        records.sort((a, b) => a.priority - b.priority);
        return records.map(r => ({ host: r.exchange, priority: r.priority }));
      }
    } catch (err) {
      // If code is ENODATA, ENOTFOUND, or NXDOMAIN, fallback to A record
    }

    // RFC 5321 fallback: if no MX, check A record
    try {
      const aRecords = await dns.resolve4(domain);
      if (aRecords && aRecords.length > 0) {
        return [{ host: domain, priority: 0 }];
      }
    } catch (err) {
      // No A record
    }

    throw new Error(`No MX or A records found for domain: ${domain}`);
  }

  /**
   * Build RFC 5322 MIME message buffer with optional DKIM signature.
   */
  async buildMimeMessage(mailOptions) {
    const transportConfig = {
      streamTransport: true,
      buffer: true
    };

    const dkimConfig = mailOptions.dkim || this.dkim;
    if (dkimConfig && dkimConfig.domainName && dkimConfig.keySelector && dkimConfig.privateKey) {
      transportConfig.dkim = {
        domainName: dkimConfig.domainName,
        keySelector: dkimConfig.keySelector,
        privateKey: dkimConfig.privateKey,
        cacheDir: false
      };
    }

    const mailer = nodemailer.createTransport(transportConfig);
    const info = await mailer.sendMail({
      from: mailOptions.from,
      to: mailOptions.to,
      cc: mailOptions.cc,
      bcc: mailOptions.bcc,
      subject: mailOptions.subject,
      text: mailOptions.text,
      html: mailOptions.html,
      attachments: mailOptions.attachments,
      headers: mailOptions.headers,
      replyTo: mailOptions.replyTo
    });

    return info.message;
  }

  /**
   * Send mail directly to recipient(s).
   * Automatically groups recipients by domain and connects to each domain's MX.
   */
  async sendMail(mailOptions, onLog) {
    const log = (msg, level = 'info') => {
      const entry = { timestamp: new Date().toISOString(), message: msg, level };
      if (typeof onLog === 'function') {
        onLog(entry);
      }
      return entry;
    };

    const rawLogs = [];
    const collector = (entry) => {
      rawLogs.push(entry);
      if (typeof onLog === 'function') onLog(entry);
    };

    const parsedSender = DirectMtaSender.parseEmail(mailOptions.from);
    if (!parsedSender.address) {
      throw new Error('Valid "from" address is required');
    }

    // Determine HELO host (use domain of sender or custom or default)
    const heloHost = mailOptions.heloHost || this.defaultHelo || (parsedSender.domain ? `mail.${parsedSender.domain}` : 'localhost');

    // Parse recipient list
    const recipientsList = Array.isArray(mailOptions.to) ? mailOptions.to : [mailOptions.to];
    if (mailOptions.cc) {
      recipientsList.push(...(Array.isArray(mailOptions.cc) ? mailOptions.cc : [mailOptions.cc]));
    }
    if (mailOptions.bcc) {
      recipientsList.push(...(Array.isArray(mailOptions.bcc) ? mailOptions.bcc : [mailOptions.bcc]));
    }

    const domainGroups = {};
    for (const rawTo of recipientsList) {
      const parsed = DirectMtaSender.parseEmail(rawTo);
      if (!parsed.address || !parsed.domain) continue;
      if (!domainGroups[parsed.domain]) {
        domainGroups[parsed.domain] = [];
      }
      domainGroups[parsed.domain].push(parsed.address);
    }

    if (Object.keys(domainGroups).length === 0) {
      throw new Error('No valid recipient email addresses found');
    }

    collector({
      timestamp: new Date().toISOString(),
      level: 'info',
      message: `Starting direct MTA delivery for sender <${parsedSender.address}> to ${recipientsList.length} recipient(s)`
    });

    // Generate compliant MIME message buffer (with DKIM if available)
    collector({
      timestamp: new Date().toISOString(),
      level: 'info',
      message: `Compiling RFC 5322 MIME message (DKIM: ${mailOptions.dkim || this.dkim ? 'Enabled' : 'Disabled'})...`
    });
    const mimeBuffer = await this.buildMimeMessage(mailOptions);

    const deliveryResults = [];

    // Deliver to each domain's MX
    for (const [domain, recipients] of Object.entries(domainGroups)) {
      collector({
        timestamp: new Date().toISOString(),
        level: 'info',
        message: `[${domain}] Looking up DNS MX records...`
      });

      let mxList;
      try {
        mxList = await this.resolveMx(domain);
        collector({
          timestamp: new Date().toISOString(),
          level: 'info',
          message: `[${domain}] Found ${mxList.length} MX host(s): ${mxList.map(m => `${m.host} (p:${m.priority})`).join(', ')}`
        });
      } catch (err) {
        collector({
          timestamp: new Date().toISOString(),
          level: 'error',
          message: `[${domain}] DNS Resolution failed: ${err.message}`
        });
        deliveryResults.push({
          domain,
          recipients,
          success: false,
          error: `DNS MX lookup failed: ${err.message}`
        });
        continue;
      }

      let delivered = false;
      let lastError = null;

      // Try MX servers in order of priority
      for (const mx of mxList) {
        collector({
          timestamp: new Date().toISOString(),
          level: 'info',
          message: `[${domain}] Connecting to MX: ${mx.host}:25...`
        });

        try {
          const result = await this.deliverDirectSmtp({
            host: mx.host,
            port: 25,
            heloHost,
            from: parsedSender.address,
            recipients,
            mimeBuffer,
            onLog: collector
          });

          deliveryResults.push({
            domain,
            mxHost: mx.host,
            recipients,
            success: true,
            response: result.response,
            tlsUsed: result.tlsUsed
          });

          collector({
            timestamp: new Date().toISOString(),
            level: 'success',
            message: `[${domain}] Message successfully accepted by ${mx.host}: ${result.response}`
          });

          delivered = true;
          break;
        } catch (err) {
          lastError = err;
          collector({
            timestamp: new Date().toISOString(),
            level: 'warn',
            message: `[${domain}] Delivery failed to ${mx.host}:25 -> ${err.message}`
          });
          // Continue to next MX in list
        }
      }

      if (!delivered) {
        deliveryResults.push({
          domain,
          recipients,
          success: false,
          error: lastError ? lastError.message : 'All MX hosts unreachable'
        });
        collector({
          timestamp: new Date().toISOString(),
          level: 'error',
          message: `[${domain}] Failed to deliver to any MX server. Last error: ${lastError ? lastError.message : 'Unknown'}`
        });
      }
    }

    const overallSuccess = deliveryResults.some(r => r.success);
    return {
      success: overallSuccess,
      results: deliveryResults,
      logs: rawLogs
    };
  }

  /**
   * Deliver to a single MX server over raw TCP/TLS socket.
   */
  deliverDirectSmtp({ host, port = 25, heloHost, from, recipients, mimeBuffer, onLog }) {
    return new Promise((resolve, reject) => {
      let socket = null;
      let isTls = false;
      let tlsUsed = false;
      let buffer = '';
      let timer = null;
      let settled = false;

      const log = (msg, level = 'info') => {
        if (typeof onLog === 'function') {
          onLog({
            timestamp: new Date().toISOString(),
            level,
            message: `[${host}:25] ${msg}`
          });
        }
      };

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (socket && !socket.destroyed) {
          socket.destroy();
        }
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const succeed = (data) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(data);
      };

      // Reset timer on activity
      const resetTimeout = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          fail(new Error(`Connection timed out after ${this.connectionTimeout}ms`));
        }, this.connectionTimeout);
      };

      // SMTP State Machine
      let state = 'GREETING'; // GREETING, EHLO1, STARTTLS, EHLO2, MAIL_FROM, RCPT_TO, DATA_READY, DATA_SENT, QUIT
      let currentRcptIdx = 0;
      let acceptedRcpts = [];
      let lastServerResponse = '';
      let capabilities = [];

      const sendCommand = (cmd, mask = false) => {
        if (!socket || socket.destroyed) return;
        resetTimeout();
        log(`>>> ${mask ? '***' : cmd.trim()}`, 'outbound');
        socket.write(cmd);
      };

      const processResponse = (code, lines) => {
        lastServerResponse = lines.join(' ');
        log(`<<< ${lines.join('\n<<< ')}`, 'inbound');

        // Check for 4xx or 5xx temporary or permanent errors
        if (code >= 400 && state !== 'QUIT') {
          if (state === 'RCPT_TO') {
            log(`Recipient rejected: ${recipients[currentRcptIdx]} (${lastServerResponse})`, 'warn');
            currentRcptIdx++;
            if (currentRcptIdx < recipients.length) {
              sendCommand(`RCPT TO:<${recipients[currentRcptIdx]}>\r\n`);
              return;
            } else if (acceptedRcpts.length === 0) {
              sendCommand('QUIT\r\n');
              state = 'QUIT';
              return fail(new Error(`All recipients rejected by server: ${lastServerResponse}`));
            } else {
              // Proceed with accepted recipients
              state = 'DATA_READY';
              sendCommand('DATA\r\n');
              return;
            }
          }
          return fail(new Error(`SMTP error (${code}): ${lastServerResponse}`));
        }

        switch (state) {
          case 'GREETING':
            if (code === 220) {
              state = 'EHLO1';
              sendCommand(`EHLO ${heloHost}\r\n`);
            } else {
              fail(new Error(`Unexpected greeting code: ${code} ${lastServerResponse}`));
            }
            break;

          case 'EHLO1':
            if (code === 250) {
              capabilities = lines.map(l => l.replace(/^\d{3}[ -]/, '').trim());
              const hasStartTls = capabilities.some(c => c.toUpperCase().includes('STARTTLS'));

              if (this.enableTls && hasStartTls && !isTls) {
                log('Server supports STARTTLS. Upgrading to TLS encrypted connection...', 'info');
                state = 'STARTTLS';
                sendCommand('STARTTLS\r\n');
              } else {
                // No TLS or already TLS
                state = 'MAIL_FROM';
                sendCommand(`MAIL FROM:<${from}>\r\n`);
              }
            } else {
              // Fallback to HELO if EHLO rejected
              log(`EHLO rejected, attempting HELO ${heloHost}`, 'warn');
              state = 'HELO_FALLBACK';
              sendCommand(`HELO ${heloHost}\r\n`);
            }
            break;

          case 'HELO_FALLBACK':
            if (code === 250) {
              state = 'MAIL_FROM';
              sendCommand(`MAIL FROM:<${from}>\r\n`);
            } else {
              fail(new Error(`HELO rejected: ${code} ${lastServerResponse}`));
            }
            break;

          case 'STARTTLS':
            if (code === 220) {
              log('STARTTLS accepted by server. Performing TLS handshake...', 'info');
              upgradeToTls();
            } else {
              log(`STARTTLS failed (${code}). Continuing in plaintext...`, 'warn');
              state = 'MAIL_FROM';
              sendCommand(`MAIL FROM:<${from}>\r\n`);
            }
            break;

          case 'EHLO2':
            if (code === 250) {
              state = 'MAIL_FROM';
              sendCommand(`MAIL FROM:<${from}>\r\n`);
            } else {
              fail(new Error(`Post-TLS EHLO failed: ${code} ${lastServerResponse}`));
            }
            break;

          case 'MAIL_FROM':
            if (code === 250) {
              state = 'RCPT_TO';
              currentRcptIdx = 0;
              acceptedRcpts = [];
              sendCommand(`RCPT TO:<${recipients[currentRcptIdx]}>\r\n`);
            } else {
              fail(new Error(`MAIL FROM rejected: ${code} ${lastServerResponse}`));
            }
            break;

          case 'RCPT_TO':
            if (code === 250 || code === 251) {
              acceptedRcpts.push(recipients[currentRcptIdx]);
            }
            currentRcptIdx++;
            if (currentRcptIdx < recipients.length) {
              sendCommand(`RCPT TO:<${recipients[currentRcptIdx]}>\r\n`);
            } else {
              if (acceptedRcpts.length === 0) {
                sendCommand('QUIT\r\n');
                state = 'QUIT';
                fail(new Error(`No recipients were accepted by server: ${lastServerResponse}`));
              } else {
                state = 'DATA_READY';
                sendCommand('DATA\r\n');
              }
            }
            break;

          case 'DATA_READY':
            if (code === 354) {
              log(`Sending message payload (${mimeBuffer.length} bytes)...`, 'info');
              state = 'DATA_SENT';
              sendDataPayload();
            } else {
              fail(new Error(`DATA command not accepted: ${code} ${lastServerResponse}`));
            }
            break;

          case 'DATA_SENT':
            if (code === 250) {
              log(`Message accepted by server: ${lastServerResponse}`, 'success');
              state = 'QUIT';
              sendCommand('QUIT\r\n');
              succeed({
                response: lastServerResponse,
                acceptedRcpts,
                tlsUsed
              });
            } else {
              fail(new Error(`Message data rejected: ${code} ${lastServerResponse}`));
            }
            break;

          case 'QUIT':
            cleanup();
            break;
        }
      };

      const sendDataPayload = () => {
        // Dot-stuffing and CRLF normalization
        let rawStr = mimeBuffer.toString('binary');
        // Ensure CRLF
        rawStr = rawStr.replace(/\r?\n/g, '\r\n');
        // Dot stuffing: any line beginning with '.' must become '..'
        rawStr = rawStr.replace(/\r\n\./g, '\r\n..');
        if (rawStr.startsWith('.')) {
          rawStr = '.' + rawStr;
        }
        // Ensure trailing CRLF before final dot
        if (!rawStr.endsWith('\r\n')) {
          rawStr += '\r\n';
        }
        rawStr += '.\r\n';

        socket.write(Buffer.from(rawStr, 'binary'));
      };

      const attachSocketListeners = (sock) => {
        sock.on('data', (chunk) => {
          resetTimeout();
          buffer += chunk.toString('utf8');

          while (buffer.includes('\n')) {
            const lineIdx = buffer.indexOf('\n');
            const line = buffer.substring(0, lineIdx + 1);
            buffer = buffer.substring(lineIdx + 1);

            // Match SMTP multi-line code
            // 250-line... (continuation)
            // 250 line... (final)
            const match = line.match(/^(\d{3})([ -])(.*)$/);
            if (match) {
              const code = parseInt(match[1], 10);
              const isContinuation = match[2] === '-';

              if (!sock._replyLines) sock._replyLines = [];
              sock._replyLines.push(line.trim());

              if (!isContinuation) {
                const completeLines = sock._replyLines;
                sock._replyLines = [];
                processResponse(code, completeLines);
              }
            }
          }
        });

        sock.on('error', (err) => {
          log(`Socket error: ${err.message}`, 'error');
          fail(err);
        });

        sock.on('close', () => {
          if (!settled && state !== 'QUIT') {
            fail(new Error('Connection closed prematurely by remote host'));
          }
        });
      };

      const upgradeToTls = () => {
        // Remove listeners from plain socket
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        socket.removeAllListeners('close');

        const tlsOptions = {
          socket,
          host,
          servername: host,
          rejectUnauthorized: false // Opportunistic TLS for mail exchange
        };

        const secureSocket = tls.connect(tlsOptions, () => {
          isTls = true;
          tlsUsed = true;
          const cipher = secureSocket.getCipher();
          const proto = secureSocket.getProtocol();
          log(`TLS connection established: ${proto} ${cipher ? cipher.name : ''}`, 'success');
          socket = secureSocket;
          attachSocketListeners(socket);

          // RFC 3207: Send EHLO again after STARTTLS
          state = 'EHLO2';
          sendCommand(`EHLO ${heloHost}\r\n`);
        });

        secureSocket.on('error', (err) => {
          log(`TLS negotiation error: ${err.message}`, 'error');
          fail(err);
        });
      };

      // Initiate connection
      log(`Opening TCP connection to ${host}:${port}...`, 'info');
      socket = net.createConnection(port, host);
      resetTimeout();

      socket.on('connect', () => {
        log(`TCP connection established to ${host}:${port}`, 'success');
      });

      attachSocketListeners(socket);
    });
  }
}

module.exports = DirectMtaSender;
