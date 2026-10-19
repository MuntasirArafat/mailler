const express = require('express');
const path = require('path');
const os = require('os');
const multer = require('multer');
const DirectMtaSender = require('./direct-sender');
const dkimManager = require('./dkim-manager');
const DnsChecker = require('./dns-checker');
const historyStore = require('./history-store');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB limit
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Default MTA sender instance
const defaultSender = new DirectMtaSender();

// System Status & Port 25 Diagnostic
app.get('/api/system-status', async (req, res) => {
  try {
    const publicIp = await DnsChecker.getPublicIp();
    const port25Check = await DnsChecker.testPort25('gmail-smtp-in.l.google.com', 25, 4000);
    const dkimKeys = dkimManager.listKeys();

    const inboundServer = req.app.locals.inboundServer;
    const queueStats = inboundServer ? inboundServer.outboundQueue.getStats() : { incoming: 0, active: 0, retry: 0, delivered: 0, failed: 0 };

    res.json({
      hostname: os.hostname(),
      publicIp: publicIp || 'Unknown',
      port25: port25Check,
      smtpRelayPort: process.env.SMTP_RELAY_PORT || 2525,
      dkimKeysCount: dkimKeys.length,
      platform: os.platform(),
      engine: 'Haraka-Style Event-Driven MTA',
      queue: queueStats
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Haraka Plugins status & Hook inspector
app.get('/api/plugins', (req, res) => {
  const inboundServer = req.app.locals.inboundServer;
  if (!inboundServer) return res.json({ plugins: [], hooks: {} });

  const pm = inboundServer.pluginManager;
  const hookSummary = {};
  for (const [hookName, handlers] of Object.entries(pm.hooks)) {
    hookSummary[hookName] = handlers.map(h => ({ plugin: h.pluginName, priority: h.priority }));
  }

  res.json({
    plugins: pm.plugins.map(p => p.name),
    hooks: hookSummary
  });
});

// Haraka Outbound Queue Stats
app.get('/api/queue/stats', (req, res) => {
  const inboundServer = req.app.locals.inboundServer;
  if (!inboundServer) return res.json({ incoming: 0, active: 0, retry: 0, delivered: 0, failed: 0 });
  res.json(inboundServer.outboundQueue.getStats());
});

// Test port 25 connectivity on arbitrary host
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

// DNS Diagnostics for domain
app.get('/api/dns-check/:domain', async (req, res) => {
  try {
    const selector = req.query.selector || 'default';
    const result = await DnsChecker.checkDomain(req.params.domain, selector);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DKIM Management
app.get('/api/dkim', (req, res) => {
  res.json(dkimManager.listKeys());
});

app.post('/api/dkim/generate', (req, res) => {
  try {
    const domain = (req.body.domain || '').trim();
    const selector = (req.body.selector || 'default').trim();
    if (!domain) {
      return res.status(400).json({ error: 'Domain name is required' });
    }

    const key = dkimManager.generateKey(domain, selector);
    res.json({
      success: true,
      key: {
        domain: key.domain,
        selector: key.selector,
        recordName: key.recordName,
        txtValue: key.txtValue,
        createdAt: key.createdAt
      },
      dnsInstructions: {
        dkim: {
          type: 'TXT',
          host: key.recordName,
          value: key.txtValue
        },
        spfRecommendation: {
          type: 'TXT',
          host: key.domain,
          value: 'v=spf1 a mx ~all'
        },
        dmarcRecommendation: {
          type: 'TXT',
          host: `_dmarc.${key.domain}`,
          value: `v=DMARC1; p=none; sp=none; rua=mailto:postmaster@${key.domain}`
        }
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/dkim/:domain/:selector', (req, res) => {
  const deleted = dkimManager.deleteKey(req.params.domain, req.params.selector);
  res.json({ success: deleted });
});

// Send Mail directly
app.post('/api/send', upload.array('attachments', 10), async (req, res) => {
  const logs = [];
  const onLog = (entry) => {
    logs.push(entry);
  };

  try {
    const { from, to, subject, text, html, heloHost, useDkim } = req.body;

    if (!from || !to) {
      return res.status(400).json({ error: 'Both "from" and "to" fields are required.' });
    }

    // Process attachments if any
    const attachments = (req.files || []).map(file => ({
      filename: file.originalname,
      content: file.buffer,
      contentType: file.mimetype
    }));

    // Check DKIM configuration
    let dkimConfig = null;
    if (useDkim !== 'false' && useDkim !== false) {
      const parsed = DirectMtaSender.parseEmail(from);
      if (parsed.domain) {
        const storedKey = dkimManager.getKey(parsed.domain);
        if (storedKey) {
          dkimConfig = {
            domainName: storedKey.domain,
            keySelector: storedKey.selector,
            privateKey: storedKey.privateKey
          };
          logs.push({
            timestamp: new Date().toISOString(),
            level: 'info',
            message: `Using DKIM key for ${storedKey.domain} (selector: ${storedKey.selector})`
          });
        }
      }
    }

    const result = await defaultSender.sendMail({
      from,
      to,
      subject: subject || '(No Subject)',
      text: text || '',
      html: html || (text ? `<p>${text.replace(/\n/g, '<br>')}</p>` : ''),
      attachments,
      heloHost: heloHost || undefined,
      dkim: dkimConfig
    }, onLog);

    const record = historyStore.addRecord({
      source: 'Web API / Dashboard',
      from,
      to,
      subject: subject || '(No Subject)',
      success: result.success,
      results: result.results,
      logs
    });

    res.json({
      success: result.success,
      id: record.id,
      results: result.results,
      logs
    });
  } catch (err) {
    logs.push({
      timestamp: new Date().toISOString(),
      level: 'error',
      message: `Fatal send error: ${err.message}`
    });

    historyStore.addRecord({
      source: 'Web API / Dashboard',
      from: req.body.from || 'unknown',
      to: req.body.to || 'unknown',
      subject: req.body.subject || '(No Subject)',
      success: false,
      error: err.message,
      logs
    });

    res.status(500).json({
      success: false,
      error: err.message,
      logs
    });
  }
});

// Delivery History API
app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit || '50', 10);
  res.json(historyStore.getRecent(limit));
});

app.get('/api/history/:id', (req, res) => {
  const record = historyStore.getById(req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });
  res.json(record);
});

app.delete('/api/history', (req, res) => {
  historyStore.clear();
  res.json({ success: true });
});

module.exports = app;
