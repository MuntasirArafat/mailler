const fs = require('fs');
const path = require('path');
const SpamShield = require('./spam-shield');
const DeliverabilityAuditor = require('./deliverability-auditor');

class DomainManager {
  static getConfigFile() {
    const configDir = path.join(__dirname, '..', 'config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    return path.join(configDir, 'domains.json');
  }

  static loadDomains() {
    const file = this.getConfigFile();
    if (!fs.existsSync(file)) return {};
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return {};
    }
  }

  static saveDomains(domains) {
    const file = this.getConfigFile();
    fs.writeFileSync(file, JSON.stringify(domains, null, 2), 'utf8');
  }

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
        recordName: existingDkim.recordName || existingDkim.txt_record_name,
        txtValue: existingDkim.txtValue || existingDkim.txt_record_value
      };
    } else {
      dkim = SpamShield.generateDkim(cleanDomain, selector);
    }

    // 2. Insert or update hosted domain
    const domains = this.loadDomains();
    domains[cleanDomain] = {
      domain: cleanDomain,
      selector,
      is_verified: domains[cleanDomain] ? domains[cleanDomain].is_verified : 0,
      inbound_enabled: inboundEnabled ? 1 : 0,
      outbound_enabled: outboundEnabled ? 1 : 0,
      created_at: domains[cleanDomain] ? domains[cleanDomain].created_at : Date.now()
    };
    this.saveDomains(domains);

    // 3. Fetch Public IP for SPF guidance
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
        name: `mail.${cleanDomain}`,
        value: 'v=spf1 a -all',
        description: 'SPF authorizer for MTA HELO hostname (fixes SPF_HELO_NONE)'
      },
      {
        type: 'TXT',
        name: `_dmarc.${cleanDomain}`,
        value: `v=DMARC1; p=reject; sp=reject; pct=100; rua=mailto:postmaster@${cleanDomain}`,
        description: 'DMARC policy declaration (rejects spoofed emails)'
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
      isVerified: !!domains[cleanDomain].is_verified,
      inboundEnabled: !!inboundEnabled,
      outboundEnabled: !!outboundEnabled,
      dnsRecords
    };
  }

  static listDomains() {
    const domains = this.loadDomains();
    return Object.values(domains).sort((a, b) => b.created_at - a.created_at);
  }

  static getDomain(domain) {
    const cleanDomain = domain.toLowerCase().trim();
    const domains = this.loadDomains();
    const item = domains[cleanDomain];
    if (!item) return null;

    const dkim = SpamShield.getDkim(cleanDomain);
    return {
      ...item,
      dkim: dkim ? {
        selector: dkim.selector,
        recordName: dkim.recordName || dkim.txt_record_name,
        txtValue: dkim.txtValue || dkim.txt_record_value
      } : null
    };
  }

  static async verifyDomain(domain) {
    const cleanDomain = domain.toLowerCase().trim();
    const item = this.getDomain(cleanDomain);
    if (!item) throw new Error(`Domain "${cleanDomain}" is not added to this mail server.`);

    const audit = await DeliverabilityAuditor.auditDomain(cleanDomain, item.selector);

    // If both SPF and DKIM pass, mark domain as verified
    const isVerified = audit.checks.spf.passed && audit.checks.dkim.passed;
    const domains = this.loadDomains();
    if (domains[cleanDomain]) {
      domains[cleanDomain].is_verified = isVerified ? 1 : 0;
      this.saveDomains(domains);
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
    const domains = this.loadDomains();
    if (domains[cleanDomain]) {
      delete domains[cleanDomain];
      this.saveDomains(domains);
      const dkimManager = require('./dkim-manager');
      dkimManager.deleteKey(cleanDomain);
      return true;
    }
    return false;
  }

  static isDomainHosted(domain) {
    if (!domain) return false;
    const cleanDomain = domain.toLowerCase().trim();
    const domains = this.loadDomains();
    const item = domains[cleanDomain];
    return item ? !!item.inbound_enabled : false;
  }
}

module.exports = DomainManager;
