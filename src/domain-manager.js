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

    // 3. Fetch Public IP for SPF and A-record guidance
    const publicIp = await DeliverabilityAuditor.getPublicIp();
    const dnsRecords = DomainManager.buildDnsRecords(cleanDomain, selector, dkim, publicIp);

    return {
      domain: cleanDomain,
      selector,
      isVerified: !!domains[cleanDomain].is_verified,
      inboundEnabled: !!inboundEnabled,
      outboundEnabled: !!outboundEnabled,
      dnsRecords
    };
  }

  /**
   * Helper to construct all essential DNS records for a domain (A, MX, DKIM, SPF, HELO SPF, DMARC)
   */
  static buildDnsRecords(cleanDomain, selector, dkim, publicIp) {
    const ip = publicIp || 'YOUR_SERVER_IP';
    const dkimValue = dkim ? (dkim.txtValue || dkim.txt_record_value || '') : '';
    const dkimName = dkim ? (dkim.recordName || dkim.txt_record_name || `${selector}._domainkey.${cleanDomain}`) : `${selector}._domainkey.${cleanDomain}`;

    return [
      {
        type: 'A',
        name: `mail.${cleanDomain}`,
        host: 'mail',
        value: ip,
        proxyStatus: 'DNS Only (Grey Cloud - DO NOT PROXY)',
        description: 'Mail server host IP for inbound SMTP (port 25) and outbound HELO'
      },
      {
        type: 'MX',
        name: cleanDomain,
        host: '@',
        priority: 10,
        value: `mail.${cleanDomain}`,
        proxyStatus: 'DNS Only',
        description: 'Routes inbound emails to your mail server'
      },
      {
        type: 'TXT',
        name: dkimName,
        host: `${selector}._domainkey`,
        value: dkimValue,
        proxyStatus: 'DNS Only',
        description: 'DKIM 2048-bit cryptographic signature (100% Google/Yahoo authenticity)'
      },
      {
        type: 'TXT',
        name: cleanDomain,
        host: '@',
        value: `v=spf1 ip4:${ip} ~all`,
        proxyStatus: 'DNS Only',
        description: 'SPF authorizer allowing your server IP to send emails for this domain'
      },
      {
        type: 'TXT',
        name: `mail.${cleanDomain}`,
        host: 'mail',
        value: `v=spf1 ip4:${ip} ~all`,
        proxyStatus: 'DNS Only',
        description: 'HELO SPF authorizer (prevents mail-tester SPF_HELO_FAIL and RDNS_NONE)'
      },
      {
        type: 'TXT',
        name: `_dmarc.${cleanDomain}`,
        host: '_dmarc',
        value: `v=DMARC1; p=reject; sp=reject; pct=100; rua=mailto:postmaster@${cleanDomain}`,
        proxyStatus: 'DNS Only',
        description: 'DMARC anti-spoofing policy (protects domain reputation)'
      }
    ];
  }

  static listDomains() {
    const domains = this.loadDomains();
    return Object.values(domains).sort((a, b) => b.created_at - a.created_at);
  }

  static async getDomain(domain) {
    const cleanDomain = domain.toLowerCase().trim();
    const domains = this.loadDomains();
    const item = domains[cleanDomain];
    if (!item) return null;

    const dkim = SpamShield.getDkim(cleanDomain);
    const publicIp = await DeliverabilityAuditor.getPublicIp().catch(() => null);
    const dnsRecords = DomainManager.buildDnsRecords(cleanDomain, item.selector, dkim, publicIp);

    return {
      ...item,
      dkim: dkim ? {
        selector: dkim.selector,
        recordName: dkim.recordName || dkim.txt_record_name,
        txtValue: dkim.txtValue || dkim.txt_record_value
      } : null,
      dnsRecords
    };
  }

  static async verifyDomain(domain) {
    const cleanDomain = domain.toLowerCase().trim();
    const item = await this.getDomain(cleanDomain);
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
