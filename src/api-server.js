const path = require('path');
const express = require('express');
const SpamShield = require('./spam-shield');
const InboundReceiver = require('./inbound-receiver');
const DeliverabilityAuditor = require('./deliverability-auditor');

function createApiServer(jobQueue, inboundReceiver, options = {}) {
  const app = express();
  const apiPassword = options.apiPassword || process.env.API_PASSWORD || process.env.API_KEY || null;

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
      authRequired: !!apiPassword,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      queue: jobQueue.getStats()
    });
  });

  // 1. OUTBOUND: SINGLE SEND
  app.post('/api/send', async (req, res) => {
    try {
      const { from, to, subject, text, html, unsubscribeUrl, unsubscribeEmail, sync, headers } = req.body;
      if (!from || !to) {
        return res.status(400).json({ error: 'Both "from" and "to" email addresses are required.' });
      }

      if (sync) {
        // Direct synchronous delivery without queueing
        const prepared = await SpamShield.prepareAntiSpamMessage({
          from, to, subject, text, html, unsubscribeUrl, unsubscribeEmail, headers
        });
        const delivery = await jobQueue.mta.deliver(from, to, prepared.buffer);
        return res.json({
          success: true,
          sync: true,
          messageId: prepared.messageId,
          dkimSigned: prepared.dkimSigned,
          response: delivery.response
        });
      }

      // Enqueue into high-capacity job queue
      const job = jobQueue.enqueue({
        from, to, subject, text, html, unsubscribeUrl, unsubscribeEmail, headers
      });

      res.status(202).json({
        success: true,
        queued: true,
        jobId: job.jobId
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 2. OUTBOUND: HIGH-THROUGHPUT BULK BATCH ENQUEUE (Handles thousands/millions)
  app.post('/api/jobs/batch', (req, res) => {
    try {
      const emails = req.body.emails;
      if (!Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ error: '"emails" must be a non-empty array of email objects.' });
      }

      const result = jobQueue.enqueueBatch(emails);
      res.status(202).json({
        success: true,
        enqueued: result.enqueued,
        jobs: result.jobs
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 3. JOB QUEUE STATS & INSPECTION
  app.get('/api/jobs/stats', (req, res) => {
    res.json(jobQueue.getStats());
  });

  app.get('/api/jobs', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
    const offset = parseInt(req.query.offset || '0', 10);
    const status = req.query.status || null;

    res.json(jobQueue.getRecentJobs(limit, offset, status));
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = jobQueue.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  });

  app.post('/api/jobs/retry-failed', (req, res) => {
    const count = jobQueue.retryFailed();
    res.json({ success: true, retriedCount: count });
  });

  // 4. INBOUND MAIL (READING EMAILS)
  app.get('/api/inbox', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);
    const { to, from, query } = req.query;

    const emails = InboundReceiver.getInbox({ limit, offset, to, from, query });
    res.json(emails);
  });

  app.get('/api/inbox/:id', (req, res) => {
    const email = InboundReceiver.getEmail(parseInt(req.params.id, 10));
    if (!email) return res.status(404).json({ error: 'Email not found' });
    res.json(email);
  });

  app.delete('/api/inbox/:id', (req, res) => {
    const deleted = InboundReceiver.deleteEmail(parseInt(req.params.id, 10));
    res.json({ success: deleted });
  });

  // 5. ANTI-SPAM & DKIM MANAGEMENT
  app.post('/api/dkim/generate', (req, res) => {
    try {
      const { domain, selector } = req.body;
      if (!domain) return res.status(400).json({ error: 'Domain is required' });

      const dkim = SpamShield.generateDkim(domain, selector || 'default');
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

  app.get('/api/dkim', (req, res) => {
    res.json(SpamShield.listDkim());
  });

  // 6. PRE-FLIGHT DELIVERABILITY & ANTI-SPAM AUDIT
  app.get('/api/deliverability/audit/:domain', async (req, res) => {
    try {
      const selector = req.query.selector || 'default';
      const report = await DeliverabilityAuditor.auditDomain(req.params.domain, selector);
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 7. SUPPRESSION LIST MANAGEMENT
  const SuppressionManager = require('./suppression');
  app.get('/api/suppression', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
    const offset = parseInt(req.query.offset || '0', 10);
    const reason = req.query.reason || null;
    res.json({
      total: SuppressionManager.count(),
      items: SuppressionManager.list({ limit, offset, reason })
    });
  });

  app.post('/api/suppression', (req, res) => {
    try {
      const { email, reason, details } = req.body;
      if (!email) return res.status(400).json({ error: 'Email is required' });
      const item = SuppressionManager.add(email, reason || 'manual', details);
      res.json({ success: true, item });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/suppression/:email', (req, res) => {
    const deleted = SuppressionManager.remove(req.params.email);
    res.json({ success: deleted });
  });


  // 9. DOMAIN MANAGEMENT (ADD, LIST, VERIFY, DELETE)
  const DomainManager = require('./domain-manager');
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

  app.get('/api/domains', (req, res) => {
    res.json(DomainManager.listDomains());
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

  return app;
}

module.exports = createApiServer;
