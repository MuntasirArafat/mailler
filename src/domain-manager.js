const db = require('./db');
const SpamShield = require('./spam-shield');
const DeliverabilityAuditor = require('./deliverability-auditor');

class DomainManager {
  /**
   * Add a new domain to the mail server.
   * Automatically generates DKIM RSA-2048 keys and formats DNS records.
   */
  static async addDomain(domain, { selector = 'default', inboundEnabled = true, outboundEnabled = true } = {}) {
    if (!domain) throw new Error('Domain name is required');
    const cleanDomain = domain.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

    // 1. Generate or load existing DKIM key (preserve existing key so DNS records stay valid across deploys)
    const existingDkim = SpamShield.getDkim(cleanDomain);
    let dkim;
    if (existingDkim && existingDkim.selector === selector) {
      dkim = {
        domain: cleanDomain,
        selector,
        recordName: existingDkim.txt_record_name,
        txtValue: existingDkim.txt_record_value
      };
    } else {
      dkim = SpamShield.generateDkim(cleanDomain, selector);
    }

    // 2. Insert or update hosted domain
    const stmt = db.prepare(`
      INSERT INTO hosted_domains (domain, selector, is_verified, inbound_enabled, outbound_enabled, created_at)
      VALUES (?, ?, 0, ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        selector = excluded.selector,
        inbound_enabled = excluded.inbound_enabled,
        outbound_enabled = excluded.outbound_enabled
    `);
    stmt.run(cleanDomain, selector, inboundEnabled ? 1 : 0, outboundEnabled ? 1 : 0, Date.now());

    // 4. Fetch Public IP for SPF guidance
    const publicIp = await DeliverabilityAuditor.getPublicIp();

    const dnsRecords = [
      {
        type: 'TXT',
        name: dkim.recordName,
        value: dkim.txtValue,
        description: 'DKIM cryptographic public signature verification'
      },
      {
        type: 'TXT',
        name: cleanDomain,
        value: `v=spf1 ip4:${publicIp || 'YOUR_SERVER_IP'} ~all`,
        description: 'SPF authorizer for your server IP'
      },
      {
        type: 'TXT',
        name: `_dmarc.${cleanDomain}`,
        value: `v=DMARC1; p=none; sp=none; rua=mailto:postmaster@${cleanDomain}`,
        description: 'DMARC policy declaration'
      },
      {
        type: 'MX',
        name: cleanDomain,
        priority: 10,
        value: `mail.${cleanDomain}`,
        description: 'Inbound Mail Exchanger routing'
      }
    ];

    return {
      domain: cleanDomain,
      selector,
      isVerified: false,
      inboundEnabled: !!inboundEnabled,
      outboundEnabled: !!outboundEnabled,
      dnsRecords
    };
  }

  static listDomains() {
    return db.prepare('SELECT domain, selector, is_verified, inbound_enabled, outbound_enabled, created_at FROM hosted_domains ORDER BY created_at DESC').all();
  }

  static getDomain(domain) {
    const cleanDomain = domain.toLowerCase().trim();
    const row = db.prepare('SELECT * FROM hosted_domains WHERE domain = ?').get(cleanDomain);
    if (!row) return null;

    const dkim = SpamShield.getDkim(cleanDomain);
    return {
      ...row,
      dkim: dkim ? {
        selector: dkim.selector,
        recordName: dkim.txt_record_name,
        txtValue: dkim.txt_record_value
      } : null
    };
  }

  static async verifyDomain(domain) {
    const cleanDomain = domain.toLowerCase().trim();
    const row = this.getDomain(cleanDomain);
    if (!row) throw new Error(`Domain "${cleanDomain}" is not added to this mail server.`);

    const audit = await DeliverabilityAuditor.auditDomain(cleanDomain, row.selector);

    // If both SPF and DKIM pass, mark domain as verified
    const isVerified = audit.checks.spf.passed && audit.checks.dkim.passed;
    if (isVerified) {
      db.prepare('UPDATE hosted_domains SET is_verified = 1 WHERE domain = ?').run(cleanDomain);
    } else {
      db.prepare('UPDATE hosted_domains SET is_verified = 0 WHERE domain = ?').run(cleanDomain);
    }

    return {
      domain: cleanDomain,
      verified: isVerified,
      deliverabilityScore: audit.deliverabilityScore,
      score: audit.deliverabilityScore,
      checks: audit.checks,
      spf: { verified: audit.checks.spf.passed, valid: audit.checks.spf.passed, record: audit.checks.spf.record, advice: audit.checks.spf.advice },
      dkim: { verified: audit.checks.dkim.passed, valid: audit.checks.dkim.passed, record: audit.checks.dkim.record, advice: audit.checks.dkim.advice },
      dmarc: { verified: audit.checks.dmarc.passed, valid: audit.checks.dmarc.passed, record: audit.checks.dmarc.record, advice: audit.checks.dmarc.advice },
      mx: { verified: audit.checks.mx.passed, valid: audit.checks.mx.passed, records: audit.checks.mx.records, advice: audit.checks.mx.advice },
      recommendations: audit.recommendations
    };
  }

  static deleteDomain(domain) {
    const cleanDomain = domain.toLowerCase().trim();
    db.prepare('DELETE FROM hosted_domains WHERE domain = ?').run(cleanDomain);
    db.prepare('DELETE FROM dkim_keys WHERE domain = ?').run(cleanDomain);
    return true;
  }

  static isDomainHosted(domain) {
    if (!domain) return false;
    const cleanDomain = domain.toLowerCase().trim();
    const row = db.prepare('SELECT inbound_enabled FROM hosted_domains WHERE domain = ?').get(cleanDomain);
    return row ? !!row.inbound_enabled : false;
  }
}

module.exports = DomainManager;
