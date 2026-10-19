const dns = require('dns').promises;
const net = require('net');
const https = require('https');

class DeliverabilityAuditor {
  static getPublicIp() {
    return new Promise((resolve) => {
      const req = https.get('https://api.ipify.org?format=json', { timeout: 4000 }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data).ip || null);
          } catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  static async auditDomain(domain, selector = 'default', heloHostname = 'mail.localmta.dev') {
    const cleanDomain = domain.toLowerCase().trim();
    const publicIp = await this.getPublicIp();

    const report = {
      domain: cleanDomain,
      publicIp,
      deliverabilityScore: 0,
      checks: {
        spf: { passed: false, record: null, advice: null },
        dkim: { passed: false, record: null, advice: null },
        dmarc: { passed: false, record: null, advice: null },
        mx: { passed: false, records: [], advice: null },
        ptr: { passed: false, ptrHost: null, advice: null },
        port25: { passed: false, latencyMs: null, advice: null }
      },
      recommendations: []
    };

    let score = 0;

    // 1. Check MX
    try {
      const mx = await dns.resolveMx(cleanDomain);
      if (mx && mx.length > 0) {
        report.checks.mx.passed = true;
        report.checks.mx.records = mx.map(m => m.exchange);
        score += 15;
      }
    } catch (e) {
      report.checks.mx.advice = 'Add MX records if you intend to receive mail on this domain.';
    }

    // 2. Check SPF
    try {
      const txt = await dns.resolveTxt(cleanDomain);
      const flattened = txt.map(r => r.join(''));
      const spf = flattened.find(r => r.startsWith('v=spf1'));
      if (spf) {
        report.checks.spf.passed = true;
        report.checks.spf.record = spf;
        score += 25;
      } else {
        report.checks.spf.advice = `Add TXT record: "v=spf1 ip4:${publicIp || 'YOUR_IP'} ~all"`;
        report.recommendations.push({
          type: 'TXT',
          host: cleanDomain,
          value: `v=spf1 ip4:${publicIp || 'YOUR_IP'} ~all`,
          reason: 'SPF authorizes your IP to send emails on behalf of this domain.'
        });
      }
    } catch (e) {
      report.checks.spf.advice = 'No TXT records found for domain.';
    }

    // 3. Check DKIM
    try {
      const dkimHost = `${selector}._domainkey.${cleanDomain}`;
      const dkimTxt = await dns.resolveTxt(dkimHost);
      const flattened = dkimTxt.map(r => r.join(''));
      const dkim = flattened.find(r => r.includes('v=DKIM1') || r.includes('p='));
      if (dkim) {
        report.checks.dkim.passed = true;
        report.checks.dkim.record = dkim;
        score += 25;
      } else {
        report.checks.dkim.advice = `Publish your DKIM public key at ${dkimHost}`;
      }
    } catch (e) {
      report.checks.dkim.advice = `DKIM record missing at ${selector}._domainkey.${cleanDomain}`;
      report.recommendations.push({
        type: 'TXT',
        host: `${selector}._domainkey.${cleanDomain}`,
        value: 'v=DKIM1; k=rsa; p=YOUR_PUBLIC_KEY',
        reason: 'DKIM provides cryptographic signature verification required by Google and Yahoo.'
      });
    }

    // 4. Check DMARC
    try {
      const dmarcHost = `_dmarc.${cleanDomain}`;
      const dmarcTxt = await dns.resolveTxt(dmarcHost);
      const flattened = dmarcTxt.map(r => r.join(''));
      const dmarc = flattened.find(r => r.startsWith('v=DMARC1'));
      if (dmarc) {
        report.checks.dmarc.passed = true;
        report.checks.dmarc.record = dmarc;
        score += 15;
      } else {
        report.checks.dmarc.advice = `Add TXT record at ${dmarcHost}: "v=DMARC1; p=none; sp=none"`;
        report.recommendations.push({
          type: 'TXT',
          host: dmarcHost,
          value: 'v=DMARC1; p=none; sp=none',
          reason: 'DMARC prevents domain spoofing and aligns SPF/DKIM.'
        });
      }
    } catch (e) {
      report.checks.dmarc.advice = 'DMARC record missing.';
    }

    // 5. Check PTR (Reverse DNS)
    if (publicIp) {
      try {
        const ptrs = await dns.reverse(publicIp);
        if (ptrs && ptrs.length > 0) {
          report.checks.ptr.passed = true;
          report.checks.ptr.ptrHost = ptrs[0];
          score += 10;
        } else {
          report.checks.ptr.advice = 'No Reverse DNS (PTR) record configured for your public IP.';
        }
      } catch (e) {
        report.checks.ptr.advice = `Ask your VPS provider to set PTR record for ${publicIp} to match ${heloHostname}`;
      }
    }

    // 6. Test Outbound Port 25
    const port25Test = await this.testPort25('gmail-smtp-in.l.google.com', 25);
    report.checks.port25.passed = port25Test.open;
    report.checks.port25.latencyMs = port25Test.latencyMs;
    if (port25Test.open) {
      score += 10;
    } else {
      report.checks.port25.advice = 'Outbound port 25 is blocked. Contact your ISP or use a VPS with open port 25.';
    }

    report.deliverabilityScore = score;
    report.score = score;
    report.spf = { valid: report.checks.spf.passed, verified: report.checks.spf.passed, record: report.checks.spf.record, advice: report.checks.spf.advice };
    report.dkim = { valid: report.checks.dkim.passed, verified: report.checks.dkim.passed, record: report.checks.dkim.record, advice: report.checks.dkim.advice };
    report.dmarc = { valid: report.checks.dmarc.passed, verified: report.checks.dmarc.passed, record: report.checks.dmarc.record, advice: report.checks.dmarc.advice };
    report.mx = { valid: report.checks.mx.passed, verified: report.checks.mx.passed, records: report.checks.mx.records, advice: report.checks.mx.advice };
    report.ptr = { valid: report.checks.ptr.passed, verified: report.checks.ptr.passed, ptrHost: report.checks.ptr.ptrHost, advice: report.checks.ptr.advice };
    report.port25Outbound = { open: report.checks.port25.passed, latencyMs: report.checks.port25.latencyMs, advice: report.checks.port25.advice };
    return report;
  }

  static testPort25(host = 'gmail-smtp-in.l.google.com', port = 25, timeout = 5000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const socket = net.createConnection(port, host);
      socket.setTimeout(timeout);

      socket.on('connect', () => {
        socket.write('QUIT\r\n');
      });

      socket.on('data', () => {
        socket.end();
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve({ open: false, latencyMs: Date.now() - start, error: 'Timeout (ISP blocked)' });
      });

      socket.on('error', (err) => {
        resolve({ open: false, latencyMs: Date.now() - start, error: err.message });
      });

      socket.on('close', () => {
        resolve({ open: true, latencyMs: Date.now() - start, error: null });
      });
    });
  }
}

module.exports = DeliverabilityAuditor;
