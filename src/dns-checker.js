const dns = require('dns').promises;
const net = require('net');
const https = require('https');

class DnsChecker {
  /**
   * Get server's public IP address via external IP lookup service.
   */
  static getPublicIp() {
    return new Promise((resolve) => {
      const req = https.get('https://api.ipify.org?format=json', { timeout: 4000 }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.ip || null);
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    });
  }

  /**
   * Test outbound port 25 connectivity to a given host or default major MX.
   */
  static testPort25(host = 'gmail-smtp-in.l.google.com', port = 25, timeout = 6000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const socket = net.createConnection(port, host);
      socket.setTimeout(timeout);

      let banner = '';

      socket.on('connect', () => {
        // Connected, wait for 220 greeting
      });

      socket.on('data', (d) => {
        banner += d.toString();
        socket.write('QUIT\r\n');
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve({
          host,
          port,
          open: false,
          blocked: true,
          latencyMs: Date.now() - start,
          error: 'Connection timed out (Outbound port 25 is likely blocked by your ISP or firewall)',
          banner: null
        });
      });

      socket.on('error', (err) => {
        resolve({
          host,
          port,
          open: false,
          blocked: err.code === 'ECONNREFUSED' ? false : true,
          latencyMs: Date.now() - start,
          error: `${err.code || 'ERROR'}: ${err.message}`,
          banner: null
        });
      });

      socket.on('close', () => {
        if (banner) {
          resolve({
            host,
            port,
            open: true,
            blocked: false,
            latencyMs: Date.now() - start,
            banner: banner.split('\n')[0].trim(),
            error: null
          });
        }
      });
    });
  }

  /**
   * Comprehensive DNS diagnostic for a sender domain.
   */
  static async checkDomain(domain, selector = 'default') {
    const cleanDomain = domain.toLowerCase().trim();
    const result = {
      domain: cleanDomain,
      mx: { valid: false, records: [], error: null },
      spf: { valid: false, record: null, error: null },
      dkim: { valid: false, record: null, selector, error: null },
      dmarc: { valid: false, record: null, error: null }
    };

    // 1. Check MX
    try {
      const mx = await dns.resolveMx(cleanDomain);
      result.mx.records = (mx || []).sort((a, b) => a.priority - b.priority);
      result.mx.valid = result.mx.records.length > 0;
    } catch (err) {
      result.mx.error = err.message;
    }

    // 2. Check SPF
    try {
      const txtRecords = await dns.resolveTxt(cleanDomain);
      const flattened = txtRecords.map(r => r.join(''));
      const spfRecord = flattened.find(t => t.startsWith('v=spf1'));
      if (spfRecord) {
        result.spf.valid = true;
        result.spf.record = spfRecord;
      } else {
        result.spf.error = 'No SPF (v=spf1) record found';
      }
    } catch (err) {
      result.spf.error = err.message;
    }

    // 3. Check DKIM
    try {
      const dkimHost = `${selector}._domainkey.${cleanDomain}`;
      const dkimTxt = await dns.resolveTxt(dkimHost);
      const flattened = dkimTxt.map(r => r.join(''));
      const dkimRecord = flattened.find(t => t.includes('v=DKIM1') || t.includes('p='));
      if (dkimRecord) {
        result.dkim.valid = true;
        result.dkim.record = dkimRecord;
      } else {
        result.dkim.error = `No DKIM record at ${dkimHost}`;
      }
    } catch (err) {
      result.dkim.error = `Lookup error for ${selector}._domainkey.${cleanDomain}: ${err.message}`;
    }

    // 4. Check DMARC
    try {
      const dmarcHost = `_dmarc.${cleanDomain}`;
      const dmarcTxt = await dns.resolveTxt(dmarcHost);
      const flattened = dmarcTxt.map(r => r.join(''));
      const dmarcRecord = flattened.find(t => t.startsWith('v=DMARC1'));
      if (dmarcRecord) {
        result.dmarc.valid = true;
        result.dmarc.record = dmarcRecord;
      } else {
        result.dmarc.error = `No DMARC record found at ${dmarcHost}`;
      }
    } catch (err) {
      result.dmarc.error = err.message;
    }

    return result;
  }
}

module.exports = DnsChecker;
