const crypto = require('crypto');
const db = require('./db');
const DirectMta = require('./direct-mta');
const SpamShield = require('./spam-shield');
const rateLimiter = require('./rate-limiter');
const SuppressionManager = require('./suppression');

class JobQueue {
  constructor(options = {}) {
    this.concurrency = options.concurrency || 20;
    this.activeWorkers = 0;
    this.isRunning = false;
    this.pollIntervalMs = 500;
    this.retryDelays = [60000, 300000, 900000, 1800000, 3600000]; // 1m, 5m, 15m, 30m, 1h
    this.mta = new DirectMta({ heloHost: options.heloHost });

    // Prepared statements for high performance
    this.stmtInsert = db.prepare(`
      INSERT INTO outbound_jobs (
        job_id, status, from_email, to_email, recipient_domain, subject,
        text_body, html_body, attachments_json, headers_json, next_attempt_at,
        created_at, updated_at
      ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtFetchBatch = db.prepare(`
      SELECT * FROM outbound_jobs
      WHERE status IN ('pending', 'retrying') AND next_attempt_at <= ?
      ORDER BY id ASC LIMIT ?
    `);

    this.stmtSetProcessing = db.prepare(`
      UPDATE outbound_jobs SET status = 'processing', updated_at = ?
      WHERE id = ? AND status IN ('pending', 'retrying')
    `);

    this.stmtSetCompleted = db.prepare(`
      UPDATE outbound_jobs SET
        status = 'completed',
        delivery_response = ?,
        updated_at = ?
      WHERE id = ?
    `);

    this.stmtSetRetry = db.prepare(`
      UPDATE outbound_jobs SET
        status = 'retrying',
        attempts = attempts + 1,
        next_attempt_at = ?,
        last_error = ?,
        updated_at = ?
      WHERE id = ?
    `);

    this.stmtSetFailed = db.prepare(`
      UPDATE outbound_jobs SET
        status = 'failed',
        attempts = attempts + 1,
        last_error = ?,
        updated_at = ?
      WHERE id = ?
    `);
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      db.prepare("UPDATE outbound_jobs SET status = 'pending' WHERE status = 'processing'").run();
    } catch (e) {}
    this.loop();
  }

  stop() {
    this.isRunning = false;
  }

  /**
   * Enqueue a single email job.
   */
  enqueue(job) {
    const jobId = crypto.randomUUID();
    const domain = job.to.split('@')[1].toLowerCase().trim();
    const now = Date.now();

    this.stmtInsert.run(
      jobId,
      job.from.trim(),
      job.to.trim(),
      domain,
      job.subject || '',
      job.text || '',
      job.html || '',
      job.attachments ? JSON.stringify(job.attachments) : null,
      job.headers ? JSON.stringify(job.headers) : null,
      now,
      now,
      now
    );

    return { jobId, status: 'pending' };
  }

  /**
   * High-throughput batch ingestion for thousands of jobs in a single atomic transaction.
   */
  enqueueBatch(jobsList) {
    const now = Date.now();
    const results = [];

    db.exec('BEGIN TRANSACTION;');
    try {
      for (const job of jobsList) {
        if (!job.from || !job.to) continue;
        const jobId = crypto.randomUUID();
        const domain = job.to.split('@')[1].toLowerCase().trim();

        this.stmtInsert.run(
          jobId,
          job.from.trim(),
          job.to.trim(),
          domain,
          job.subject || '',
          job.text || '',
          job.html || '',
          job.attachments ? JSON.stringify(job.attachments) : null,
          job.headers ? JSON.stringify(job.headers) : null,
          now,
          now,
          now
        );

        results.push({ jobId, to: job.to });
      }
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    return { enqueued: results.length, jobs: results };
  }

  /**
   * Background worker loop with Rate-Limiting and IP Warm-up Protection.
   */
  async loop() {
    while (this.isRunning) {
      if (this.activeWorkers >= this.concurrency) {
        await new Promise(r => setTimeout(r, 100));
        continue;
      }

      const availableSlots = this.concurrency - this.activeWorkers;
      const candidates = this.stmtFetchBatch.all(Date.now(), availableSlots * 2);

      if (candidates.length === 0) {
        await new Promise(r => setTimeout(r, this.pollIntervalMs));
        continue;
      }

      let launched = 0;
      for (const job of candidates) {
        if (this.activeWorkers >= this.concurrency) break;

        const domain = job.recipient_domain;

        // 1. Per-Domain Concurrency Rate Limiter (prevents 421 drop on single destination)
        if (!rateLimiter.canSend(domain)) {
          continue; // Currently maxed out for this domain, skip
        }

        // 3. Lock row in DB
        const now = Date.now();
        const res = this.stmtSetProcessing.run(now, job.id);
        if (res.changes === 0) continue; // Concurrently claimed

        rateLimiter.acquire(domain);
        this.activeWorkers++;
        launched++;

        this.processJob(job).finally(() => {
          rateLimiter.release(domain);
          this.activeWorkers--;
        });
      }

      if (launched === 0) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
  }

  /**
   * Execute delivery for a single job with SpamShield, Suppression checks & Direct MTA.
   */
  async processJob(job) {
    const now = Date.now();
    try {
      // 1. Suppression check (protect reputation from known bounces / unsubscribes)
      if (SuppressionManager.isSuppressed(job.to_email)) {
        this.stmtSetCompleted.run('Skipped: Recipient is in suppression list', now, job.id);
        return;
      }

      const attachments = job.attachments_json ? JSON.parse(job.attachments_json) : null;
      const headers = job.headers_json ? JSON.parse(job.headers_json) : null;

      // 2. Prepare Anti-Spam Headers & DKIM Signing
      const prepared = await SpamShield.prepareAntiSpamMessage({
        from: job.from_email,
        to: job.to_email,
        subject: job.subject,
        text: job.text_body,
        html: job.html_body,
        attachments,
        headers
      });

      // 3. Deliver directly to MX on port 25
      const delivery = await this.mta.deliver(job.from_email, job.to_email, prepared.buffer);

      // 4. Mark completed
      this.stmtSetCompleted.run(delivery.response, Date.now(), job.id);
    } catch (err) {
      const errorMsg = err.message || 'Unknown MTA delivery error';

      // Check if permanent 550 bounce -> auto add to suppression list
      if (/550|551|552|553|554|user unknown|mailbox not found|does not exist/i.test(errorMsg)) {
        SuppressionManager.add(job.to_email, 'bounce', errorMsg);
        this.stmtSetFailed.run(`Permanent bounce: ${errorMsg}`, now, job.id);
        return;
      }

      if (job.attempts + 1 < job.max_attempts) {
        // Schedule exponential backoff retry
        const delay = this.retryDelays[Math.min(job.attempts, this.retryDelays.length - 1)];
        const nextAttempt = now + delay;
        this.stmtSetRetry.run(nextAttempt, errorMsg, now, job.id);
      } else {
        // Permanent failure after max attempts
        this.stmtSetFailed.run(errorMsg, now, job.id);
      }
    }
  }

  /**
   * Get queue statistics.
   */
  getStats() {
    const rows = db.prepare(`
      SELECT status, COUNT(*) as count FROM outbound_jobs GROUP BY status
    `).all();

    const stats = {
      pending: 0,
      processing: 0,
      completed: 0,
      retrying: 0,
      failed: 0,
      total: 0
    };

    for (const r of rows) {
      stats[r.status] = r.count;
      stats.total += r.count;
    }

    stats.activeWorkers = this.activeWorkers;
    return stats;
  }

  getJob(jobId) {
    return db.prepare('SELECT * FROM outbound_jobs WHERE job_id = ?').get(jobId) || null;
  }

  getRecentJobs(limit = 50, offset = 0, status = null) {
    if (status) {
      return db.prepare('SELECT * FROM outbound_jobs WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(status, limit, offset);
    }
    return db.prepare('SELECT * FROM outbound_jobs ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
  }

  retryFailed() {
    const res = db.prepare("UPDATE outbound_jobs SET status = 'pending', next_attempt_at = ? WHERE status = 'failed'").run(Date.now());
    return res.changes;
  }
}

module.exports = JobQueue;
