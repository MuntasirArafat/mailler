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
   * - Proper HTML5 skeleton (clears HTML_MIME_NO_HTML_TAG)
   * - Multipart/alternative text fallback (clears MIME_HTML_ONLY)
   * - DKIM signature (either passed dynamically by central controller or loaded/auto-generated locally)
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

    // 1. Process HTML Content: Wrap in proper HTML5 tags if missing to fix SpamAssassin HTML_MIME_NO_HTML_TAG
    let htmlContent = mailOptions.html || undefined;
    let textContent = mailOptions.text || '';

    if (htmlContent) {
      const hasHtmlTag = /<html[\s>]/i.test(htmlContent);
      const hasDoctype = /<!DOCTYPE\s+html/i.test(htmlContent);

      if (!hasHtmlTag && !hasDoctype) {
        htmlContent = `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>${mailOptions.subject || 'Notification'}</title>\n</head>\n<body style="margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #222222; background-color: #ffffff;">\n  ${htmlContent}\n</body>\n</html>`;
      }

      // 2. Auto-generate plain-text fallback from HTML if text is omitted to fix SpamAssassin MIME_HTML_ONLY
      if (!textContent) {
        textContent = htmlContent
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>/gi, '\n\n')
          .replace(/<\/h[1-6]>/gi, '\n\n')
          .replace(/<\/tr>/gi, '\n')
          .replace(/<\/li>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }
    }

    // Build raw MIME message
    const transportConfig = {
      streamTransport: true,
      buffer: true
    };

    // Attach DKIM: Support either dynamic DKIM from central controller or local config/auto-generated
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
          keySelector: dkimRecord.selector || 'default',
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
      text: textContent || undefined,
      html: htmlContent || undefined,
      attachments: mailOptions.attachments || undefined,
      headers
    }).then(info => ({
      messageId,
      buffer: info.message,
      dkimSigned: !!dkimConfig,
      dkimSelector: dkimConfig ? dkimConfig.keySelector : null,
      domain
    }));
  }
}

module.exports = SpamShield;
