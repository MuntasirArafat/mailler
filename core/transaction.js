const crypto = require('crypto');

/**
 * Haraka-style Transaction Object
 * Encapsulates a single email message transaction.
 */
class Transaction {
  constructor() {
    this.uuid = crypto.randomUUID();
    this.mail_from = null;     // { original, address, domain, user }
    this.rcpt_to = [];         // array of { original, address, domain, user }
    this.header_lines = [];
    this.headers = {};
    this.body_lines = [];
    this.raw_data = '';
    this.notes = {};           // Plugins store data here (e.g. auth status, dkim, spam score)
    this.created_at = Date.now();
  }

  /**
   * Parse email string into clean parts.
   */
  static parseAddress(addrStr) {
    if (!addrStr) return { original: '', address: '', domain: '', user: '' };
    const match = addrStr.match(/(?:<)?([^<>@\s]+@[^<>@\s]+)(?:>)?/);
    const clean = match ? match[1].toLowerCase().trim() : addrStr.replace(/[<>]/g, '').toLowerCase().trim();
    const parts = clean.split('@');
    return {
      original: addrStr,
      address: clean,
      user: parts[0] || '',
      domain: parts[1] || ''
    };
  }

  setMailFrom(addrStr) {
    this.mail_from = Transaction.parseAddress(addrStr);
  }

  addRcptTo(addrStr) {
    const parsed = Transaction.parseAddress(addrStr);
    this.rcpt_to.push(parsed);
    return parsed;
  }

  /**
   * Finalize message data and parse headers.
   */
  finalizeData(rawPayload) {
    this.raw_data = rawPayload;
    // Split headers from body (first double CRLF)
    const splitIndex = rawPayload.indexOf('\r\n\r\n');
    let headerText = '';
    let bodyText = '';

    if (splitIndex !== -1) {
      headerText = rawPayload.slice(0, splitIndex);
      bodyText = rawPayload.slice(splitIndex + 4);
    } else {
      headerText = rawPayload;
    }

    // Parse header lines
    const rawLines = headerText.split(/\r?\n/);
    let currentKey = null;

    for (const line of rawLines) {
      if (/^[ \t]/.test(line) && currentKey) {
        // Folded header line
        this.headers[currentKey] += ' ' + line.trim();
      } else {
        const colonIdx = line.indexOf(':');
        if (colonIdx !== -1) {
          currentKey = line.slice(0, colonIdx).trim().toLowerCase();
          const val = line.slice(colonIdx + 1).trim();
          this.headers[currentKey] = val;
        }
      }
    }

    this.body = bodyText;
  }

  getSubject() {
    return this.headers['subject'] || '(No Subject)';
  }

  getMessageId() {
    return this.headers['message-id'] || `<${this.uuid}@localmta.dev>`;
  }
}

module.exports = Transaction;
