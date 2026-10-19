const crypto = require('crypto');
const db = require('./db');
const nodemailer = require('nodemailer');

class SpamShield {
  /**
   * Generate 2048-bit RSA keypair for DKIM.
   */
  static generateDkim(domain, selector = 'default') {
    const cleanDomain = domain.toLowerCase().trim();
    const cleanSelector = selector.toLowerCase().trim();

    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const pubBase64 = publicKey
      .replace(/-----BEGIN PUBLIC KEY-----/g, '')
      .replace(/-----END PUBLIC KEY-----/g, '')
      .replace(/[\r\n\s]/g, '');

    const recordName = `${cleanSelector}._domainkey.${cleanDomain}`;
    const txtValue = `v=DKIM1; k=rsa; p=${pubBase64}`;

    const stmt = db.prepare(`
      INSERT INTO dkim_keys (domain, selector, private_key, public_key, txt_record_name, txt_record_value, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        selector = excluded.selector,
        private_key = excluded.private_key,
        public_key = excluded.public_key,
        txt_record_name = excluded.txt_record_name,
        txt_record_value = excluded.txt_record_value,
        created_at = excluded.created_at
    `);

    stmt.run(cleanDomain, cleanSelector, privateKey, publicKey, recordName, txtValue, Date.now());

    return {
      domain: cleanDomain,
      selector: cleanSelector,
      recordName,
      txtValue
    };
  }

  static getDkim(domain) {
    const cleanDomain = domain.toLowerCase().trim();
    const stmt = db.prepare('SELECT * FROM dkim_keys WHERE domain = ?');
    return stmt.get(cleanDomain) || null;
  }

  static listDkim() {
    return db.prepare('SELECT domain, selector, txt_record_name, txt_record_value, created_at FROM dkim_keys').all();
  }

  /**
   * Format message headers with anti-spam compliance:
   * - SPF alignment (matching envelope Return-Path and From header)
   * - RFC 8058 One-Click List-Unsubscribe (Required by Google & Yahoo bulk sender policies)
   * - Fully-qualified Message-ID
   * - Valid RFC 2822 Date
   */
  static prepareAntiSpamMessage(mailOptions) {
    const fromAddr = mailOptions.from.trim();
    const domainMatch = fromAddr.match(/@([^<>\s]+)/);
    const domain = domainMatch ? domainMatch[1].toLowerCase().replace(/[>]/g, '') : 'localhost';

    const msgUuid = crypto.randomUUID();
    const messageId = `<${msgUuid}@${domain}>`;

    const headers = {
      'Message-ID': messageId,
      'Date': new Date().toUTCString(),
      'X-Mailer': 'DirectMTA-HighThroughput/2.0',
      'Return-Path': `<bounce+${msgUuid}@${domain}>`,
      ...(mailOptions.headers || {})
    };

    // RFC 8058 One-Click Unsubscribe (Crucial for avoiding Gmail/Yahoo spam box)
    if (mailOptions.unsubscribeUrl || mailOptions.unsubscribeEmail) {
      const unsubLinks = [];
      if (mailOptions.unsubscribeUrl) unsubLinks.push(`<${mailOptions.unsubscribeUrl}>`);
      if (mailOptions.unsubscribeEmail) unsubLinks.push(`<mailto:${mailOptions.unsubscribeEmail}>`);

      headers['List-Unsubscribe'] = unsubLinks.join(', ');
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }

    // Build raw MIME message
    const transportConfig = {
      streamTransport: true,
      buffer: true
    };

    // Attach DKIM if key exists for sending domain
    const dkimRecord = this.getDkim(domain);
    if (dkimRecord) {
      transportConfig.dkim = {
        domainName: dkimRecord.domain,
        keySelector: dkimRecord.selector,
        privateKey: dkimRecord.private_key,
        cacheDir: false
      };
    }

    const mailer = nodemailer.createTransport(transportConfig);

    return mailer.sendMail({
      from: mailOptions.from,
      to: mailOptions.to,
      subject: mailOptions.subject,
      text: mailOptions.text || '',
      html: mailOptions.html || undefined,
      attachments: mailOptions.attachments || undefined,
      headers
    }).then(info => ({
      messageId,
      buffer: info.message,
      dkimSigned: !!dkimRecord,
      domain
    }));
  }
}

module.exports = SpamShield;
