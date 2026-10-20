const path = require('path');
const express = require('express');
const SpamShield = require('./spam-shield');
const DeliverabilityAuditor = require('./deliverability-auditor');
const DnsChecker = require('./dns-checker');
const dkimManager = require('./dkim-manager');

function createApiServer(mta, inboundReceiverOrOptions = null, options = {}) {
  let inboundReceiver = null;
  let opts = options;
  if (inboundReceiverOrOptions && typeof inboundReceiverOrOptions.start === 'function') {
    inboundReceiver = inboundReceiverOrOptions;
  } else if (inboundReceiverOrOptions && typeof inboundReceiverOrOptions === 'object') {
    opts = inboundReceiverOrOptions;
  }
  const app = express();
  const apiPassword = opts.apiPassword || process.env.API_PASSWORD || process.env.API_KEY || null;

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Authentication Middleware for all /api routes
  app.use('/api', (req, res, next) => {
    if (!apiPassword) {
      return next(); // No password configured, allow access
    }

    const authHeader = req.headers['authorization'];
    const apiKeyHeader = req.headers['x-api-key'];
    const queryKey = req.query.api_key;

    let providedKey = null;
    if (apiKeyHeader) {
      providedKey = apiKeyHeader.trim();
    } else if (authHeader && authHeader.startsWith('Bearer ')) {
      providedKey = authHeader.slice(7).trim();
    } else if (queryKey) {
      providedKey = queryKey.trim();
    }

    if (providedKey && providedKey === apiPassword) {
      return next(); // Authenticated
    }

    return res.status(401).json({
      error: 'Unauthorized: Invalid or missing API password.',
      message: 'You must provide your password via "x-api-key: <password>" or "Authorization: Bearer <password>" header, or "?api_key=<password>".'
    });
  });

  // Health & System Info
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'healthy',
      role: 'stateless-mta-worker',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      heloHost: mta.heloHost || null,
      authRequired: !!apiPassword
    });
  });

  // 1. OUTBOUND: DIRECT SINGLE EMAIL SEND
  app.post('/api/send', async (req, res) => {
    try {
      const {
        from,
        to,
        name,
        fromName,
        subject,
        text,
        html,
        attachments,
        unsubscribeUrl,
        unsubscribeEmail,
        headers,
        dkim
      } = req.body;

      if (!from || !to) {
        return res.status(400).json({ error: 'Both "from" and "to" email addresses are required.' });
      }

      const senderName = fromName || name || null;
      let formattedFrom = from.trim();
      if (senderName && !formattedFrom.includes('<')) {
        formattedFrom = `"${senderName}" <${formattedFrom}>`;
      }

      const startTime = Date.now();
      const prepared = await SpamShield.prepareAntiSpamMessage({
        from: formattedFrom,
        fromName: senderName,
        to,
        subject,
        text,
        html,
        attachments,
        unsubscribeUrl,
        unsubscribeEmail,
        headers,
        dkim
      });

      const delivery = await mta.deliver(formattedFrom, to, prepared.buffer);
      const durationMs = Date.now() - startTime;

      return res.json({
        success: true,
        messageId: prepared.messageId,
        dkimSigned: prepared.dkimSigned,
        recipient: to,
        durationMs,
        response: delivery.response,
        host: delivery.host,
        tls: delivery.tls
      });
    } catch (err) {
      return res.status(502).json({
        success: false,
        error: err.message,
        recipient: req.body.to || null
      });
    }
  });

  // 2. OUTBOUND: DIRECT CONCURRENT BATCH SEND (Stateless parallel delivery)
  app.post(['/api/send-batch', '/api/send/batch'], async (req, res) => {
    try {
      const emails = req.body.emails;
      if (!Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ error: '"emails" must be a non-empty array of email objects.' });
      }

      const concurrency = Math.min(Math.max(parseInt(req.body.concurrency || '10', 10), 1), 50);
      const results = new Array(emails.length);
      let nextIndex = 0;

      async function worker() {
        while (nextIndex < emails.length) {
          const currentIndex = nextIndex++;
          const email = emails[currentIndex];
          try {
            if (!email.from || !email.to) {
              results[currentIndex] = { to: email.to || null, success: false, error: 'Missing "from" or "to"' };
              continue;
            }

            const senderName = email.fromName || email.name || null;
            let formattedFrom = email.from.trim();
            if (senderName && !formattedFrom.includes('<')) {
              formattedFrom = `"${senderName}" <${formattedFrom}>`;
            }

            const prepared = await SpamShield.prepareAntiSpamMessage({
              from: formattedFrom,
              fromName: senderName,
              to: email.to,
              subject: email.subject,
              text: email.text,
              html: email.html,
              attachments: email.attachments,
              unsubscribeUrl: email.unsubscribeUrl,
              unsubscribeEmail: email.unsubscribeEmail,
              headers: email.headers,
              dkim: email.dkim
            });

            const delivery = await mta.deliver(formattedFrom, email.to, prepared.buffer);
            results[currentIndex] = {
              to: email.to,
              success: true,
              messageId: prepared.messageId,
              dkimSigned: prepared.dkimSigned,
              host: delivery.host,
              response: delivery.response
            };
          } catch (err) {
            results[currentIndex] = {
              to: email.to || null,
              success: false,
              error: err.message
            };
          }
        }
      }

      const workers = [];
      const workerCount = Math.min(concurrency, emails.length);
      for (let i = 0; i < workerCount; i++) {
        workers.push(worker());
      }
      await Promise.all(workers);

      const sent = results.filter(r => r.success).length;
      const failed = results.length - sent;

      return res.json({
        success: true,
        total: emails.length,
        sent,
        failed,
        results
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 3. NETWORK DIAGNOSTICS: TEST PORT 25
  app.post('/api/test-port25', async (req, res) => {
    try {
      const host = (req.body.host || 'gmail-smtp-in.l.google.com').trim();
      const port = parseInt(req.body.port || '25', 10);
      const result = await DnsChecker.testPort25(host, port);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 4. DKIM MANAGEMENT (JSON-backed in config/dkim-keys.json)
  app.post('/api/dkim/generate', (req, res) => {
    try {
      const { domain, selector } = req.body;
      if (!domain) return res.status(400).json({ error: 'Domain is required' });

      const dkim = dkimManager.generateKey(domain, selector || 'default');
      res.json({
        success: true,
        dkim,
        dnsInstruction: {
          type: 'TXT',
          host: dkim.recordName,
          value: dkim.txtValue
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/dkim/set', (req, res) => {
    try {
      const { domain, selector, privateKey, publicKey } = req.body;
      if (!domain || !privateKey) return res.status(400).json({ error: 'Both domain and privateKey are required' });

      const dkim = dkimManager.setKey(domain, selector || 'default', privateKey, publicKey || '');
      res.json({
        success: true,
        dkim: {
          domain: dkim.domain,
          selector: dkim.selector,
          recordName: dkim.recordName,
          txtValue: dkim.txtValue
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/dkim', (req, res) => {
    res.json(dkimManager.listKeys());
  });

  app.delete('/api/dkim/:domain', (req, res) => {
    const selector = req.query.selector || 'default';
    const deleted = dkimManager.deleteKey(req.params.domain, selector);
    res.json({ success: deleted });
  });

  // 5. PRE-FLIGHT DELIVERABILITY & ANTI-SPAM AUDIT
  app.get('/api/deliverability/audit/:domain', async (req, res) => {
    try {
      const selector = req.query.selector || 'default';
      const report = await DeliverabilityAuditor.auditDomain(req.params.domain, selector);
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 6. DOMAIN MANAGEMENT (JSON-backed in config/domains.json)
  const DomainManager = require('./domain-manager');

  app.get('/api/domains', (req, res) => {
    res.json(DomainManager.listDomains());
  });

  app.post('/api/domains', async (req, res) => {
    try {
      const { domain, selector, inboundEnabled, outboundEnabled } = req.body;
      if (!domain) return res.status(400).json({ error: 'Domain is required' });

      const result = await DomainManager.addDomain(domain, { selector, inboundEnabled, outboundEnabled });
      res.status(201).json({
        success: true,
        ...result
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/domains/:domain', (req, res) => {
    const domain = DomainManager.getDomain(req.params.domain);
    if (!domain) return res.status(404).json({ error: 'Domain not found' });
    res.json(domain);
  });

  app.post('/api/domains/:domain/verify', async (req, res) => {
    try {
      const result = await DomainManager.verifyDomain(req.params.domain);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/domains/:domain', (req, res) => {
    const deleted = DomainManager.deleteDomain(req.params.domain);
    res.json({ success: deleted });
  });

  // 7. INBOUND MAIL (INBOX & READING)
  const InboundReceiver = require('./inbound-receiver');

  app.get('/api/inbox', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);
    const { to, from, query } = req.query;
    res.json(InboundReceiver.getInbox({ limit, offset, to, from, query }));
  });

  app.get('/api/inbox/:id', (req, res) => {
    const email = InboundReceiver.getEmail(req.params.id);
    if (!email) return res.status(404).json({ error: 'Email not found' });
    res.json(email);
  });

  app.delete('/api/inbox/:id', (req, res) => {
    const deleted = InboundReceiver.deleteEmail(req.params.id);
    res.json({ success: deleted });
  });

  app.delete('/api/inbox', (req, res) => {
    InboundReceiver.clearInbox();
    res.json({ success: true, message: 'Inbox cleared' });
  });

  // 8. INBOUND WEBHOOK CALLBACK
  app.get('/api/webhook', (req, res) => {
    const configPath = path.join(__dirname, '..', 'config', 'server.json');
    let webhookUrl = null;
    if (fs.existsSync(configPath)) {
      try {
        webhookUrl = JSON.parse(fs.readFileSync(configPath, 'utf8')).webhookUrl || null;
      } catch (e) {}
    }
    res.json({
      webhookUrl: webhookUrl || process.env.WEBHOOK_URL || (inboundReceiver ? inboundReceiver.webhookUrl : null)
    });
  });

  app.post('/api/webhook', (req, res) => {
    const { webhookUrl } = req.body;
    const configPath = path.join(__dirname, '..', 'config', 'server.json');
    let cfg = {};
    if (fs.existsSync(configPath)) {
      try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) {}
    }
    cfg.webhookUrl = webhookUrl || null;
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');

    if (inboundReceiver) {
      inboundReceiver.webhookUrl = webhookUrl || null;
    }

    res.json({ success: true, webhookUrl: cfg.webhookUrl });
  });

  return app;
}

module.exports = createApiServer;
