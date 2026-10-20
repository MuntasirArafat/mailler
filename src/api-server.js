const fs = require('fs');
const path = require('path');
const express = require('express');
const SpamShield = require('./spam-shield');
const DeliverabilityAuditor = require('./deliverability-auditor');
const DnsChecker = require('./dns-checker');
const dkimManager = require('./dkim-manager');
const DomainManager = require('./domain-manager');
const InboundReceiver = require('./inbound-receiver');
const SuppressionManager = require('./suppression');
const db = require('./db');

function createApiServer(mta, jobQueue, inboundReceiver, options = {}) {
  // Support flexible argument patterns
  let opts = options;
  if (!inboundReceiver && jobQueue && !jobQueue.enqueue) {
    opts = jobQueue;
    jobQueue = null;
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
  app.get('/api/health', async (req, res) => {
    let queueStats = null;
    if (jobQueue) {
      try {
        queueStats = await jobQueue.getStats();
      } catch (e) {}
    }

    res.json({
      status: 'healthy',
      database: db.isConnected() ? 'connected' : 'disconnected',
      role: 'production-mta-worker',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      heloHost: mta.heloHost || null,
      authRequired: !!apiPassword,
      queue: queueStats
    });
  });

  // 1. OUTBOUND: SINGLE EMAIL SEND (Queued by default, or immediate with ?sync=true)
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
        dkim,
        sync
      } = req.body;

      if (!from || !to) {
        return res.status(400).json({ error: 'Both "from" and "to" email addresses are required.' });
      }

      // Check if synchronous send requested
      const isSync = req.query.sync === 'true' || sync === true || !jobQueue;

      if (isSync) {
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
          mode: 'synchronous',
          messageId: prepared.messageId,
          dkimSigned: prepared.dkimSigned,
          recipient: to,
          durationMs,
          response: delivery.response,
          host: delivery.host,
          tls: delivery.tls
        });
      }

      // Default: Enqueue into MongoDB Job Queue
      const queueResult = await jobQueue.enqueue(req.body);
      return res.status(202).json({
        success: true,
        mode: 'queued',
        jobId: queueResult.jobId,
        status: queueResult.status,
        recipient: to
      });
    } catch (err) {
      console.error('[API Send Error]:', err.message);
      return res.status(500).json({
        success: false,
        error: err.message || 'Delivery error'
      });
    }
  });

  // 2. OUTBOUND: BATCH EMAIL SEND
  app.post('/api/send-batch', async (req, res) => {
    try {
      const { emails, sync } = req.body;
      if (!Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ error: 'Body must contain non-empty "emails" array.' });
      }

      const isSync = req.query.sync === 'true' || sync === true || !jobQueue;

      if (isSync) {
        const concurrency = Math.min(parseInt(req.body.concurrency || '10', 10), 50);
        const results = [];
        let sent = 0;
        let failed = 0;

        for (let i = 0; i < emails.length; i += concurrency) {
          const chunk = emails.slice(i, i + concurrency);
          const chunkResults = await Promise.all(
            chunk.map(async email => {
              try {
                const prepared = await SpamShield.prepareAntiSpamMessage(email);
                const delivery = await mta.deliver(email.from, email.to, prepared.buffer);
                sent++;
                return {
                  to: email.to,
                  success: true,
                  messageId: prepared.messageId,
                  dkimSigned: prepared.dkimSigned,
                  host: delivery.host,
                  response: delivery.response
                };
              } catch (err) {
                failed++;
                return {
                  to: email.to,
                  success: false,
                  error: err.message
                };
              }
            })
          );
          results.push(...chunkResults);
        }

        return res.json({
          success: true,
          mode: 'synchronous',
          total: emails.length,
          sent,
          failed,
          results
        });
      }

      // Default: Bulk enqueue into MongoDB Job Queue
      const batchResult = await jobQueue.enqueueBatch(emails, req.body);
      return res.status(202).json({
        success: true,
        mode: 'queued',
        total: batchResult.queued,
        jobIds: batchResult.jobIds
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 3. JOB QUEUE MANAGEMENT (MongoDB Backed)
  app.post('/api/jobs', async (req, res) => {
    try {
      if (!jobQueue) {
        return res.status(503).json({ error: 'JobQueue is not initialized.' });
      }

      if (Array.isArray(req.body.emails)) {
        const result = await jobQueue.enqueueBatch(req.body.emails, req.body);
        return res.status(201).json(result);
      }

      if (!req.body.to || !req.body.from) {
        return res.status(400).json({ error: 'Both "from" and "to" email addresses are required.' });
      }

      const result = await jobQueue.enqueue(req.body);
      return res.status(201).json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/jobs', async (req, res) => {
    try {
      if (!jobQueue) {
        return res.status(503).json({ error: 'JobQueue is not initialized.' });
      }

      const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
      const offset = parseInt(req.query.offset || '0', 10);
      const { status, recipient, search } = req.query;

      const data = await jobQueue.getJobs({ status, recipient, limit, offset, search });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/jobs/stats', async (req, res) => {
    try {
      if (!jobQueue) {
        return res.status(503).json({ error: 'JobQueue is not initialized.' });
      }

      const stats = await jobQueue.getStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/jobs/:id', async (req, res) => {
    try {
      if (!jobQueue) {
        return res.status(503).json({ error: 'JobQueue is not initialized.' });
      }

      const job = await jobQueue.getJobById(req.params.id);
      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }
      res.json(job);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/jobs/:id/retry', async (req, res) => {
    try {
      if (!jobQueue) {
        return res.status(503).json({ error: 'JobQueue is not initialized.' });
      }

      const success = await jobQueue.retryJob(req.params.id);
      if (!success) {
        return res.status(404).json({ error: 'Job not found or not in failed/completed state' });
      }
      res.json({ success: true, message: `Job ${req.params.id} has been re-queued for delivery.` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/jobs/retry-all', async (req, res) => {
    try {
      if (!jobQueue) {
        return res.status(503).json({ error: 'JobQueue is not initialized.' });
      }

      const reQueued = await jobQueue.retryAllFailed();
      res.json({ success: true, reQueued });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/jobs/:id', async (req, res) => {
    try {
      if (!jobQueue) {
        return res.status(503).json({ error: 'JobQueue is not initialized.' });
      }

      const deleted = await jobQueue.deleteJob(req.params.id);
      res.json({ success: deleted });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 4. NETWORK DIAGNOSTICS: TEST PORT 25
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

  // 5. DKIM MANAGEMENT
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

  // 7. DOMAIN MANAGEMENT
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

  app.get('/api/domains/:domain', async (req, res) => {
    try {
      const domain = await DomainManager.getDomain(req.params.domain);
      if (!domain) return res.status(404).json({ error: 'Domain not found' });
      res.json(domain);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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

  // 8. INBOUND MAIL (MONGODB BACKED INBOX)
  app.get('/api/inbox', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
      const offset = parseInt(req.query.offset || '0', 10);
      const { to, from, query } = req.query;
      const data = await InboundReceiver.getInbox({ limit, offset, to, from, query });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/inbox/:id', async (req, res) => {
    try {
      const email = await InboundReceiver.getEmail(req.params.id);
      if (!email) return res.status(404).json({ error: 'Email not found' });
      res.json(email);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/inbox/:id', async (req, res) => {
    try {
      const deleted = await InboundReceiver.deleteEmail(req.params.id);
      res.json({ success: deleted });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/inbox', async (req, res) => {
    try {
      const count = await InboundReceiver.clearInbox();
      res.json({ success: true, deletedCount: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 9. SUPPRESSION LIST
  app.get('/api/suppression', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
      const offset = parseInt(req.query.offset || '0', 10);
      const items = SuppressionManager.list({ limit, offset, reason: req.query.reason });
      const total = SuppressionManager.count();
      res.json({ total, limit, offset, items });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/suppression', (req, res) => {
    try {
      const { email, reason, details } = req.body;
      if (!email) return res.status(400).json({ error: 'Missing email' });
      const item = SuppressionManager.add(email, reason, details);
      res.status(201).json(item);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/suppression/:email', (req, res) => {
    try {
      const success = SuppressionManager.remove(req.params.email);
      res.json({ success });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

module.exports = createApiServer;
