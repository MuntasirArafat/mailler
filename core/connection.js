const tls = require('tls');
const fs = require('fs');
const path = require('path');
const constants = require('./constants');
const Transaction = require('./transaction');

/**
 * Haraka-style Connection Handler
 * Manages client SMTP session, line-based command dispatch, and hook pipeline.
 */
class Connection {
  constructor(clientSocket, server) {
    this.client = clientSocket;
    this.server = server;
    this.pluginManager = server.pluginManager;

    this.remote_ip = clientSocket.remoteAddress;
    this.remote_port = clientSocket.remotePort;
    this.remote_host = null;
    this.hello = { host: null, verb: null };
    this.tls = { enabled: false, cipher: null };
    this.auth = { user: null };
    this.relaying = false;     // Set by auth or access plugins if client is allowed to relay
    this.notes = {};           // Per-connection plugin storage

    this.transaction = null;
    this.state = 'COMMAND';    // 'COMMAND' or 'DATA'
    this.data_buffer = '';
    this.line_buffer = '';

    this.init();
  }

  log(msg, level = 'info') {
    this.server.emit('log', {
      timestamp: new Date().toISOString(),
      remote: `${this.remote_ip}:${this.remote_port}`,
      uuid: this.transaction ? this.transaction.uuid : '-',
      level,
      message: msg
    });
  }

  init() {
    this.client.setTimeout(60000); // 60s timeout

    this.client.on('data', (chunk) => {
      this.handleData(chunk);
    });

    this.client.on('timeout', () => {
      this.respond(421, '4.4.2 Connection timed out');
      this.client.destroy();
    });

    this.client.on('error', (err) => {
      this.log(`Socket error: ${err.message}`, 'error');
    });

    this.client.on('close', () => {
      this.pluginManager.run_hook('disconnect', this, {}, () => {});
    });

    // Execute 'connect' hook
    this.pluginManager.run_hook('connect', this, {}, (retval, msg) => {
      if (retval === constants.DENY || retval === constants.DENYDISCONNECT) {
        this.respond(554, msg || '5.7.1 Access denied');
        return this.client.destroy();
      }
      // Send 220 Greeting
      this.respond(220, `${this.server.me} ESMTP Haraka-Engine Ready`);
    });
  }

