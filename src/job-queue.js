const crypto = require('crypto');
const { jobsCollection } = require('./db');
const SpamShield = require('./spam-shield');

class JobQueue {
  constructor(mta, options = {}) {
    this.mta = mta;
    this.concurrency = options.concurrency || 10;
    this.pollInterval = options.pollInterval || 3000; // Poll every 3s for scheduled retries
    this.retryIntervals = options.retryIntervals || [60, 300, 900, 1800, 3600]; // 1m, 5m, 15m, 30m, 1h
    this.maxRetries = options.maxRetries || 5;

    this.activeWorkers = 0;
    this.isRunning = false;
    this.pollTimer = null;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[JobQueue] 🚀 Production MongoDB Queue Worker started (concurrency: ${this.concurrency})`);

    // Recover any jobs that were stuck in 'processing' when the server stopped/restarted
    this.recoverStuckJobs().catch(err => {
      console.warn(`[JobQueue] Error recovering stuck jobs: ${err.message}`);
    });

    this.runWorkerLoop();
  }

  stop() {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('[JobQueue] Queue Worker stopped.');
  }

  /**
   * Reset jobs left in 'processing' back to 'queued' on startup
   */
  async recoverStuckJobs() {
    try {
      const col = jobsCollection();
      const res = await col.updateMany(
        { status: 'processing' },
        {
          $set: {
            status: 'queued',
            updatedAt: new Date()
          }
        }
      );
      if (res.modifiedCount > 0) {
        console.log(`[JobQueue] 🔄 Recovered ${res.modifiedCount} stuck job(s) back to queued.`);
      }
    } catch (e) {}
  }

  /**
   * Enqueue a single mail job
   */
  async enqueue(mailData) {
    const col = jobsCollection();
    const jobId = mailData.jobId || 'job_' + crypto.randomBytes(12).toString('hex');
    const recipient = mailData.to;

    const jobDoc = {
      jobId,
      recipient,
      status: 'queued',
      attempts: 0,
      maxRetries: mailData.maxRetries !== undefined ? mailData.maxRetries : this.maxRetries,
      priority: mailData.priority || 0,
      nextRetryAt: new Date(),
      payload: {
        from: mailData.from,
        to: mailData.to,
        name: mailData.name || mailData.fromName,
        subject: mailData.subject,
        text: mailData.text,
        html: mailData.html,
        unsubscribeUrl: mailData.unsubscribeUrl,
        unsubscribeEmail: mailData.unsubscribeEmail,
        headers: mailData.headers,
        dkim: mailData.dkim
      },
      lastAttemptAt: null,
      lastError: null,
      errorHistory: [],
      response: null,
      messageId: null,
      host: null,
      durationMs: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      failedAt: null
    };

    await col.insertOne(jobDoc);
    console.log(`[JobQueue] 📥 Enqueued job ${jobId} to ${recipient} (subject: "${jobDoc.payload.subject}")`);

    // Wake up worker immediately
    this.triggerWorkers();

    return {
      success: true,
      jobId,
      status: 'queued',
      recipient
    };
  }

  /**
   * Enqueue multiple mail jobs in bulk
   */
  async enqueueBatch(emails, options = {}) {
    if (!Array.isArray(emails) || emails.length === 0) {
      throw new Error('Emails array must not be empty');
    }

    const col = jobsCollection();
    const now = new Date();
    const docs = [];

    for (const email of emails) {
      const jobId = email.jobId || 'job_' + crypto.randomBytes(12).toString('hex');
      docs.push({
        jobId,
        recipient: email.to,
        status: 'queued',
        attempts: 0,
        maxRetries: email.maxRetries !== undefined ? email.maxRetries : this.maxRetries,
        priority: email.priority || options.priority || 0,
        nextRetryAt: now,
        payload: {
          from: email.from,
          to: email.to,
          name: email.name || email.fromName,
          subject: email.subject,
          text: email.text,
          html: email.html,
          unsubscribeUrl: email.unsubscribeUrl,
          unsubscribeEmail: email.unsubscribeEmail,
          headers: email.headers,
          dkim: email.dkim
        },
        lastAttemptAt: null,
        lastError: null,
        errorHistory: [],
        response: null,
        messageId: null,
        host: null,
        durationMs: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        failedAt: null
      });
    }

    const result = await col.insertMany(docs);
    console.log(`[JobQueue] 📥 Batch enqueued ${docs.length} jobs.`);

    this.triggerWorkers();

    return {
      success: true,
      queued: docs.length,
      jobIds: docs.map(d => d.jobId)
    };
  }

  /**
   * Trigger available worker slots up to concurrency
   */
  triggerWorkers() {
    if (!this.isRunning) return;
    while (this.activeWorkers < this.concurrency) {
      this.activeWorkers++;
      this.processNextJob().finally(() => {
        this.activeWorkers--;
      });
    }
  }

  /**
   * Continuous loop checking for eligible jobs
   */
  async runWorkerLoop() {
    if (!this.isRunning) return;

    try {
      this.triggerWorkers();
    } catch (err) {
      console.error(`[JobQueue] Worker loop error:`, err);
    } finally {
      if (this.isRunning) {
        this.pollTimer = setTimeout(() => this.runWorkerLoop(), this.pollInterval);
      }
    }
  }

  /**
   * Atomic checkout and execution of the next available job
   */
  async processNextJob() {
    const col = jobsCollection();
    const now = new Date();

    let job = null;
    try {
      // Atomic find and update: lock job from 'queued' -> 'processing'
      job = await col.findOneAndUpdate(
        {
          status: 'queued',
          nextRetryAt: { $lte: now }
        },
        {
          $set: {
            status: 'processing',
            lastAttemptAt: now,
            updatedAt: now
          },
          $inc: { attempts: 1 }
        },
        {
          sort: { priority: -1, nextRetryAt: 1, createdAt: 1 },
          returnDocument: 'after'
        }
      );
    } catch (e) {
      return;
    }

    if (!job) {
      return; // No jobs ready right now
    }

    const startTime = Date.now();
    const currentAttempt = job.attempts;
    console.log(`[JobQueue] ⚡ Processing job ${job.jobId} (Attempt ${currentAttempt}/${job.maxRetries}) to ${job.recipient}`);

    try {
      const payload = job.payload || {};
      const senderName = payload.name || payload.fromName || null;
      let formattedFrom = (payload.from || '').trim();
      if (senderName && !formattedFrom.includes('<')) {
        formattedFrom = `"${senderName}" <${formattedFrom}>`;
      }

      // 1. Prepare MIME with DKIM signature, semantic HTML, and plain-text fallback
      const prepared = await SpamShield.prepareAntiSpamMessage({
        ...payload,
        from: formattedFrom,
        fromName: senderName
      });

      // 2. Deliver directly to MX host on Port 25
      const sendResult = await this.mta.deliver(formattedFrom, payload.to, prepared.buffer);
      const durationMs = Date.now() - startTime;

      // 3. Mark Job Completed
      await col.updateOne(
        { jobId: job.jobId },
        {
          $set: {
            status: 'completed',
            response: sendResult.response,
            messageId: prepared.messageId,
            host: sendResult.host,
            durationMs,
            completedAt: new Date(),
            updatedAt: new Date()
          }
        }
      );

      console.log(`[JobQueue] ✔ Job ${job.jobId} COMPLETED in ${durationMs}ms -> ${job.recipient} (MX: ${sendResult.host})`);

      // Immediately look for next job
      if (this.isRunning) {
        setImmediate(() => this.processNextJob());
      }
    } catch (err) {
      await this.handleJobFailure(job, err);

      // Check next job
      if (this.isRunning) {
        setImmediate(() => this.processNextJob());
      }
    }
  }

  /**
   * Robust error classification & retry backoff calculation
   */
  async handleJobFailure(job, err) {
    const col = jobsCollection();
    const errorMessage = err.message || 'Unknown delivery failure';
    const errorString = String(err.response || err.message || '');

    // Classify: Is it a hard bounce (5xx permanent error) or temporary (4xx, timeout, greylisting)?
    const isHardBounce = /5\d\d\s|User unknown|Recipient address rejected|does not exist|mailbox not found|Relay access denied/i.test(errorString);
    const attempts = job.attempts;
    const maxRetries = job.maxRetries || this.maxRetries;

    const errorEntry = {
      attempt: attempts,
      error: errorMessage,
      timestamp: new Date()
    };

    if (isHardBounce || attempts >= maxRetries) {
      // Mark as permanent failure
      const reason = isHardBounce
        ? `Permanent failure (Hard Bounce 5xx): ${errorMessage}`
        : `Exceeded maximum retries (${maxRetries}): ${errorMessage}`;

      await col.updateOne(
        { jobId: job.jobId },
        {
          $set: {
            status: 'failed',
            lastError: reason,
            failedAt: new Date(),
            updatedAt: new Date()
          },
          $push: {
            errorHistory: errorEntry
          }
        }
      );

      console.warn(`[JobQueue] ✖ Job ${job.jobId} FAILED PERMANENTLY: ${reason}`);
    } else {
      // Soft failure: schedule next retry with exponential backoff
      const intervalIdx = Math.min(attempts - 1, this.retryIntervals.length - 1);
      const delaySeconds = this.retryIntervals[intervalIdx] || 300;
      const nextRetryAt = new Date(Date.now() + delaySeconds * 1000);

      await col.updateOne(
        { jobId: job.jobId },
        {
          $set: {
            status: 'queued',
            nextRetryAt,
            lastError: errorMessage,
            updatedAt: new Date()
          },
          $push: {
            errorHistory: errorEntry
          }
        }
      );

      console.log(`[JobQueue] ⏳ Job ${job.jobId} soft failed (${errorMessage}). Scheduled retry #${attempts + 1} in ${delaySeconds}s (at ${nextRetryAt.toISOString()})`);
    }
  }

  /**
   * Query jobs with pagination and filters
   */
  async getJobs({ status = null, recipient = null, limit = 50, offset = 0, search = null } = {}) {
    const col = jobsCollection();
    const filter = {};

    if (status && status !== 'all') {
      filter.status = status;
    }
    if (recipient) {
      filter.recipient = { $regex: recipient, $options: 'i' };
    }
    if (search) {
      filter.$or = [
        { recipient: { $regex: search, $options: 'i' } },
        { 'payload.subject': { $regex: search, $options: 'i' } },
        { jobId: { $regex: search, $options: 'i' } }
      ];
    }

    const total = await col.countDocuments(filter);
    const jobs = await col
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(Math.min(limit, 200))
      .toArray();

    return {
      total,
      limit,
      offset,
      jobs
    };
  }

  async getJobById(jobId) {
    const col = jobsCollection();
    return await col.findOne({ jobId });
  }

  async retryJob(jobId) {
    const col = jobsCollection();
    const result = await col.updateOne(
      { jobId },
      {
        $set: {
          status: 'queued',
          nextRetryAt: new Date(),
          updatedAt: new Date()
        }
      }
    );

    if (result.matchedCount > 0) {
      this.triggerWorkers();
      return true;
    }
    return false;
  }

  async retryAllFailed() {
    const col = jobsCollection();
    const result = await col.updateMany(
      { status: 'failed' },
      {
        $set: {
          status: 'queued',
          nextRetryAt: new Date(),
          updatedAt: new Date()
        }
      }
    );

    if (result.modifiedCount > 0) {
      this.triggerWorkers();
    }
    return result.modifiedCount;
  }

  async deleteJob(jobId) {
    const col = jobsCollection();
    const result = await col.deleteOne({ jobId });
    return result.deletedCount > 0;
  }

  async getStats() {
    const col = jobsCollection();
    const [queued, processing, completed, failed, total] = await Promise.all([
      col.countDocuments({ status: 'queued' }),
      col.countDocuments({ status: 'processing' }),
      col.countDocuments({ status: 'completed' }),
      col.countDocuments({ status: 'failed' }),
      col.estimatedDocumentCount()
    ]);

    return {
      queued,
      processing,
      completed,
      failed,
      total,
      activeWorkers: this.activeWorkers,
      concurrency: this.concurrency
    };
  }
}

module.exports = JobQueue;
