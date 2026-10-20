const crypto = require('crypto');
const nodemailer = require('nodemailer');
const dkimManager = require('./dkim-manager');

class SpamShield {
  /**
   * Generate 2048-bit RSA keypair for DKIM (saved to JSON file config/dkim-keys.json).
   */
  static generateDkim(domain, selector = 'default') {
    return dkimManager.generateKey(domain, selector);
  }

  static getDkim(domain) {
    return dkimManager.getKey(domain);
  }

  static listDkim() {
    return dkimManager.listKeys();
  }

  /**
   * Format message headers with anti-spam compliance:
   * - SPF alignment (matching envelope Return-Path and From header)
   * - RFC 8058 One-Click List-Unsubscribe (Required by Google & Yahoo bulk sender policies)
   * - Fully-qualified Message-ID
   * - Valid RFC 2822 Date
   * - DKIM signature (either passed dynamically by central controller or loaded from local config)
   */
  static prepareAntiSpamMessage(mailOptions) {
    let fromEmail = mailOptions.from ? mailOptions.from.trim() : '';
    let fromName = mailOptions.fromName || mailOptions.name || '';

    // Extract display name and clean email if passed as "Name <email@domain.com>" or Name <email@domain.com>
    const nameEmailMatch = fromEmail.match(/^(?:["']?([^"']+)["']?\s*)?<([^>]+)>$/);
    if (nameEmailMatch) {
      if (!fromName && nameEmailMatch[1]) {
        fromName = nameEmailMatch[1].trim();
      }
      fromEmail = nameEmailMatch[2].trim();
    } else {
      fromEmail = fromEmail.replace(/[<>]/g, '').trim();
    }

    const domainMatch = fromEmail.match(/@([^<>\s]+)/);
    const domain = domainMatch ? domainMatch[1].toLowerCase() : 'localhost';

    const msgUuid = crypto.randomUUID();
    const messageId = `<${msgUuid}@${domain}>`;

    const formattedFrom = fromName ? `"${fromName}" <${fromEmail}>` : `<${fromEmail}>`;

    const headers = {
      'Message-ID': messageId,
      'Date': new Date().toUTCString(),
      'X-Mailer': 'DirectMTA-HighThroughput/2.0',
      'Sender': `<${fromEmail}>`,
      'Reply-To': formattedFrom,
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

    // Attach DKIM: Support either dynamic DKIM from central controller or local config
    let dkimConfig = null;
    if (mailOptions.dkim && mailOptions.dkim.privateKey) {
      dkimConfig = {
        domainName: mailOptions.dkim.domainName || mailOptions.dkim.domain || domain,
        keySelector: mailOptions.dkim.keySelector || mailOptions.dkim.selector || 'default',
        privateKey: mailOptions.dkim.privateKey,
        cacheDir: false
      };
    } else {
      const dkimRecord = this.getDkim(domain);
      if (dkimRecord && (dkimRecord.privateKey || dkimRecord.private_key)) {
        dkimConfig = {
          domainName: dkimRecord.domain,
          keySelector: dkimRecord.selector,
          privateKey: dkimRecord.privateKey || dkimRecord.private_key,
          cacheDir: false
        };
      }
    }

    if (dkimConfig) {
      transportConfig.dkim = dkimConfig;
    }

    const mailer = nodemailer.createTransport(transportConfig);

    return mailer.sendMail({
      from: formattedFrom,
      to: mailOptions.to,
      subject: mailOptions.subject,
      text: mailOptions.text || '',
      html: mailOptions.html || undefined,
      attachments: mailOptions.attachments || undefined,
      headers
    }).then(info => ({
      messageId,
      buffer: info.message,
      dkimSigned: !!dkimConfig,
      domain
    }));
  }
}

module.exports = SpamShield;
