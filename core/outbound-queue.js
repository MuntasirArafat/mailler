const fs = require('fs');
const path = require('path');
const DirectMtaSender = require('../src/direct-sender');

/**
 * Haraka-style Outbound Delivery Queue
 * Handles spooling messages to disk, MX resolution, concurrent delivery workers,
 * retries, and delivery lifecycle events.
 */
class OutboundQueue {
  constructor(options = {}) {
    this.queueDir = options.queueDir || path.join(__dirname, '..', 'queue');
    this.incomingDir = path.join(this.queueDir, 'incoming');
    this.activeDir = path.join(this.queueDir, 'active');
    this.retryDir = path.join(this.queueDir, 'retry');
    this.deliveredDir = path.join(this.queueDir, 'delivered');
    this.failedDir = path.join(this.queueDir, 'failed');

    this.maxRetries = options.maxRetries || 5;
    this.retryIntervals = [60, 300, 900, 1800, 3600]; // 1m, 5m, 15m, 30m, 1h in seconds
    this.concurrency = options.concurrency || 5;
    this.activeWorkers = 0;
    this.sender = new DirectMtaSender({ heloHost: options.heloHost || 'mail.localmta.dev' });
    this.isRunning = false;
    this.intervalHandle = null;

    this.initDirs();
  }

  initDirs() {
    [this.queueDir, this.incomingDir, this.activeDir, this.retryDir, this.deliveredDir, this.failedDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  /**
   * Spool a new message transaction into the outbound queue.
   */
  enqueue(transaction) {
    const todoId = `${Date.now()}_${transaction.uuid}`;
    const todoData = {
      uuid: transaction.uuid,
      created_at: transaction.created_at || Date.now(),
      attempts: 0,
      next_attempt: Date.now(),
      mail_from: transaction.mail_from.address,
      rcpt_to: transaction.rcpt_to.map(r => r.address),
      subject: transaction.getSubject(),
      headers: transaction.headers,
      notes: transaction.notes,
      raw_data: transaction.raw_data
    };

    const filePath = path.join(this.incomingDir, `${todoId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(todoData, null, 2), 'utf8');

    // Trigger immediate queue scan
    setImmediate(() => this.processNext());
    return todoId;
  }

  /**
   * Start background delivery queue worker.
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[OutboundQueue] Started Haraka-style outbound queue delivery worker');
    this.intervalHandle = setInterval(() => this.processNext(), 3000);
  }

  stop() {
    this.isRunning = false;
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  /**
   * Process pending items in the queue.
   */
  async processNext() {
    if (!this.isRunning || this.activeWorkers >= this.concurrency) return;

    // 1. Check incoming directory first
    let files = fs.readdirSync(this.incomingDir).filter(f => f.endsWith('.json'));
    let sourceDir = this.incomingDir;

    // 2. If no incoming, check retry directory for items whose next_attempt <= Date.now()
    if (files.length === 0) {
      const retryFiles = fs.readdirSync(this.retryDir).filter(f => f.endsWith('.json'));
      const now = Date.now();
      for (const rf of retryFiles) {
        try {
          const raw = fs.readFileSync(path.join(this.retryDir, rf), 'utf8');
          const data = JSON.parse(raw);
          if (data.next_attempt <= now) {
            files = [rf];
            sourceDir = this.retryDir;
            break;
          }
        } catch (e) {}
      }
    }

    if (files.length === 0) return;

    const fileName = files[0];
    const srcPath = path.join(sourceDir, fileName);
    const activePath = path.join(this.activeDir, fileName);

    try {
      fs.renameSync(srcPath, activePath);
    } catch (e) {
      return; // Already picked up by another worker
    }

    this.activeWorkers++;
    this.deliverJob(activePath, fileName).finally(() => {
      this.activeWorkers--;
      // Look for more work
      setImmediate(() => this.processNext());
    });
  }

  /**
   * Execute delivery for a single spooled job.
   */
  async deliverJob(filePath, fileName) {
    let jobData;
    try {
      jobData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.error(`[OutboundQueue] Corrupt queue file ${fileName}:`, err.message);
      fs.unlinkSync(filePath);
      return;
    }

    jobData.attempts++;
    console.log(`[OutboundQueue] Delivering job ${jobData.uuid} to ${jobData.rcpt_to.join(', ')} (Attempt ${jobData.attempts}/${this.maxRetries})...`);

    const deliveryLogs = [];
    const onLog = (entry) => deliveryLogs.push(entry);

    try {
      const result = await this.sender.sendMail({
        from: jobData.mail_from,
        to: jobData.rcpt_to,
        subject: jobData.subject,
        text: jobData.raw_data,
        dkim: jobData.notes && jobData.notes.dkim_config ? jobData.notes.dkim_config : undefined
      }, onLog);

      if (result.success) {
        // Delivered!
        console.log(`[OutboundQueue] ✔ Job ${jobData.uuid} successfully delivered directly to MX!`);
        jobData.delivered_at = Date.now();
        jobData.delivery_result = result.results;
        jobData.logs = deliveryLogs;

        const destPath = path.join(this.deliveredDir, fileName);
        fs.writeFileSync(destPath, JSON.stringify(jobData, null, 2), 'utf8');
        fs.unlinkSync(filePath);
      } else {
        // Temporary failure, schedule retry
        throw new Error(result.results.map(r => r.error).join('; ') || 'Delivery rejected by MX');
      }
    } catch (err) {
      console.warn(`[OutboundQueue] Delivery failed for ${jobData.uuid}: ${err.message}`);
      jobData.last_error = err.message;
      jobData.logs = deliveryLogs;

      if (jobData.attempts < this.maxRetries) {
        // Exponential backoff
        const delaySec = this.retryIntervals[Math.min(jobData.attempts - 1, this.retryIntervals.length - 1)];
        jobData.next_attempt = Date.now() + (delaySec * 1000);
        console.log(`[OutboundQueue] Scheduling retry #${jobData.attempts + 1} for ${jobData.uuid} in ${delaySec}s`);

        const retryPath = path.join(this.retryDir, fileName);
        fs.writeFileSync(retryPath, JSON.stringify(jobData, null, 2), 'utf8');
        fs.unlinkSync(filePath);
      } else {
        // Permanent failure
        console.error(`[OutboundQueue] ✖ Job ${jobData.uuid} exceeded max retries. Moving to failed queue.`);
        jobData.failed_at = Date.now();
        const failedPath = path.join(this.failedDir, fileName);
        fs.writeFileSync(failedPath, JSON.stringify(jobData, null, 2), 'utf8');
        fs.unlinkSync(filePath);
      }
    }
  }

  /**
   * Get queue statistics for dashboard.
   */
  getStats() {
    const countFiles = (dir) => {
      try {
        return fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
      } catch (e) {
        return 0;
      }
    };

    return {
      incoming: countFiles(this.incomingDir),
      active: this.activeWorkers,
      retry: countFiles(this.retryDir),
      delivered: countFiles(this.deliveredDir),
      failed: countFiles(this.failedDir)
    };
  }

  /**
   * List recent messages from delivered / failed queues.
   */
  getRecentDelivered(limit = 20) {
    const list = [];
    try {
      const files = fs.readdirSync(this.deliveredDir).filter(f => f.endsWith('.json')).reverse().slice(0, limit);
      for (const f of files) {
        const data = JSON.parse(fs.readFileSync(path.join(this.deliveredDir, f), 'utf8'));
        list.push(data);
      }
    } catch (e) {}
    return list;
  }
}

module.exports = OutboundQueue;