  respond(code, message) {
    if (!this.client || this.client.destroyed) return;
    const lines = Array.isArray(message) ? message : message.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const isLast = i === lines.length - 1;
      const delimiter = isLast ? ' ' : '-';
      const output = `${code}${delimiter}${lines[i]}\r\n`;
      this.log(`<<< ${code}${delimiter}${lines[i]}`, 'inbound');
      this.client.write(output);
    }
  }

  handleData(chunk) {
    if (this.state === 'DATA') {
      this.handleDataStream(chunk);
      return;
    }

    this.line_buffer += chunk.toString('utf8');
    while (this.line_buffer.includes('\n')) {
      const lineIdx = this.line_buffer.indexOf('\n');
      const line = this.line_buffer.substring(0, lineIdx).replace(/\r$/, '');
      this.line_buffer = this.line_buffer.substring(lineIdx + 1);

      if (line.trim().length > 0 || this.state === 'DATA') {
        this.handleCommandLine(line);
      }
    }
  }

  handleCommandLine(line) {
    this.log(`>>> ${line}`, 'outbound');
    const spaceIdx = line.indexOf(' ');
    const verb = (spaceIdx !== -1 ? line.slice(0, spaceIdx) : line).toUpperCase().trim();
    const param = spaceIdx !== -1 ? line.slice(spaceIdx + 1).trim() : '';

    switch (verb) {
      case 'EHLO':
        this.handleEhlo(param);
        break;
      case 'HELO':
        this.handleHelo(param);
        break;
      case 'STARTTLS':
        this.handleStartTls();
        break;
      case 'AUTH':
        this.handleAuth(param);
        break;
      case 'MAIL':
        this.handleMail(param);
        break;
      case 'RCPT':
        this.handleRcpt(param);
        break;
      case 'DATA':
        this.handleDataCommand();
        break;
      case 'RSET':
        this.handleRset();
        break;
      case 'NOOP':
        this.respond(250, '2.0.0 OK');
        break;
      case 'QUIT':
        this.respond(221, `${this.server.me} closing transmission channel`);
        this.client.end();
        break;
      default:
        this.respond(500, '5.5.1 Command unrecognized');
        break;
    }
  }

  handleEhlo(heloHost) {
    this.hello = { host: heloHost, verb: 'EHLO' };
    this.transaction = null;

    this.pluginManager.run_hook('ehlo', this, heloHost, (retval, msg) => {
      if (retval === constants.DENY) {
        return this.respond(550, msg || '5.7.1 EHLO rejected');
      }

      const caps = [
        `${this.server.me} at your service`,
        'PIPELINING',
        '8BITMIME',
        'SIZE 35000000'
      ];

      if (!this.tls.enabled && this.server.tlsOptions) {
        caps.push('STARTTLS');
      }

      caps.push('ENHANCEDSTATUSCODES');
      this.respond(250, caps);
    });
  }

  handleHelo(heloHost) {
    this.hello = { host: heloHost, verb: 'HELO' };
    this.transaction = null;

    this.pluginManager.run_hook('helo', this, heloHost, (retval, msg) => {
      if (retval === constants.DENY) {
        return this.respond(550, msg || '5.7.1 HELO rejected');
      }
      this.respond(250, `${this.server.me} at your service`);
    });
  }

  handleStartTls() {
    if (this.tls.enabled) {
      return this.respond(503, '5.5.1 TLS already active');
    }
    if (!this.server.tlsOptions) {
      return this.respond(454, '4.7.0 TLS not available');
    }

    this.respond(220, '2.0.0 Ready to start TLS');

    // Upgrade socket to TLS
    this.client.removeAllListeners('data');
    const secureSocket = new tls.TLSSocket(this.client, {
      isServer: true,
      key: this.server.tlsOptions.key,
      cert: this.server.tlsOptions.cert
    });

    secureSocket.on('secure', () => {
      this.tls = {
        enabled: true,
        cipher: secureSocket.getCipher()
      };
      this.log(`STARTTLS upgraded: ${this.tls.cipher.name} (${this.tls.cipher.version})`, 'info');
      this.client = secureSocket;
      this.hello = { host: null, verb: null }; // Reset EHLO state as per RFC 3207
      this.init();
    });

    secureSocket.on('error', (err) => {
      this.log(`TLS Error: ${err.message}`, 'error');
    });
  }

  handleAuth(param) {
    this.pluginManager.run_hook('auth', this, param, (retval, msg) => {
      if (retval === constants.OK) {
        this.relaying = true;
        this.respond(235, msg || '2.7.0 Authentication successful');
      } else {
        this.respond(535, msg || '5.7.8 Authentication credentials invalid');
      }
    });
  }

  handleMail(param) {
    if (!this.hello.host) {
      return this.respond(503, '5.5.1 Polite people say HELO first');
    }

    // Match "FROM:<address>" or "FROM: <address>"
    const match = param.match(/^FROM:\s*(.*)$/i);
    if (!match) {
      return this.respond(501, '5.5.4 Syntax: MAIL FROM:<address>');
    }

    const rawAddr = match[1].trim();
    this.transaction = new Transaction();
    this.transaction.setMailFrom(rawAddr);

    this.pluginManager.run_hook('mail', this, [this.transaction.mail_from], (retval, msg) => {
      if (retval === constants.DENY) {
        this.transaction = null;
        return this.respond(550, msg || '5.7.1 Sender rejected');
      }
      if (retval === constants.DENYSOFT) {
        this.transaction = null;
        return this.respond(451, msg || '4.7.1 Temporary failure');
      }
      this.respond(250, '2.1.0 Sender OK');
    });
  }

  handleRcpt(param) {
    if (!this.transaction || !this.transaction.mail_from) {
      return this.respond(503, '5.5.1 Need MAIL FROM before RCPT TO');
    }

    const match = param.match(/^TO:\s*(.*)$/i);
    if (!match) {
      return this.respond(501, '5.5.4 Syntax: RCPT TO:<address>');
    }

    const rawAddr = match[1].trim();
    const parsed = Transaction.parseAddress(rawAddr);

    this.pluginManager.run_hook('rcpt', this, [parsed], (retval, msg) => {
      if (retval === constants.DENY) {
        return this.respond(550, msg || '5.7.1 Relaying denied or recipient rejected');
      }
      if (retval === constants.DENYSOFT) {
        return this.respond(451, msg || '4.7.1 Temporary failure');
      }
      this.transaction.rcpt_to.push(parsed);
      this.respond(250, '2.1.5 Recipient OK');
    });
  }

  handleDataCommand() {
    if (!this.transaction || this.transaction.rcpt_to.length === 0) {
      return this.respond(503, '5.5.1 Need RCPT (recipient) before DATA');
    }

    this.pluginManager.run_hook('data', this, {}, (retval, msg) => {
      if (retval === constants.DENY) {
        return this.respond(554, msg || '5.7.1 DATA command rejected');
      }
      this.state = 'DATA';
      this.data_buffer = '';
      this.respond(354, 'End data with <CR><LF>.<CR><LF>');
    });
  }

  handleDataStream(chunk) {
    this.data_buffer += chunk.toString('binary');

    // Check for message terminator: \r\n.\r\n
    const termIdx = this.data_buffer.indexOf('\r\n.\r\n');
    if (termIdx !== -1) {
      let rawPayload = this.data_buffer.slice(0, termIdx);
      this.line_buffer = this.data_buffer.slice(termIdx + 5);
      this.state = 'COMMAND';

      // Un-dot-stuffing: replace \r\n.. with \r\n.
      rawPayload = rawPayload.replace(/\r\n\.\./g, '\r\n.');
      if (rawPayload.startsWith('..')) {
        rawPayload = rawPayload.slice(1);
      }

      this.transaction.finalizeData(rawPayload);

      // Execute data_post hook (DKIM signers, content scanners)
      this.pluginManager.run_hook('data_post', this, {}, (dp_ret, dp_msg) => {
        if (dp_ret === constants.DENY) {
          return this.respond(550, dp_msg || '5.7.1 Message content rejected');
        }

        // Execute queue hook (Direct Outbound spooling)
        this.pluginManager.run_hook('queue', this, {}, (q_ret, q_msg) => {
          if (q_ret === constants.DENY) {
            return this.respond(554, q_msg || '5.7.1 Failed to queue message');
          }
          if (q_ret === constants.DENYSOFT) {
            return this.respond(451, q_msg || '4.3.0 Queue error, try again later');
          }

          const qid = this.transaction.uuid;
          this.respond(250, `2.0.0 Message queued as ${qid}`);
          this.transaction = null;
        });
      });
    }
  }

  handleRset() {
    this.state = 'COMMAND';
    this.data_buffer = '';
    this.line_buffer = '';
    this.transaction = null;
    this.respond(250, '2.0.0 Reset state OK');
  }
}

module.exports = Connection;
